import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import { makeService, unwrap } from '../helpers/service';
import { makeTempDir, sourceTreeDigest } from '../helpers/fs';
import { writeSyntheticJpeg } from '../helpers/images';
import { fakeLocalInference } from '../helpers/local-inference';
import { LOCAL_PROVIDER } from '../../src/shared/local-analysis';

it('local culling ranks eye signals, reuses cache, retries failure, cancels and never calls cloud', async () => {
  const detect = vi.fn(async (jpeg: Uint8Array, signal: AbortSignal) => {
    if (mode === 'fail') throw new Error('TEST_RUNTIME_FAILURE');
    if (mode === 'wait') await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('CANCELLED')), { once: true }));
    const { width, height } = await sharp(Buffer.from(jpeg)).metadata();
    const { channels } = await sharp(Buffer.from(jpeg)).stats();
    return fakeLocalInference(width!, height!, channels[0]!.mean > channels[2]!.mean + 40);
  });
  let mode: 'good' | 'fail' | 'wait' = 'good';
  const t = makeService(undefined, detect);
  const base = await makeTempDir('local-flow');
  const card = path.join(base, 'card');
  const project = path.join(base, 'project');
  await mkdir(project);
  const cam = { width: 640, height: 427, make: 'TEST', model: 'LOCAL', serial: '1', squareAt: 300 };
  await writeSyntheticJpeg(path.join(card, 'OPEN.JPG'), { ...cam, dateTimeOriginal: '2026:10:01 10:00:00', rgb: [70, 110, 150] });
  await writeSyntheticJpeg(path.join(card, 'CLOSED.JPG'), { ...cam, dateTimeOriginal: '2026:10:01 10:00:01', rgb: [150, 100, 70] });
  const pid = unwrap(await t.service.createProject(project, 'Local')).id;
  await t.waitForJob(unwrap(await t.service.addSources(pid, [card])));
  const before = await sourceTreeDigest(card);
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
  const run = async () => {
    const id = unwrap(await t.service.startAutoCull(pid, null, 'local'));
    const result = await t.waitFor((e) => e.kind === 'autocull' && e.runId === id && ['complete', 'paused', 'failed', 'cancelled'].includes(e.phase));
    await new Promise<void>((resolve) => setImmediate(resolve)); // terminal event precedes run-map cleanup
    return result;
  };
  try {
    // Even with valid-looking cloud configuration, selecting local must never construct an HTTP request.
    unwrap(await t.service.setAiCredentials('https://example.invalid', 'local-test-token-01234567890'));
    expect(await run()).toMatchObject({ phase: 'complete' });
    const assets = unwrap(await t.service.queryAssets(pid, { offset: 0, limit: 20 })).items;
    const open = assets.find((a) => a.primary.relativePath === 'OPEN.JPG')!;
    const closed = assets.find((a) => a.primary.relativePath === 'CLOSED.JPG')!;
    expect(open.analysis!.faces![0]).toMatchObject({ eyes: 'open', confidence: null, brightness: expect.any(Number) });
    expect(closed.cull!.reasons).toContain('EYES_CLOSED');
    expect(open.cull!.selected).toBe(true);
    expect(detect).toHaveBeenCalledTimes(2);
    await run();
    expect(detect).toHaveBeenCalledTimes(2);
    expect(unwrap(await t.service.getCullState(pid)).run!.provider).toBe(LOCAL_PROVIDER);
    const store = t.service.projects.get(pid)!.store;
    store.upsertFaceAnalysis({ ...store.faceAnalysis(open.id)!, status: 'failed', resultJson: null, error: 'OLD' });
    mode = 'fail';
    expect(await run()).toMatchObject({ phase: 'paused' });
    mode = 'good';
    expect(await run()).toMatchObject({ phase: 'complete' });
    store.upsertFaceAnalysis({ ...store.faceAnalysis(open.id)!, status: 'failed', resultJson: null, error: 'OLD' });
    mode = 'wait';
    const started = detect.mock.calls.length;
    const id = unwrap(await t.service.startAutoCull(pid, null, 'local'));
    await vi.waitFor(() => expect(detect.mock.calls.length).toBeGreaterThan(started));
    unwrap(await t.service.cancelJob(id));
    await t.waitFor((e) => e.kind === 'autocull' && e.runId === id && e.phase === 'cancelled');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(store.faceAnalysis(open.id)!.status).toBe('failed'); // cancelled result never saved
    mode = 'good';
    expect(await run()).toMatchObject({ phase: 'complete' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await sourceTreeDigest(card)).toBe(before);
  } finally { fetchSpy.mockRestore(); await t.service.shutdown(); }
});

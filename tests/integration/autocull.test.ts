import { copyFile, mkdir } from 'node:fs/promises';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handle, hashToken, type FaceProvider, type ProviderFace } from '../../backend/src/app';
import { MemoryStore } from '../../backend/tests/memory-store';
import type { AssetView, ProgressEvent } from '../../src/shared/contracts';
import { makeTempDir, sourceTreeDigest } from '../helpers/fs';
import { writeSyntheticJpeg } from '../helpers/images';
import { makeService, unwrap, type TestService } from '../helpers/service';

// Logic check: real backend handler locally; the provider is replaced by one that decides
// "eyes closed" for reddish frames, so outcomes per photo are known in advance.
const TOKEN = 'autocull-token-0123456789abcdef0123456789';
let calls = 0;
let delayMs = 0;
const provider: FaceProvider = {
  async detectFaces(jpeg): Promise<ProviderFace[]> {
    calls++;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const { channels } = await sharp(Buffer.from(jpeg)).stats();
    const reddish = channels[0]!.mean > channels[2]!.mean + 40;
    return [
      {
        boundingBox: { left: 0.3, top: 0.25, width: 0.3, height: 0.45 },
        confidence: 99.9,
        pose: { yaw: 0, pitch: 0, roll: 0 },
        quality: { sharpness: 80, brightness: 60 },
        eyesOpen: { value: !reddish, confidence: 98 },
        smile: { value: reddish, confidence: 95 },
        mouthOpen: { value: false, confidence: 95 },
        sunglasses: { value: false, confidence: 99 },
        eyeglasses: { value: false, confidence: 99 },
        faceOccluded: { value: false, confidence: 99 },
        eyeDirection: null,
        emotions: [{ type: 'CALM', confidence: 80 }],
      },
    ];
  },
};

let server: Server;
let url: string;
let t: TestService;
let projectId: string;
let card: string;

const all = async (): Promise<AssetView[]> => unwrap(await t.service.queryAssets(projectId, { offset: 0, limit: 200 })).items;
const byName = async (n: string) => (await all()).find((a) => a.primary.relativePath.endsWith(n))!;
async function autocull(): Promise<Extract<ProgressEvent, { kind: 'autocull' }>> {
  const runId = unwrap(await t.service.startAutoCull(projectId));
  return (await t.waitFor((e) => e.kind === 'autocull' && e.runId === runId && ['complete', 'paused', 'cancelled', 'failed'].includes(e.phase), 180_000)) as Extract<
    ProgressEvent,
    { kind: 'autocull' }
  >;
}

beforeAll(async () => {
  const store = new MemoryStore();
  store.tokens.set(hashToken(TOKEN), { userId: 'u1', label: 'ac', active: true, userMonthlyLimit: 1000 });
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const r = await handle(
        { method: req.method!, path: req.url!, headers: req.headers as Record<string, string>, body: Buffer.concat(chunks) },
        { store, provider, config: { globalMonthlyLimit: 4000, maxImageBytes: 2.5 * 1024 * 1024, resultTtlHours: 24, now: () => Date.now() } },
      );
      res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const base = await makeTempDir('autocull');
  card = path.join(base, 'card');
  const cam = { width: 640, height: 427, make: 'TEST', model: 'AUTOCULL', serial: '7' };
  // Burst of three, 3 s apart (grouped only by the 4 s event preset): B1 is reddish = eyes closed.
  await writeSyntheticJpeg(path.join(card, 'B0.JPG'), { ...cam, dateTimeOriginal: '2026:10:01 10:00:00', rgb: [70, 110, 150], squareAt: 300 });
  await writeSyntheticJpeg(path.join(card, 'B1.JPG'), { ...cam, dateTimeOriginal: '2026:10:01 10:00:03', rgb: [150, 100, 70], squareAt: 302 });
  await writeSyntheticJpeg(path.join(card, 'B2.JPG'), { ...cam, dateTimeOriginal: '2026:10:01 10:00:06', rgb: [70, 112, 152], squareAt: 304 });
  await writeSyntheticJpeg(path.join(card, 'S.JPG'), { ...cam, dateTimeOriginal: '2026:10:01 11:00:00', rgb: [40, 160, 60] });
  // Exact duplicate in another folder (same bytes): confirmed by full SHA-256, grouped together.
  await mkdir(path.join(card, 'copy'), { recursive: true });
  await copyFile(path.join(card, 'S.JPG'), path.join(card, 'copy', 'S.JPG'));
  const dir = path.join(base, 'project');
  await mkdir(dir);
  t = makeService();
  projectId = unwrap(await t.service.createProject(dir, 'AutoCull')).id;
  await t.waitForJob(unwrap(await t.service.addSources(projectId, [card])));
}, 300_000);

afterAll(async () => {
  await t?.service.shutdown();
  server?.close();
});

describe('AutoCull over the whole album', () => {
  it('without AI settings it still groups and ranks, sending every photo to review as not analysed', async () => {
    const done = await autocull();
    expect(done.phase).toBe('paused');
    expect(done.message).toMatch(/chưa cấu hình/i);
    const state = unwrap(await t.service.getCullState(projectId));
    expect(state.counts.review).toBe(5);
    expect((await byName('B0.JPG')).cull?.reasons).toContain('NOT_ANALYZED');
  });

  it('with AI, picks a shot per group while everything is still unreviewed, and explains it', async () => {
    unwrap(await t.service.setAiCredentials(url, TOKEN));
    const before = await sourceTreeDigest(card);
    const done = await autocull();
    expect(done.phase).toBe('complete');
    expect(calls).toBe(5);
    const b0 = await byName('B0.JPG');
    const b1 = await byName('B1.JPG');
    const b2 = await byName('B2.JPG');
    expect(b0.groupId).toBe(b1.groupId); // 3 s apart: event preset (4 s)
    expect(b1.groupId).toBe(b2.groupId);
    expect([b0, b1, b2].filter((a) => a.cull?.selected)).toHaveLength(1);
    expect(b1.cull).toMatchObject({ selected: false, list: 'better-option', reasons: expect.arrayContaining(['EYES_CLOSED']) });
    expect(b1.cull!.quality!.eyes.state).toBe('known');
    expect((await all()).every((a) => a.decision.state === 'unreviewed')).toBe(true);
    const copies = (await all()).filter((a) => a.primary.relativePath.endsWith('S.JPG'));
    expect(copies[0]!.groupId).toBe(copies[1]!.groupId);
    expect(copies.some((a) => a.cull?.reasons.includes('EXACT_DUPLICATE'))).toBe(true);
    expect(await sourceTreeDigest(card)).toBe(before);
  });

  it('manual choices win, can be several, and resetting restores the automatic pick', async () => {
    const b1 = await byName('B1.JPG');
    const auto = (await all()).find((a) => a.groupId === b1.groupId && a.cull?.selected)!;
    unwrap(await t.service.applyCommand(projectId, { type: 'set-review', assetIds: [b1.id], state: 'keep' }));
    expect((await byName('B1.JPG')).cull).toMatchObject({ selected: true, source: 'manual-keep' });
    expect((await all()).find((a) => a.id === auto.id)!.cull!.selected).toBe(false);
    unwrap(await t.service.applyCommand(projectId, { type: 'set-review', assetIds: [b1.id], state: 'unreviewed' }));
    expect((await all()).find((a) => a.id === auto.id)!.cull!.selected).toBe(true);
  });

  it('a re-run reuses cached analysis and never overwrites manual decisions', async () => {
    const s = await byName('S.JPG');
    unwrap(await t.service.applyCommand(projectId, { type: 'set-rating', assetIds: [s.id], rating: 5 }));
    unwrap(await t.service.applyCommand(projectId, { type: 'set-review', assetIds: [s.id], state: 'pass' }));
    await autocull();
    expect(calls).toBe(5);
    expect((await byName('S.JPG')).decision).toMatchObject({ state: 'pass', rating: 5 });
  });

  it('list filters page through the three result lists', async () => {
    const keep = unwrap(await t.service.queryAssets(projectId, { offset: 0, limit: 200, list: 'keep' }));
    const better = unwrap(await t.service.queryAssets(projectId, { offset: 0, limit: 200, list: 'better-option' }));
    const review = unwrap(await t.service.queryAssets(projectId, { offset: 0, limit: 200, list: 'review' }));
    expect(keep.total + better.total + review.total).toBe(5);
    expect(keep.items.every((a) => a.cull?.list === 'keep')).toBe(true);
  });

  it('cancel stops the run; starting again resumes without paying twice', async () => {
    const extra = path.join(card, 'more');
    for (let i = 0; i < 6; i++) await writeSyntheticJpeg(path.join(extra, `M${i}.JPG`), { width: 640, height: 427, make: 'TEST', model: 'AUTOCULL', serial: '7', dateTimeOriginal: `2026:10:01 12:0${i}:00`, rgb: [30 + i * 20, 90, 200 - i * 20] });
    await t.waitForJob(unwrap(await t.service.addSources(projectId, [card])));
    delayMs = 150;
    const runId = unwrap(await t.service.startAutoCull(projectId));
    await t.waitFor((e) => e.kind === 'analysis' && e.phase === 'progress' && e.done >= 1);
    unwrap(await t.service.cancelJob(runId));
    const cancelled = await t.waitFor((e) => e.kind === 'autocull' && e.runId === runId && ['cancelled', 'complete'].includes(e.phase));
    expect((cancelled as { phase: string }).phase).toBe('cancelled');
    expect(unwrap(await t.service.getCullState(projectId)).run?.status).toBe('cancelled');
    const callsAtCancel = calls;
    expect(callsAtCancel).toBeLessThan(11);
    delayMs = 0;
    const done = await autocull();
    expect(done.phase).toBe('complete');
    expect(calls).toBe(11);
  });

  it('offline: the run pauses with a clear message and the album stays usable', async () => {
    unwrap(await t.service.setAiCredentials('http://127.0.0.1:9', TOKEN));
    await writeSyntheticJpeg(path.join(card, 'more', 'OFFLINE.JPG'), { width: 640, height: 427, make: 'TEST', model: 'AUTOCULL', serial: '7', dateTimeOriginal: '2026:10:01 13:00:00', rgb: [10, 10, 220] });
    await t.waitForJob(unwrap(await t.service.addSources(projectId, [card])));
    const done = await autocull();
    expect(done.phase).toBe('paused');
    expect(done.message).toMatch(/mất kết nối/i);
    const off = await byName('OFFLINE.JPG');
    expect(off.cull?.list).toBe('review');
    expect((await byName('S.JPG')).cull).toBeTruthy();
  });
});

import { copyFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handle, hashToken, type FaceProvider, type ProviderFace } from '../../backend/src/app';
import { MemoryStore } from '../../backend/tests/memory-store';
import { encodeForAnalysis, MAX_PAYLOAD_BYTES } from '../../src/media/analysis-image';
import type { AssetView, PairCandidate } from '../../src/shared/contracts';
import { fixturePath, loadFixtures, requireVerifiedFixtures } from '../helpers/fixtures';
import { makeTempDir, sourceTreeDigest } from '../helpers/fs';
import { makeService, unwrap, type TestService } from '../helpers/service';

// Logic check only: the real backend handler runs locally with an in-memory store; the
// Rekognition call is replaced. This does NOT prove AWS works (see the live test).
const TOKEN = 'local-pilot-token-0123456789abcdef0123456789';
class RecordingProvider implements FaceProvider {
  received: Buffer[] = [];
  async detectFaces(jpeg: Uint8Array): Promise<ProviderFace[]> {
    this.received.push(Buffer.from(jpeg));
    return [
      {
        boundingBox: { left: 0.4, top: 0.2, width: 0.08, height: 0.12 },
        confidence: 99.7,
        pose: { yaw: 2, pitch: 1, roll: 0 },
        quality: { sharpness: 75, brightness: 60 },
        eyesOpen: { value: this.received.length % 2 === 0, confidence: 98 },
        smile: { value: false, confidence: 90 },
        mouthOpen: { value: false, confidence: 90 },
        sunglasses: { value: false, confidence: 99 },
        eyeglasses: { value: false, confidence: 99 },
        faceOccluded: { value: false, confidence: 99 },
        eyeDirection: null,
        emotions: [{ type: 'CALM', confidence: 80 }],
      },
    ];
  }
}

const fx = (id: string) => fixturePath(loadFixtures().find((e) => e.id === id)!);
let server: Server;
let url: string;
let store: MemoryStore;
let provider: RecordingProvider;
let dropNext = false;
let t: TestService;
let projectId: string;
let card: string;

const all = async (): Promise<AssetView[]> => unwrap(await t.service.queryAssets(projectId, { offset: 0, limit: 200 })).items;
async function runAnalysis(ids: string[]) {
  const job = unwrap(await t.service.analyzeFaces(projectId, ids));
  return t.waitFor((e) => e.kind === 'analysis' && e.jobId === job && (e.phase === 'complete' || e.phase === 'stopped'), 120_000);
}

beforeAll(async () => {
  await requireVerifiedFixtures();
  store = new MemoryStore();
  provider = new RecordingProvider();
  store.tokens.set(hashToken(TOKEN), { userId: 'u1', label: 'local', active: true, userMonthlyLimit: 1000 });
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const r = await handle(
        { method: req.method!, path: req.url!, headers: req.headers as Record<string, string>, body: Buffer.concat(chunks) },
        { store, provider, config: { globalMonthlyLimit: 4000, maxImageBytes: MAX_PAYLOAD_BYTES, resultTtlHours: 24, now: () => Date.now() } },
      );
      if (dropNext) {
        dropNext = false;
        req.socket.destroy(); // the call happened, but the response is lost
        return;
      }
      res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const base = await makeTempDir('ai');
  card = path.join(base, 'card');
  await mkdir(card);
  await copyFile(fx('arw-sony-a7c-1'), path.join(card, 'ACH07358.ARW'));
  await copyFile(fx('jpeg-sony-a7c-1'), path.join(card, 'ACH07358.JPG'));
  await copyFile(fx('arw-sony-a7c-portrait'), path.join(card, 'ACH07383.ARW'));
  await copyFile(fx('jpeg-sony-a7c-2'), path.join(card, 'ACH07359.JPG'));
  const dir = path.join(base, 'project');
  await mkdir(dir);
  t = makeService();
  projectId = unwrap(await t.service.createProject(dir, 'AI')).id;
  await t.waitForJob(unwrap(await t.service.addSources(projectId, [card])));
  const clean = (unwrap(await t.service.listPairCandidates(projectId)) as PairCandidate[]).filter((c) => !c.ambiguous);
  unwrap(await t.service.applyCommand(projectId, { type: 'confirm-pairs', pairs: clean.map((c) => ({ rawId: c.rawId, jpegId: c.jpegId })) }));
}, 300_000);

afterAll(async () => {
  await t?.service.shutdown();
  server?.close();
});

describe('analysis image', () => {
  it('shrinks a 61 MP camera JPEG without applying the RAW helper 60 MP limit', async () => {
    const src = await sharp({ create: { width: 9504, height: 6336, channels: 3, background: '#668' } }).jpeg().toBuffer();
    const result = await encodeForAnalysis(src, { autoOrient: true });
    expect(Math.max(result.width, result.height)).toBe(3840);
    expect(result.jpeg.length).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });
  it('caps the long edge at 3840 without upscaling and strips EXIF/GPS', async () => {
    const big = await sharp({ create: { width: 6000, height: 4000, channels: 3, background: '#668' } })
      .withExif({ IFD0: { Make: 'X' }, IFD3: { GPSLatitudeRef: 'N' } })
      .jpeg()
      .toBuffer();
    const a = await encodeForAnalysis(big, { autoOrient: true });
    expect(Math.max(a.width, a.height)).toBe(3840);
    expect((await sharp(a.jpeg).metadata()).exif).toBeUndefined();
    const small = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#668' } }).jpeg().toBuffer();
    expect((await encodeForAnalysis(small, { autoOrient: true })).width).toBe(1200);
  });

  it('lowers quality, then the size, to stay within 2.5 MiB', async () => {
    const noise = Buffer.alloc(5000 * 3500 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
    const src = await sharp(noise, { raw: { width: 5000, height: 3500, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    const a = await encodeForAnalysis(src, { autoOrient: true });
    expect(a.jpeg.length).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(a.quality).toBeLessThanOrEqual(85);
    expect([3840, 2560]).toContain(Math.max(a.width, a.height));
  });
});

describe('face analysis flow', () => {
  it('refuses to run without credentials', async () => {
    expect(await t.service.analyzeFaces(projectId, [(await all())[0]!.id])).toMatchObject({ ok: false, code: 'AI_NOT_CONFIGURED' });
  });

  it('analyses every photo once, shows eye state, counts quota, and leaves sources untouched', async () => {
    const before = await sourceTreeDigest(card);
    unwrap(await t.service.setAiCredentials(url, TOKEN));
    const ids = (await all()).map((a) => a.id);
    const done = await runAnalysis(ids);
    expect(done.kind === 'analysis' && done.phase).toBe('complete');
    expect(provider.received).toHaveLength(3);
    for (const jpeg of provider.received) {
      const m = await sharp(jpeg).metadata();
      expect(m.exif).toBeUndefined();
      expect(Math.max(m.width!, m.height!)).toBeLessThanOrEqual(3840);
    }
    const items = await all();
    for (const a of items) {
      expect(a.analysis?.status, a.primary.relativePath).toBe('done');
      expect(['open', 'closed']).toContain(a.analysis?.faces?.[0]?.eyes);
    }
    const pair = items.find((a) => a.companion)!;
    expect(pair.analysis?.sourceKind).toBe('companion-jpeg');
    const portrait = items.find((a) => a.primary.relativePath === 'ACH07383.ARW')!;
    expect(portrait.analysis?.imageHeight).toBeGreaterThan(portrait.analysis!.imageWidth!);
    expect(unwrap(await t.service.aiQuota()).user.used).toBe(3);
    expect(await sourceTreeDigest(card)).toBe(before);
  });

  it('does not call the API again for an unchanged photo', async () => {
    await runAnalysis((await all()).map((a) => a.id));
    expect(provider.received).toHaveLength(3);
  });

  it('reuses the earlier prep-v2 cache key that omitted the file role, without another paid call', async () => {
    const db = t.service.projects.get(projectId)!.store;
    const target = (await all()).find((a) => a.analysis?.status === 'done')!;
    const row = db.faceAnalysis(target.id)!;
    const file = db.file(row.sourceFileId)!;
    const legacy = createHash('sha256').update(`|${file.id}|${file.sampledHash}|prep-v2`).digest('hex');
    db.upsertFaceAnalysis({ ...row, inputKey: legacy });
    expect((await all()).find((a) => a.id === target.id)!.analysis?.status).toBe('done');
    const calls = provider.received.length;
    await runAnalysis([target.id]);
    expect(provider.received.length).toBe(calls);
    expect(db.faceAnalysis(target.id)!.inputKey).toBe(legacy);
    expect((await all()).find((a) => a.id === target.id)!.analysis?.status).toBe('done');
  });

  it('a lost response is recovered from the backend without a second provider call', async () => {
    const target = (await all()).find((a) => a.primary.relativePath === 'ACH07359.JPG')!;
    await rm(path.join(card, 'ACH07359.JPG'));
    await copyFile(fx('jpeg-sony-a7c-portrait'), path.join(card, 'ACH07359.JPG'));
    await t.waitForJob(unwrap(await t.service.addSources(projectId, [card])));
    const replaced = (await all()).find((a) => a.primary.relativePath === 'ACH07359.JPG' && a.id !== target.id)!;
    expect(replaced.analysis?.status ?? 'none').toBe('none'); // new content: old analysis not reused
    dropNext = true;
    await runAnalysis([replaced.id]);
    expect(provider.received).toHaveLength(4);
    expect((await all()).find((a) => a.id === replaced.id)!.analysis?.status).toBe('pending');
    await runAnalysis([replaced.id]);
    expect(provider.received).toHaveLength(4);
    expect((await all()).find((a) => a.id === replaced.id)!.analysis?.status).toBe('done');
  });

  it('stops without calling the provider when the token is wrong or the quota is used up', async () => {
    const calls = provider.received.length;
    const id = (await all())[0]!.id;
    unwrap(await t.service.setAiCredentials(url, 'wrong-token-0123456789abcdef0123456789'));
    const e1 = await runAnalysis([id]);
    expect(e1).toMatchObject({ phase: 'complete' }); // cached result: nothing to send
    store.tokens.set(hashToken(TOKEN), { userId: 'u1', label: 'local', active: true, userMonthlyLimit: 4 });
    unwrap(await t.service.setAiCredentials(url, TOKEN));
    await rm(path.join(card, 'ACH07359.JPG'));
    await copyFile(fx('jpeg-no-exif'), path.join(card, 'ACH07359.JPG'));
    await t.waitForJob(unwrap(await t.service.addSources(projectId, [card])));
    const fresh = (await all()).find((a) => a.primary.relativePath === 'ACH07359.JPG' && (a.analysis?.status ?? 'none') === 'none')!;
    const e2 = await runAnalysis([fresh.id]);
    expect(e2).toMatchObject({ phase: 'stopped' });
    expect((e2 as { message?: string }).message).toMatch(/hết lượt/i);
    unwrap(await t.service.setAiCredentials(url, 'wrong-token-0123456789abcdef0123456789'));
    const e3 = await runAnalysis([fresh.id]);
    expect((e3 as { message?: string }).message).toMatch(/token/i);
    expect(provider.received.length).toBe(calls);
  });
  it('a failed analysis is not retried automatically, only when the user asks', async () => {
    unwrap(await t.service.setAiCredentials(url, TOKEN));
    store.tokens.set(hashToken(TOKEN), { userId: 'u1', label: 'local', active: true, userMonthlyLimit: 1000 });
    const target = (await all()).find((a) => a.analysis?.status === 'done')!;
    const db = t.service.projects.get(projectId)!.store;
    const row = db.faceAnalysis(target.id)!;
    db.upsertFaceAnalysis({ ...row, status: 'failed', resultJson: null, error: 'PROVIDER_ERROR', idempotencyKey: `retry-test-${row.idempotencyKey}` });
    const calls = provider.received.length;
    await runAnalysis([target.id]);
    expect(provider.received.length).toBe(calls);
    const job = unwrap(await t.service.analyzeFaces(projectId, [target.id], true));
    await t.waitFor((e) => e.kind === 'analysis' && e.jobId === job && (e.phase === 'complete' || e.phase === 'stopped'), 120_000);
    expect((await all()).find((a) => a.id === target.id)!.analysis?.status).toBe('done');
  });
});

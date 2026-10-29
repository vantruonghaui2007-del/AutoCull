import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AiClient, runFaceAnalysis } from '../../src/worker/ai';
import { MediaQueue } from '../../src/worker/queue';
import { contentHashIdentity, exactDuplicateSets } from '../../src/worker/grouping';
import { makeTempDir } from '../helpers/fs';
import { writeSyntheticJpeg } from '../helpers/images';
import { makeService, unwrap, type TestService } from '../helpers/service';

let t: TestService;
let projectId: string;
beforeAll(async () => {
  const base = await makeTempDir('review-v02');
  const card = path.join(base, 'card');
  for (const n of ['A', 'B']) await writeSyntheticJpeg(path.join(card, `${n}.JPG`), { width: 640, height: 427 });
  const dir = path.join(base, 'project');
  await mkdir(dir);
  t = makeService();
  projectId = unwrap(await t.service.createProject(dir, 'Review regressions')).id;
  await t.waitForJob(unwrap(await t.service.addSources(projectId, [card])));
});
afterAll(async () => { await t?.service.shutdown(); });

it('old full hashes do not confirm duplicates after mtime changes with the same sample and size', () => {
  const store = t.service.projects.get(projectId)!.store;
  const assets = store.allAssets();
  const files = assets.map((a) => store.file(a.primaryFileId)!);
  for (const f of files) store.saveContentHash(f.id, contentHashIdentity(f), 'f'.repeat(64));
  expect(exactDuplicateSets(store)).toHaveLength(1);
  const f = files[0]!;
  store.updateFileIdentity(f.id, f.bytes, f.mtimeMs + 1000, f.sampledHash);
  expect(exactDuplicateSets(store)).toHaveLength(0);
});

it('a portable v1 import keeps the legacy grouping preset', async () => {
  const base = await makeTempDir('review-portable');
  const file = path.join(base, 'session.json');
  unwrap(await t.service.exportPortable(projectId, file));
  const dir = path.join(base, 'imported');
  await mkdir(dir);
  const imported = unwrap(await t.service.importPortable(file, dir));
  expect(unwrap(await t.service.getCullState(imported.id)).groupingPreset).toBe('group-v1');
});

it('analysis skips an asset deleted while preparation was queued (no FK failure and no upload)', async () => {
  const store = t.service.projects.get(projectId)!.store;
  const target = store.allAssets()[1]!;
  const queue = new MediaQueue({ metadataJobs: 1, imageJobs: 1, timeoutMs: 10_000 });
  let release!: () => void;
  const blocker = queue.run('image', 'blocker', () => new Promise<void>((r) => { release = r; }));
  let calls = 0;
  const client = new AiClient('http://127.0.0.1', 'test-token', (async () => {
    calls++;
    throw new Error('must not upload');
  }) as typeof fetch);
  const pending = runFaceAnalysis({ store, queue, client, emit() {} }, { jobId: 'race-test', projectId, cancelled: false, done: Promise.resolve() }, [target.id]);
  store.deleteAsset(target.id);
  release();
  await blocker;
  expect((await pending).status).toBe('complete');
  expect(calls).toBe(0);
});

it('cancelling a client request aborts its HTTP wait promptly', async () => {
  const ac = new AbortController();
  const client = new AiClient('http://127.0.0.1', 'test-token', (async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  })) as typeof fetch);
  const pending = client.analyze(Buffer.from('jpeg'), 'key', ac.signal);
  ac.abort();
  expect(await pending).toMatchObject({ kind: 'network', message: 'aborted' });
});

it('closing a project cancels scans before awaiting an AutoCull that is waiting on them', async () => {
  const p = t.service.projects.get(projectId)!;
  let finish!: () => void;
  const done = new Promise<void>((r) => { finish = r; });
  const scan = { jobId: 'close-scan', token: 'close-scan-token', closing: false, userCancelled: false, done };
  Object.defineProperty(scan, 'closing', { set(value) { if (value) finish(); } });
  p.runs.set(scan.jobId, scan);
  unwrap(await t.service.startAutoCull(projectId));
  unwrap(await t.service.closeProject(projectId));
  expect(t.service.projects.has(projectId)).toBe(false);
}, 10_000);

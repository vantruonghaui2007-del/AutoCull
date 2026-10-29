import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PREVIEW_CACHE_BYTES } from '../../src/worker/cache';
import { fixturePath, loadFixtures, requireVerifiedFixtures } from '../helpers/fixtures';
import { makeTempDir, sourceTreeDigest } from '../helpers/fs';
import { makeService, unwrap, type TestService } from '../helpers/service';

const fx = (id: string) => fixturePath(loadFixtures().find((e) => e.id === id)!);
let t: TestService;
let projectId: string;
let cacheRoot: string;
let card: string;
let digest: string;

const previewFiles = async () => (await readdir(cacheRoot)).filter((f) => f.endsWith('-p.jpg'));
const thumbFiles = async () => (await readdir(cacheRoot)).filter((f) => f.endsWith('-t.jpg'));

beforeAll(async () => {
  await requireVerifiedFixtures();
  const base = await makeTempDir('cache');
  card = path.join(base, 'card');
  await mkdir(card);
  for (const id of ['cr2-canon-5d3', 'raf-fuji-xt3', 'jpeg-sony-a7c-1', 'jpeg-sony-a7c-2', 'dng-adobe-5d3']) await copyFile(fx(id), path.join(card, path.basename(fx(id))));
  digest = await sourceTreeDigest(card);
  const dir = path.join(base, 'project');
  await mkdir(dir);
  t = makeService();
  projectId = unwrap(await t.service.createProject(dir, 'Cache')).id;
  await t.waitForJob(unwrap(await t.service.addSources(projectId, [card])));
  cacheRoot = path.join(dir, 'cache', 'previews');
  await writeFile(path.join(cacheRoot, 'not-a-cache-file.txt'), 'keep me');
});

afterAll(async () => {
  await t?.service.shutdown();
});

describe('preview disk cache', () => {
  it('defaults to a 1 GiB budget', () => {
    expect(PREVIEW_CACHE_BYTES).toBe(1024 ** 3);
  });

  it('evicts least-recently-used large previews first, keeps thumbnails and foreign files', async () => {
    expect(await previewFiles()).toHaveLength(5);
    // Mark one asset as recently viewed.
    const page = unwrap(await t.service.queryAssets(projectId, { offset: 0, limit: 1 }));
    const recent = page.items[0]!.preview!.url.split('/').pop()!;
    const sizes = await Promise.all((await previewFiles()).map(async (f) => (await stat(path.join(cacheRoot, f))).size));
    const thumbsBytes = (await Promise.all((await thumbFiles()).map(async (f) => (await stat(path.join(cacheRoot, f))).size))).reduce((a, b) => a + b, 0);
    const budget = thumbsBytes + Math.max(...sizes) + 1;
    const r = unwrap(await t.service.evictPreviewCache(projectId, budget));
    expect(r.evicted).toBeGreaterThanOrEqual(3);
    const left = await previewFiles();
    expect(left).toContain(recent);
    expect(await thumbFiles()).toHaveLength(5);
    expect(await readdir(cacheRoot)).toContain('not-a-cache-file.txt');
    expect(await sourceTreeDigest(card)).toBe(digest);
  });

  it('regenerates an evicted preview on demand under the same cache name', async () => {
    const all = unwrap(await t.service.queryAssets(projectId, { offset: 0, limit: 200 })).items;
    const present = new Set(await previewFiles());
    const evicted = all.map((a) => a.preview!.url.split('/').pop()!).find((n) => !present.has(n))!;
    expect(evicted).toBeTruthy();
    expect(unwrap(await t.service.restorePreview(projectId, evicted))).toBe(true);
    expect(await previewFiles()).toContain(evicted);
  });

  it('refuses names that are not cache IDs', async () => {
    expect(await t.service.restorePreview(projectId, '..\\..\\project.sqlite')).toMatchObject({ ok: false });
  });
});

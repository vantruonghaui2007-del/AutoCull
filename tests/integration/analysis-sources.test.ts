import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PREP_VERSION } from '../../src/media/analysis-image';
import { prepareAnalysisImage, saveLibrawPreview } from '../../src/worker/ai';
import type { AssetView } from '../../src/shared/contracts';
import { fixturePath, loadFixtures, requireVerifiedFixtures } from '../helpers/fixtures';
import { makeTempDir, sourceTreeDigest } from '../helpers/fs';
import { makeService, unwrap, type TestService } from '../helpers/service';

const fx = (id: string) => fixturePath(loadFixtures().find((e) => e.id === id)!);
let t: TestService;
let projectId: string;
let card: string;
const byName = async (n: string): Promise<AssetView> =>
  unwrap(await t.service.queryAssets(projectId, { offset: 0, limit: 200 })).items.find((a) => a.primary.relativePath === n)!;

beforeAll(async () => {
  await requireVerifiedFixtures();
  const base = await makeTempDir('sources');
  card = path.join(base, 'card');
  await mkdir(card);
  for (const [id, name] of [
    ['arw-sony-a7c-1', 'ARW_ONLY.ARW'],
    ['arw-sony-a7c-portrait', 'ARW_PORTRAIT.ARW'],
    ['nef-nikon-d750', 'D750.NEF'],
    ['cr2-canon-5d3', '5D3.CR2'],
    ['arw-truncated', 'BROKEN.ARW'],
  ] as const)
    await copyFile(fx(id), path.join(card, name));
  const dir = path.join(base, 'project');
  await mkdir(dir);
  t = makeService();
  projectId = unwrap(await t.service.createProject(dir, 'Nguồn phân tích')).id;
  await t.waitForJob(unwrap(await t.service.addSources(projectId, [card])));
}, 300_000);

afterAll(async () => {
  await t?.service.shutdown();
});

const prep = async (name: string) => {
  const store = t.service.projects.get(projectId)!.store;
  const v = await byName(name);
  return prepareAnalysisImage(store, store.asset(v.id)!, new AbortController().signal);
};

describe('analysis source order', () => {
  it('uses the pinned preprocessing version', () => {
    expect(PREP_VERSION).toBe('prep-v2');
  });

  it('decodes an ARW without a JPEG companion with LibRaw (its embedded preview is too small)', async () => {
    const a = await prep('ARW_ONLY.ARW');
    expect(a.kind).toBe('libraw');
    expect(Math.max(a.width, a.height)).toBe(3840);
    expect(a.libraw).toBeTruthy();
    const p = await prep('ARW_PORTRAIT.ARW');
    expect(p.kind).toBe('libraw');
    expect(p.height).toBeGreaterThan(p.width);
  }, 120_000);

  it('uses the full-size embedded JPEG of a NEF that the old 24 MP display limit skipped', async () => {
    const a = await prep('D750.NEF');
    expect(a.kind).toBe('embedded');
    expect(Math.max(a.width, a.height)).toBe(3840);
    expect((await sharp(a.jpeg).metadata()).exif).toBeUndefined();
  });

  it('uses a large embedded JPEG directly (CR2)', async () => {
    expect((await prep('5D3.CR2')).kind).toBe('embedded');
  });

  it('reports a broken RAW with a specific error instead of a fake result', async () => {
    await expect(prep('BROKEN.ARW')).rejects.toMatchObject({ code: expect.stringMatching(/^(RAW_|NO_ANALYSIS_SOURCE|METADATA_ERROR)/) });
  });

  it('a LibRaw image becomes the display preview of a RAW whose embedded preview was small', async () => {
    const before = await byName('ARW_ONLY.ARW');
    expect(before.status).toBe('preview-small');
    const store = t.service.projects.get(projectId)!.store;
    const a = await prep('ARW_ONLY.ARW');
    await saveLibrawPreview(store, store.asset(before.id)!, a.libraw!);
    const after = await byName('ARW_ONLY.ARW');
    expect(after.preview?.origin).toBe('libraw');
    expect(after.preview?.insufficientForFocus).toBe(false);
    expect(after.status).toBe('ready');
  }, 120_000);

  it('never changes the source files', async () => {
    const before = await sourceTreeDigest(card);
    await prep('ARW_PORTRAIT.ARW');
    expect(await sourceTreeDigest(card)).toBe(before);
  }, 120_000);
});

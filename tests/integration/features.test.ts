import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeFeatures, FEATURE_ALGORITHM } from '../../src/media/features';
import { hamming, histogramIntersection } from '../../src/culling/groups';
import { closeExifTool } from '../../src/media/exiftool';
import { extractPreview } from '../../src/media/previews';
import type { AssetView, Group } from '../../src/shared/contracts';
import { fixturePath, loadFixtures, requireVerifiedFixtures } from '../helpers/fixtures';
import { makeTempDir } from '../helpers/fs';
import { writeSyntheticJpeg } from '../helpers/images';
import { makeService, unwrap } from '../helpers/service';

const fx = (id: string) => fixturePath(loadFixtures().find((e) => e.id === id)!);
let cache: string;
const previews: Record<string, string> = {};

beforeAll(async () => {
  await requireVerifiedFixtures();
  cache = await makeTempDir('features');
  for (const [key, id, kind] of [
    ['cr2', 'cr2-canon-5d3', 'raw'],
    ['dng', 'dng-adobe-5d3', 'raw'],
    ['raf', 'raf-fuji-xt3', 'raw'],
    ['arw1', 'arw-sony-a7c-1', 'raw'],
    ['jpg1', 'jpeg-sony-a7c-1', 'jpeg'],
  ] as const) {
    const r = await extractPreview(fx(id), cache, { kind, orientation: 1 });
    if (!r.ok) throw new Error(`${id}: ${r.message}`);
    previews[key] = path.join(cache, r.value.cacheId);
  }
});

afterAll(async () => {
  await closeExifTool();
});

describe('computeFeatures', () => {
  it('returns a versioned vector from a downsampled preview', async () => {
    const f = unwrap(await computeFeatures(previews.cr2!));
    expect(f.algorithmVersion).toBe(FEATURE_ALGORITHM);
    expect(Math.max(f.width, f.height)).toBeLessThanOrEqual(512);
    expect(f.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(f.histogram.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });

  it('sees the same frame (CR2 vs its DNG conversion, ARW vs its JPEG) as near-identical', async () => {
    const [cr2, dng, arw, jpg] = await Promise.all(['cr2', 'dng', 'arw1', 'jpg1'].map(async (k) => unwrap(await computeFeatures(previews[k]!))));
    expect(hamming(cr2!.hash, dng!.hash)).toBeLessThanOrEqual(10);
    expect(histogramIntersection(cr2!.histogram, dng!.histogram)).toBeGreaterThanOrEqual(0.85);
    expect(hamming(arw!.hash, jpg!.hash)).toBeLessThanOrEqual(10);
  });

  it('sees different scenes as different', async () => {
    const cr2 = unwrap(await computeFeatures(previews.cr2!));
    const raf = unwrap(await computeFeatures(previews.raf!));
    const differentEnough = hamming(cr2.hash, raf.hash) > 10 || histogramIntersection(cr2.histogram, raf.histogram) < 0.85;
    expect(differentEnough).toBe(true);
  });

  it('reports a lower Laplacian variance for a blurred copy (relative signal only)', async () => {
    const blurred = path.join(cache, 'blurred.jpg');
    await sharp(previews.cr2!).blur(4).jpeg().toFile(blurred);
    const sharpF = unwrap(await computeFeatures(previews.cr2!));
    const blurF = unwrap(await computeFeatures(blurred));
    expect(blurF.laplacianVariance).toBeLessThan(sharpF.laplacianVariance);
  });

  it('returns an error result for an undecodable file instead of throwing', async () => {
    expect((await computeFeatures(path.join(cache, 'nope.jpg'))).ok).toBe(false);
  });
});

describe('grouping inside a project', () => {
  it('groups a burst, keeps manual groups and never changes decisions on regroup', async () => {
    const base = await makeTempDir('group-project');
    const card = path.join(base, 'card');
    // A burst of three near frames, then a different scene 30 s later.
    for (let i = 0; i < 3; i++) {
      await writeSyntheticJpeg(path.join(card, `B${i}.JPG`), {
        width: 320,
        height: 213,
        make: 'TEST',
        model: 'BURST',
        serial: '42',
        dateTimeOriginal: `2026:10:01 10:00:0${i}`,
        squareAt: 100 + i * 4,
      });
    }
    await writeSyntheticJpeg(path.join(card, 'Z.JPG'), {
      width: 320,
      height: 213,
      make: 'TEST',
      model: 'BURST',
      serial: '42',
      dateTimeOriginal: '2026:10:01 10:00:30',
      rgb: [200, 30, 30],
    });
    await copyFile(fx('jpeg-no-exif'), path.join(card, 'no-time.jpg'));
    const dir = path.join(base, 'project');
    await mkdir(dir);
    const t = makeService();
    const id = unwrap(await t.service.createProject(dir, 'Cụm')).id;
    await t.waitForJob(unwrap(await t.service.addSources(id, [card])));
    const groups = unwrap(await t.service.listGroups(id)) as Group[];
    const page = unwrap(await t.service.queryAssets(id, { offset: 0, limit: 200 }));
    const byName = (n: string) => page.items.find((a: AssetView) => a.primary.relativePath === n)!;
    const burst = groups.find((g) => g.assetIds.includes(byName('B0.JPG').id))!;
    expect(burst.assetIds.sort()).toEqual([byName('B0.JPG').id, byName('B1.JPG').id, byName('B2.JPG').id].sort());
    expect(burst.assetIds).not.toContain(byName('Z.JPG').id);
    expect(byName('B1.JPG').signals?.laplacianVariance).toBeGreaterThan(0);

    unwrap(await t.service.applyCommand(id, { type: 'set-rating', assetIds: [byName('B0.JPG').id], rating: 5 }));
    unwrap(await t.service.applyCommand(id, { type: 'split-group', groupId: burst.id, assetIds: [byName('B2.JPG').id] }));
    const afterSplit = unwrap(await t.service.listGroups(id)) as Group[];
    const manualGroup = afterSplit.find((g) => g.manual && g.assetIds.includes(byName('B2.JPG').id))!;
    expect(manualGroup.assetIds).toEqual([byName('B2.JPG').id]);

    const decisionsBeforeRegroup = unwrap(await t.service.queryAssets(id, { offset: 0, limit: 200 })).items.map((a) => a.decision);
    unwrap(await t.service.applyCommand(id, { type: 'regroup' }));
    const groupsAfterRegroup = unwrap(await t.service.listGroups(id)) as Group[];
    expect(groupsAfterRegroup.find((g) => g.id === manualGroup.id)).toEqual(manualGroup);
    const decisionsAfterRegroup = unwrap(await t.service.queryAssets(id, { offset: 0, limit: 200 })).items.map((a) => a.decision);
    expect(decisionsAfterRegroup).toEqual(decisionsBeforeRegroup);

    const merged = afterSplit.filter((g) => g.assetIds.some((x) => [byName('B0.JPG').id, byName('B2.JPG').id].includes(x)));
    unwrap(await t.service.applyCommand(id, { type: 'merge-groups', groupIds: merged.map((g) => g.id) }));
    const afterMerge = unwrap(await t.service.listGroups(id)) as Group[];
    expect(afterMerge.find((g) => g.assetIds.includes(byName('B0.JPG').id))!.assetIds).toHaveLength(3);
    await t.service.shutdown();
  });
});

// Manual evaluation helper (not part of the automated suites).
// EVAL_SOURCE=<folder> npx vitest run --project manual
// Scans the folder read-only into a throwaway project under work/, then writes a JSON report and
// contact sheets (one row per multi-frame group) so a person can judge false merges/splits.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { expect, it } from 'vitest';
import { DEFAULT_GROUPING } from '../../src/culling/groups';
import type { AssetView, Group } from '../../src/shared/contracts';
import { makeTempDir, sourceTreeDigest, workRoot } from '../helpers/fs';
import { makeService, unwrap } from '../helpers/service';

it('groups a real folder and writes an evaluation report', async () => {
  const source = process.env.EVAL_SOURCE;
  expect(source, 'set EVAL_SOURCE').toBeTruthy();
  const digestBefore = process.env.EVAL_DIGEST === '1' ? await sourceTreeDigest(source!) : null;
  const dir = await makeTempDir('grouping-eval');
  const t = makeService();
  const id = unwrap(await t.service.createProject(dir, 'Đánh giá cụm')).id;
  const started = Date.now();
  await t.waitForJob(unwrap(await t.service.addSources(id, [source!])), 3_600_000);
  const scanMs = Date.now() - started;
  const assets: AssetView[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = unwrap(await t.service.queryAssets(id, { offset, limit: 200 }));
    assets.push(...page.items);
    if (assets.length >= page.total) break;
  }
  const byId = new Map(assets.map((a) => [a.id, a]));
  const groups = unwrap(await t.service.listGroups(id)) as Group[];
  const multi = groups.filter((g) => g.assetIds.length > 1);
  const report = {
    at: new Date().toISOString(),
    config: DEFAULT_GROUPING,
    source: path.basename(source!),
    scanMs,
    assets: assets.length,
    groups: groups.length,
    multiFrameGroups: multi.length,
    sizes: Object.fromEntries([...new Set(groups.map((g) => g.assetIds.length))].sort((a, b) => a - b).map((n) => [n, groups.filter((g) => g.assetIds.length === n).length])),
    statusCounts: assets.reduce<Record<string, number>>((m, a) => ((m[a.status] = (m[a.status] ?? 0) + 1), m), {}),
    groupList: groups.map((g, i) => ({
      index: i,
      confidence: g.confidence,
      members: g.assetIds.map((aid) => `${byId.get(aid)?.primary.relativePath} @ ${byId.get(aid)?.effectiveLocal ?? '?'}`),
    })),
  };
  const outDir = path.join(workRoot, 'reports', 'grouping-eval');
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

  // Contact sheets: rows of [group index label | thumbnails...], neighbours in time order.
  const thumbW = 150;
  const thumbH = 100;
  const rowsPerSheet = 14;
  const cacheRoot = path.join(dir, 'cache', 'previews');
  const ordered = groups.map((g, i) => ({ g, i }));
  for (let sheet = 0; sheet * rowsPerSheet < ordered.length && sheet < 6; sheet++) {
    const rows = ordered.slice(sheet * rowsPerSheet, (sheet + 1) * rowsPerSheet);
    const maxCols = 8;
    const width = 60 + maxCols * (thumbW + 4);
    const height = rows.length * (thumbH + 6);
    const composites: OverlayOptions[] = [];
    for (const [r, { g, i }] of rows.entries()) {
      const top = r * (thumbH + 6);
      const label = Buffer.from(
        `<svg width="58" height="${thumbH}"><rect width="58" height="${thumbH}" fill="${g.assetIds.length > 1 ? '#335' : '#222'}"/><text x="4" y="30" font-size="20" fill="#fff">${i}</text><text x="4" y="60" font-size="14" fill="#ccc">${g.assetIds.length}${g.confidence === 'low' ? ' L' : ''}</text></svg>`,
      );
      composites.push({ input: label, top, left: 0 });
      for (const [c, aid] of g.assetIds.slice(0, maxCols).entries()) {
        const a = byId.get(aid);
        const thumb = a?.preview?.thumbUrl.split('/').pop();
        if (!thumb) continue;
        const buf = await sharp(path.join(cacheRoot, thumb)).resize(thumbW, thumbH, { fit: 'contain', background: '#000' }).toBuffer();
        composites.push({ input: buf, top, left: 60 + c * (thumbW + 4) });
      }
    }
    await sharp({ create: { width, height, channels: 3, background: '#111' } })
      .composite(composites)
      .jpeg({ quality: 80 })
      .toFile(path.join(outDir, `sheet-${sheet}.jpg`));
  }
  if (digestBefore) expect(await sourceTreeDigest(source!)).toBe(digestBefore);
  await t.service.shutdown();
}, 3_700_000);

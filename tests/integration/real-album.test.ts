import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir, sourceTreeDigest } from '../helpers/fs';
import { makeService, unwrap } from '../helpers/service';

// Opt-in measurement on a real album (never committed): EVENTSTORY_ALBUM=<folder> [EVENTSTORY_REPORT=<file>].
// Without AI settings: scan, pairing, grouping, ranking and paging. Not a quality benchmark.
const album = process.env.EVENTSTORY_ALBUM;

describe.skipIf(!album)('real album (opt-in)', () => {
  it('scans, runs AutoCull without AI, pages the lists quickly and leaves sources untouched', async () => {
    const before = await sourceTreeDigest(album!);
    const dir = path.join(await makeTempDir('real-album'), 'project');
    await mkdir(dir);
    const t = makeService();
    let peakRss = 0;
    const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 250);
    const t0 = Date.now();
    const projectId = unwrap(await t.service.createProject(dir, 'Real album')).id;
    await t.waitForJob(unwrap(await t.service.addSources(projectId, [album!])), 3_600_000);
    const scanMs = Date.now() - t0;
    const pairs = unwrap(await t.service.listPairCandidates(projectId)).filter((c) => !c.ambiguous);
    unwrap(await t.service.applyCommand(projectId, { type: 'confirm-pairs', pairs: pairs.map((c) => ({ rawId: c.rawId, jpegId: c.jpegId })) }));
    const t1 = Date.now();
    const runId = unwrap(await t.service.startAutoCull(projectId));
    const end = await t.waitFor((e) => e.kind === 'autocull' && e.runId === runId && ['complete', 'paused', 'failed', 'cancelled'].includes(e.phase), 3_600_000);
    const autocullMs = Date.now() - t1;
    const timings: number[] = [];
    for (const list of ['keep', 'better-option', 'review'] as const) {
      const q0 = performance.now();
      unwrap(await t.service.queryAssets(projectId, { offset: 0, limit: 200, list }));
      timings.push(performance.now() - q0);
    }
    const q0 = performance.now();
    const page = unwrap(await t.service.queryAssets(projectId, { offset: 0, limit: 200 }));
    timings.push(performance.now() - q0);
    const state = unwrap(await t.service.getCullState(projectId));
    const groups = unwrap(await t.service.listGroups(projectId));
    clearInterval(sampler);
    const report = {
      at: new Date().toISOString(),
      album: path.basename(album!),
      assets: page.total,
      pairsConfirmed: pairs.length,
      scanMs,
      autocullMs,
      autocullEnd: (end as { phase: string; message?: string }).phase,
      autocullMessage: (end as { message?: string }).message ?? null,
      counts: state.counts,
      groups: groups.length,
      multiGroups: groups.filter((g) => g.assetIds.length > 1).length,
      largestGroup: Math.max(...groups.map((g) => g.assetIds.length)),
      queryMs: timings.map((x) => Math.round(x)),
      peakRssMiB: Math.round(peakRss / 1024 / 1024),
    };
    await t.service.shutdown();
    if (process.env.EVENTSTORY_REPORT) await writeFile(process.env.EVENTSTORY_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report));
    expect(await sourceTreeDigest(album!)).toBe(before);
    expect(Math.max(...timings)).toBeLessThan(1500);
  }, 3_600_000);
});

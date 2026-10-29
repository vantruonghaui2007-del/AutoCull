import { mkdir, readdir, readFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssetView } from '../../src/shared/contracts';
import { makeTempDir, sha256, sourceTreeDigest } from '../helpers/fs';
import { writeSyntheticJpeg } from '../helpers/images';
import { colourCodedProvider, startLocalBackend } from '../helpers/local-backend';
import { makeService, unwrap, type TestService } from '../helpers/service';

const TOKEN = 'export-sel-token-0123456789abcdef0123456789';
const calls = { n: 0 };
let backend: Awaited<ReturnType<typeof startLocalBackend>>;
let t: TestService;
let projectId: string;
let card: string;
let out: string;

const all = async (): Promise<AssetView[]> => unwrap(await t.service.queryAssets(projectId, { offset: 0, limit: 200 })).items;
const byName = async (n: string) => (await all()).find((a) => a.primary.relativePath === n)!;
async function autocull() {
  const runId = unwrap(await t.service.startAutoCull(projectId));
  return t.waitFor((e) => e.kind === 'autocull' && e.runId === runId && ['complete', 'paused', 'cancelled', 'failed'].includes(e.phase), 120_000);
}
async function exportSelection() {
  const plan = unwrap(await t.service.planExport(projectId, 'selection', out, 'copy-originals'));
  return plan;
}

beforeAll(async () => {
  backend = await startLocalBackend(colourCodedProvider(calls), TOKEN);
  const base = await makeTempDir('export-sel');
  card = path.join(base, 'card');
  out = path.join(base, 'out');
  await mkdir(out, { recursive: true });
  const cam = { width: 640, height: 427, make: 'TEST', model: 'EXPORT', serial: '3' };
  await writeSyntheticJpeg(path.join(card, 'A0.JPG'), { ...cam, dateTimeOriginal: '2026:10:01 09:00:00', rgb: [70, 110, 150], squareAt: 300 });
  await writeSyntheticJpeg(path.join(card, 'A1.JPG'), { ...cam, dateTimeOriginal: '2026:10:01 09:00:02', rgb: [150, 100, 70], squareAt: 302 });
  await writeSyntheticJpeg(path.join(card, 'Z.JPG'), { ...cam, dateTimeOriginal: '2026:10:01 12:00:00', rgb: [40, 160, 60] });
  const dir = path.join(base, 'project');
  await mkdir(dir);
  t = makeService();
  projectId = unwrap(await t.service.createProject(dir, 'Xuất lựa chọn')).id;
  await t.waitForJob(unwrap(await t.service.addSources(projectId, [card])));
  unwrap(await t.service.setAiCredentials(backend.url, TOKEN));
  expect((await autocull()).kind === 'autocull').toBe(true);
}, 300_000);

afterAll(async () => {
  await t?.service.shutdown();
  backend?.close();
});

describe('export from the effective selection', () => {
  it('copies exactly the selected originals, byte for byte, with reasons and scores in the manifest', async () => {
    const before = await sourceTreeDigest(card);
    const selected = (await all()).filter((a) => a.cull.selected);
    expect(selected.map((a) => a.primary.relativePath).sort()).toEqual(['A0.JPG', 'Z.JPG']);
    const plan = await exportSelection();
    expect(plan.logicalCount).toBe(2);
    const jobId = unwrap(await t.service.executeExport(plan.planId));
    await t.waitForJob(jobId);
    const folder = unwrap(await t.service.exportFolderPath(jobId));
    const names = (await readdir(folder)).sort();
    expect(names).toEqual(['A0.JPG', 'Z.JPG', 'eventstory-manifest.csv', 'eventstory-manifest.json']);
    for (const n of ['A0.JPG', 'Z.JPG']) expect(await sha256(path.join(folder, n))).toBe(await sha256(path.join(card, n)));
    const manifest = JSON.parse(await readFile(path.join(folder, 'eventstory-manifest.json'), 'utf8'));
    const a0 = manifest.assets.find((x: { primary: string }) => x.primary === 'A0.JPG');
    expect(a0.cull).toMatchObject({ selectedBy: 'auto', list: 'keep', reasons: expect.arrayContaining(['BEST_IN_GROUP']) });
    expect(a0.cull.score).toBeGreaterThan(0);
    expect(a0.cull.criteria.eyes).toBe(100);
    expect(a0.cull.reasonText.join(' ')).toMatch(/tốt nhất/);
    const csv = await readFile(path.join(folder, 'eventstory-manifest.csv'), 'utf8');
    expect(csv.split('\r\n')[0]).toContain('cull_reasons');
    expect(await sourceTreeDigest(card)).toBe(before);
  });

  it('manual keeps replace the automatic pick in the export', async () => {
    const a1 = await byName('A1.JPG');
    unwrap(await t.service.applyCommand(projectId, { type: 'set-review', assetIds: [a1.id], state: 'keep' }));
    const plan = await exportSelection();
    expect(plan.outputs.map((o) => o.outputName).sort()).toEqual(['A1.JPG', 'Z.JPG']);
    unwrap(await t.service.applyCommand(projectId, { type: 'set-review', assetIds: [a1.id], state: 'unreviewed' }));
  });

  it('refuses a plan when the selection changed after preview', async () => {
    const plan = await exportSelection();
    const z = await byName('Z.JPG');
    unwrap(await t.service.applyCommand(projectId, { type: 'set-review', assetIds: [z.id], state: 'pass' }));
    expect(await t.service.executeExport(plan.planId)).toMatchObject({ ok: false, code: 'PLAN_STALE' });
    unwrap(await t.service.applyCommand(projectId, { type: 'set-review', assetIds: [z.id], state: 'unreviewed' }));
  });

  it('an unchanged re-run does not make the plan stale, but changed file metadata does', async () => {
    const plan = await exportSelection();
    await autocull();
    const ok1 = await t.service.executeExport(plan.planId);
    expect(ok1.ok).toBe(true);
    if (ok1.ok) await t.waitForJob(ok1.value);
    const plan2 = await exportSelection();
    const when = new Date('2026-10-02T08:00:00Z');
    await utimes(path.join(card, 'Z.JPG'), when, when);
    await t.waitForJob(unwrap(await t.service.addSources(projectId, [card])));
    expect(await t.service.executeExport(plan2.planId)).toMatchObject({ ok: false, code: 'PLAN_STALE_METADATA' });
  });

  it('refuses a plan when the recommendations changed (new analysis revision)', async () => {
    // The previous test changed metadata, so its recommendation is now correctly stale.
    await autocull();
    const plan = await exportSelection();
    expect(plan.logicalCount).toBe(2);
    // Changing the analysis input of a selected photo (re-pairing/replacement) changes its revision on the next run.
    const store = t.service.projects.get(projectId)!.store;
    const z = await byName('Z.JPG');
    const row = store.faceAnalysis(z.id)!;
    store.upsertFaceAnalysis({ ...row, updatedAt: new Date(Date.now() + 1000).toISOString() });
    await autocull();
    expect(await t.service.executeExport(plan.planId)).toMatchObject({ ok: false, code: 'PLAN_STALE_ANALYSIS' });
  });
  it('changing groups after the run makes the old recommendations stale until AutoCull runs again', async () => {
    const groups = unwrap(await t.service.listGroups(projectId));
    const a0 = await byName('A0.JPG');
    const z = await byName('Z.JPG');
    expect(z.cull.selected).toBe(true);
    unwrap(await t.service.applyCommand(projectId, { type: 'merge-groups', groupIds: [groups.find((g) => g.assetIds.includes(a0.id))!.id, groups.find((g) => g.assetIds.includes(z.id))!.id] }));
    const after = await byName('Z.JPG');
    expect(after.cull).toMatchObject({ selected: false, list: 'review', reasons: expect.arrayContaining(['RESULT_STALE']) });
    expect((await all()).some((a) => a.cull.selected)).toBe(false);
    await autocull();
    expect((await all()).filter((a) => a.cull.selected)).toHaveLength(1);
  });

  it('a missing source file is not re-approved by rerunning AutoCull with its old cached face result', async () => {
    const store = t.service.projects.get(projectId)!.store;
    const chosen = (await all()).find((a) => a.cull.selected)!;
    store.setFileFlags(chosen.primary.id, { missing: true });
    await autocull();
    const after = (await all()).find((a) => a.id === chosen.id)!;
    expect(after.cull).toMatchObject({ selected: false, reasons: expect.arrayContaining(['ANALYSIS_STALE']) });
    store.setFileFlags(chosen.primary.id, { missing: false });
    await autocull();
  });

  it('changing a companion invalidates old automatic picks immediately, but manual keeps still win', async () => {
    const before = (await all()).find((a) => a.cull.selected)!;
    const other = (await all()).find((a) => a.id !== before.id)!;
    const plan = await exportSelection();
    const store = t.service.projects.get(projectId)!.store;
    store.setCompanion(before.id, other.primary.id, true);
    const after = (await all()).find((a) => a.id === before.id)!;
    expect(after.cull).toMatchObject({ selected: false, list: 'review', reasons: expect.arrayContaining(['RESULT_STALE']) });
    expect(await t.service.executeExport(plan.planId)).toMatchObject({ ok: false, code: 'PLAN_STALE' });
    unwrap(await t.service.applyCommand(projectId, { type: 'set-review', assetIds: [before.id], state: 'keep' }));
    expect((await all()).find((a) => a.id === before.id)!.cull).toMatchObject({ selected: true, source: 'manual-keep' });
  });
});

import { appendFile, copyFile, mkdir, readdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planExport } from '../../src/export/plan';
import { executeExport } from '../../src/export/write';
import type { AssetView, ExportPlanView, ExportReport, PairCandidate } from '../../src/shared/contracts';
import { fixturePath, loadFixtures, requireVerifiedFixtures } from '../helpers/fixtures';
import { makeTempDir, sha256, sourceTreeDigest } from '../helpers/fs';
import { makeService, unwrap, type TestService } from '../helpers/service';

const fx = (id: string) => fixturePath(loadFixtures().find((e) => e.id === id)!);
const DEVELOP_XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="+0.35" crs:WhiteBalance="Custom"/>
</rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;

let t: TestService;
let base: string;
let card: string;
let projectDir: string;
let projectId: string;
let digestBefore: string;
let assets: AssetView[];

async function allAssets(): Promise<AssetView[]> {
  return unwrap(await t.service.queryAssets(projectId, { offset: 0, limit: 200 })).items;
}

async function runExport(planId: string): Promise<ExportReport> {
  const jobId = unwrap(await t.service.executeExport(planId));
  await t.waitForJob(jobId);
  return unwrap(await t.service.getExportReport(jobId))!;
}

beforeAll(async () => {
  await requireVerifiedFixtures();
  base = await makeTempDir('export');
  card = path.join(base, 'Thẻ');
  await mkdir(path.join(card, 'Card1', 'DCIM'), { recursive: true });
  await mkdir(path.join(card, 'Card2', 'DCIM'), { recursive: true });
  await copyFile(fx('arw-sony-a7c-1'), path.join(card, 'Card1', 'DCIM', 'ACH07358.ARW'));
  await copyFile(fx('jpeg-sony-a7c-1'), path.join(card, 'Card1', 'DCIM', 'ACH07358.JPG'));
  await writeFile(path.join(card, 'Card1', 'DCIM', 'ACH07358.xmp'), DEVELOP_XMP);
  await copyFile(fx('arw-sony-a7c-portrait'), path.join(card, 'Card1', 'DCIM', 'ACH07383.ARW'));
  await copyFile(fx('dng-adobe-5d3'), path.join(card, 'Card1', 'DCIM', 'IMG_0001.DNG'));
  // Same name as Card1's RAW in another folder, differing only by case: outputs must not collide.
  await copyFile(fx('arw-sony-a7c-2'), path.join(card, 'Card2', 'DCIM', 'ach07358.arw'));
  await copyFile(fx('jpeg-no-exif'), path.join(card, 'Card2', 'lẻ.jpg'));
  digestBefore = await sourceTreeDigest(card);

  projectDir = path.join(base, 'project');
  await mkdir(projectDir);
  t = makeService();
  projectId = unwrap(await t.service.createProject(projectDir, 'Xuất')).id;
  await t.waitForJob(unwrap(await t.service.addSources(projectId, [card])));
  const clean = (unwrap(await t.service.listPairCandidates(projectId)) as PairCandidate[]).filter((c) => !c.ambiguous);
  unwrap(await t.service.applyCommand(projectId, { type: 'confirm-pairs', pairs: clean.map((c) => ({ rawId: c.rawId, jpegId: c.jpegId })) }));
  assets = await allAssets();
  const ids = assets.map((a) => a.id);
  unwrap(await t.service.applyCommand(projectId, { type: 'set-review', assetIds: ids, state: 'keep' }));
  unwrap(await t.service.applyCommand(projectId, { type: 'set-rating', assetIds: ids, rating: 4 }));
  unwrap(await t.service.applyCommand(projectId, { type: 'set-pack-member', packId: 'edit', assetIds: ids, member: true }));
}, 300_000);

afterAll(async () => {
  await t?.service.shutdown();
});

describe('destination guard', () => {
  it('refuses a destination inside a source, inside the project, or reached through a junction into a source', async () => {
    expect(await t.service.planExport(projectId, 'edit', path.join(card, 'Card1'), 'copy-originals')).toMatchObject({ ok: false, code: 'DESTINATION_INSIDE_SOURCE' });
    expect(await t.service.planExport(projectId, 'edit', projectDir, 'copy-originals')).toMatchObject({ ok: false, code: 'DESTINATION_INSIDE_PROJECT' });
    const link = path.join(base, 'link-to-card');
    await symlink(path.join(card, 'Card2'), link, 'junction');
    expect(await t.service.planExport(projectId, 'edit', link, 'copy-originals')).toMatchObject({ ok: false, code: 'DESTINATION_INSIDE_SOURCE' });
  });
});

describe('copy originals', () => {
  let report: ExportReport;
  let outDir: string;
  let plan: ExportPlanView;

  beforeAll(async () => {
    const dest = path.join(base, 'Giao khách');
    await mkdir(dest);
    await writeFile(path.join(dest, 'tệp của người dùng.txt'), 'không được đụng vào');
    plan = unwrap(await t.service.planExport(projectId, 'edit', dest, 'copy-originals'))!;
    report = await runExport(plan.planId);
    outDir = path.join(dest, report.outputFolderName);
  }, 300_000);

  it('previews logical and physical counts, bytes, mapping and omissions before writing', () => {
    expect(plan.logicalCount).toBe(5);
    expect(plan.physicalCount).toBe(7); // 5 primaries + 1 companion JPEG + 1 existing sidecar
    expect(plan.projectedBytes).toBeGreaterThan(40 * 1024 * 1024);
    const names = plan.outputs.map((o) => o.outputName);
    const allCaseFoldedOutputPathsAreUnique = new Set(names.map((n) => n.normalize('NFC').toLowerCase())).size === names.length;
    expect(allCaseFoldedOutputPathsAreUnique).toBe(true);
    expect(plan.omissions.some((o) => o.includes('ACH07358') && o.includes('XMP'))).toBe(true);
    expect(plan.omissions.some((o) => o.includes('IMG_0001.DNG'))).toBe(true);
  });

  it('copies verified originals of a confirmed pair under one stem', async () => {
    expect(report.status).toBe('verified');
    const files = await readdir(outDir);
    const rawName = 'ACH07358.ARW';
    const jpegName = 'ACH07358.JPG';
    const exportedConfirmedPairFiles = files;
    expect(exportedConfirmedPairFiles).toEqual(expect.arrayContaining([rawName, jpegName]));
    const copiedRaw = path.join(outDir, rawName);
    const originalRaw = path.join(card, 'Card1', 'DCIM', rawName);
    expect(await sha256(copiedRaw)).toBe(await sha256(originalRaw));
    expect(files.some((f) => f.endsWith('.part'))).toBe(false);
  });

  it('copies an existing Develop XMP byte for byte instead of merging, and writes new XMP only where none existed', async () => {
    const existingDevelopXmpBeforeExport = DEVELOP_XMP;
    const existingDevelopXmpAfterExport = await readFile(path.join(outDir, 'ACH07358.xmp'), 'utf8');
    expect(existingDevelopXmpAfterExport).toBe(existingDevelopXmpBeforeExport);
    const generated = await readFile(path.join(outDir, 'ACH07383.xmp'), 'utf8');
    expect(generated).toContain('<xmp:Rating>4</xmp:Rating>');
    expect(generated).toContain('EventStory');
    const files = await readdir(outDir);
    expect(files).not.toContain('IMG_0001.xmp'); // DNG keeps its own metadata; decisions go to the manifest
    expect(files.filter((f) => f.toLowerCase().endsWith('.xmp'))).toHaveLength(3); // ACH07358 (copied), ACH07383, ach07358__… (generated)
  });

  it('writes a manifest with decisions and per-file verification', async () => {
    const manifest = JSON.parse(await readFile(path.join(outDir, 'eventstory-manifest.json'), 'utf8')) as {
      files: { outputName: string; status: string; sha256?: string }[];
      assets: { rating: number }[];
    };
    expect(manifest.files.every((f) => f.status === 'verified' && f.sha256)).toBe(true);
    expect(manifest.assets.every((a) => a.rating === 4)).toBe(true);
    expect(await readFile(path.join(outDir, 'eventstory-manifest.csv'), 'utf8')).toContain('output_name');
  });

  it('never touches the sources, existing user files, or the delivery history', async () => {
    expect(await sourceTreeDigest(card)).toBe(digestBefore);
    expect(await readFile(path.join(path.dirname(outDir), 'tệp của người dùng.txt'), 'utf8')).toBe('không được đụng vào');
    const deliveryEventsAfterExportOnly = unwrap(await t.service.listDeliveries(projectId));
    expect(deliveryEventsAfterExportOnly).toEqual([]);
  });
});

describe('failure modes', () => {
  it('refuses a plan whose selection changed after preview', async () => {
    const dest = await makeTempDir('dest-stale');
    const plan = unwrap(await t.service.planExport(projectId, 'edit', dest, 'manifest'))!;
    unwrap(await t.service.applyCommand(projectId, { type: 'set-pack-member', packId: 'edit', assetIds: [assets[0]!.id], member: false }));
    expect(await t.service.executeExport(plan.planId)).toMatchObject({ ok: false, code: 'PLAN_STALE' });
    unwrap(await t.service.applyCommand(projectId, { type: 'set-pack-member', packId: 'edit', assetIds: [assets[0]!.id], member: true }));
  });

  it('reports a file that vanished (unplugged card) as failed, not as success', async () => {
    const dest = await makeTempDir('dest-unplug');
    const plan = unwrap(await t.service.planExport(projectId, 'edit', dest, 'copy-originals'))!;
    const victim = path.join(card, 'Card2', 'lẻ.jpg');
    await rename(victim, `${victim}.away`);
    try {
      const reportAfterUnplugOrDiskFull = await runExport(plan.planId);
      expect(reportAfterUnplugOrDiskFull.failed.length).toBeGreaterThan(0);
      expect(reportAfterUnplugOrDiskFull.failed[0]).toMatchObject({ status: 'failed', code: 'SOURCE_MISSING' });
      expect(reportAfterUnplugOrDiskFull.status).toBe('partial');
    } finally {
      await rename(`${victim}.away`, victim);
    }
  });

  it('fails a file whose source changes while it is being copied', async () => {
    const work = await makeTempDir('changing');
    const changing = path.join(work, 'card');
    await mkdir(changing);
    await copyFile(fx('jpeg-sony-a7c-2'), path.join(changing, 'A.JPG'));
    const dir = path.join(work, 'project');
    await mkdir(dir);
    const id = unwrap(await t.service.createProject(dir, 'Đổi')).id;
    await t.waitForJob(unwrap(await t.service.addSources(id, [changing])));
    const [a] = unwrap(await t.service.queryAssets(id, { offset: 0, limit: 10 })).items;
    unwrap(await t.service.applyCommand(id, { type: 'pin', packId: 'quick', assetIds: [a!.id], pinned: true }));
    const dest = path.join(work, 'out');
    await mkdir(dest);
    const store = t.service.projects.get(id)!.store;
    const plan = unwrap(await planExport(store, 'quick', dest, 'copy-originals'));
    const gen = executeExport(plan, new AbortController().signal);
    let step = await gen.next();
    while (!step.done) {
      if (step.value.phase === 'copied') await appendFile(path.join(changing, 'A.JPG'), 'x');
      step = await gen.next();
    }
    const sourceWasModifiedDuringCopyReport = step.value.failed[0];
    expect(sourceWasModifiedDuringCopyReport).toMatchObject({ status: 'failed', code: 'SOURCE_CHANGED_DURING_COPY' });
    expect(step.value.status).toBe('failed');
    const left = await readdir(path.join(dest, step.value.outputFolderName));
    expect(left.filter((f) => f.endsWith('.part') || f === 'A.JPG')).toEqual([]);
    await t.service.closeProject(id);
  });

  it('cancel removes only this job’s temporary files', async () => {
    const dest = await makeTempDir('dest-cancel');
    const store = t.service.projects.get(projectId)!.store;
    const plan = unwrap(await planExport(store, 'edit', dest, 'copy-originals'));
    const ac = new AbortController();
    const gen = executeExport(plan, ac.signal);
    let step = await gen.next();
    while (!step.done) {
      if (step.value.phase === 'copied') ac.abort();
      step = await gen.next();
    }
    expect(step.value.status).toBe('cancelled');
    expect(step.value.cancelled.length).toBeGreaterThan(0);
    const left = await readdir(path.join(dest, step.value.outputFolderName));
    expect(left.some((f) => f.endsWith('.part'))).toBe(false);
    expect(await sourceTreeDigest(card)).toBe(digestBefore);
  });
});

describe('portable session', () => {
  it('round-trips decisions to a new project and relinks sources by identity', async () => {
    const file = path.join(base, 'phien.eventstory.json');
    unwrap(await t.service.exportPortable(projectId, file));
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain(card); // no absolute personal paths
    const before = (await allAssets()).map((a) => ({ id: a.id, d: a.decision }));

    const dir2 = path.join(base, 'project-2');
    await mkdir(dir2);
    const snap = unwrap(await t.service.importPortable(file, dir2));
    const imported = unwrap(await t.service.queryAssets(snap.id, { offset: 0, limit: 200 })).items;
    expect(imported.every((a) => a.status === 'missing')).toBe(true);
    expect(imported.map((a) => ({ id: a.id, d: a.decision })).sort((x, y) => x.id.localeCompare(y.id))).toEqual(
      before.sort((x, y) => x.id.localeCompare(y.id)),
    );
    const state = unwrap(await t.service.getProjectState(snap.id));
    const result = unwrap(await t.service.relinkSource(snap.id, state.sources[0]!.id, card))!;
    expect(result.matched).toBe(7);
    expect(result.ambiguous).toBe(0);
    await t.waitFor((e) => e.kind === 'scan' && e.projectId === snap.id && e.phase === 'complete');
    const relinked = unwrap(await t.service.queryAssets(snap.id, { offset: 0, limit: 200 })).items;
    expect(relinked.every((a) => a.status === 'ready' || a.status === 'preview-small')).toBe(true);
    await t.service.closeProject(snap.id);
  });

  it('refuses a session file from a newer schema or a broken file', async () => {
    const future = path.join(base, 'future.json');
    await writeFile(future, JSON.stringify({ format: 'eventstory-session', schemaVersion: 2 }));
    const dir = path.join(base, 'project-future');
    await mkdir(dir);
    const futureSchemaImport = await t.service.importPortable(future, dir);
    expect(futureSchemaImport).toMatchObject({ ok: false, code: 'UNSUPPORTED_SCHEMA' });
    const broken = path.join(base, 'broken.json');
    await writeFile(broken, '{ not json');
    expect(await t.service.importPortable(broken, dir)).toMatchObject({ ok: false, code: 'INVALID_PORTABLE' });
  });
});

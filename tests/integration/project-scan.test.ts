import { DatabaseSync } from 'node:sqlite';
import { chmod, copyFile, mkdir, rename, symlink } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readPhotoMetadata } from '../../src/media/exiftool';
import type { AssetView, ProjectState } from '../../src/shared/contracts';
import { fixturePath, loadFixtures, requireVerifiedFixtures } from '../helpers/fixtures';
import { makeTempDir, sha256, sourceTreeDigest } from '../helpers/fs';
import { writeSyntheticJpeg } from '../helpers/images';
import { makeService, unwrap, type TestService } from '../helpers/service';

const fx = (id: string) => fixturePath(loadFixtures().find((e) => e.id === id)!);

async function allAssets(t: TestService, projectId: string): Promise<AssetView[]> {
  const out: AssetView[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = unwrap(await t.service.queryAssets(projectId, { offset, limit: 200 }));
    out.push(...page.items);
    if (out.length >= page.total) return out;
  }
}

let src: string;
let outside: string;
let projectDir: string;
let t: TestService;
let projectId: string;
let digestBeforeScan: string;

beforeAll(async () => {
  await requireVerifiedFixtures();
  const base = await makeTempDir('scan');
  src = path.join(base, 'Thẻ nhớ');
  outside = path.join(base, 'ngoài nguồn');
  await mkdir(path.join(src, 'Card A', 'DCIM'), { recursive: true });
  await mkdir(path.join(src, 'Card B', 'DCIM'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await copyFile(fx('arw-sony-a7c-1'), path.join(src, 'Card A', 'DCIM', 'ACH07358.ARW'));
  await copyFile(fx('jpeg-sony-a7c-1'), path.join(src, 'Card A', 'DCIM', 'ACH07358.JPG'));
  // Same basename, different folder and different content.
  await copyFile(fx('arw-sony-a7c-2'), path.join(src, 'Card B', 'DCIM', 'ACH07358.ARW'));
  await copyFile(fx('jpeg-no-exif'), path.join(src, 'Card B', 'ảnh cưới #1 (copy).jpg'));
  await writeSyntheticJpeg(path.join(outside, 'secret.jpg'));
  await symlink(outside, path.join(src, 'Card B', 'junction-ra-ngoài'), 'junction');
  // A read-only file must still be scanned.
  await chmod(path.join(src, 'Card A', 'DCIM', 'ACH07358.JPG'), 0o444);
  digestBeforeScan = await sourceTreeDigest(src);

  projectDir = path.join(base, 'project');
  await mkdir(projectDir);
  t = makeService();
  projectId = unwrap(await t.service.createProject(projectDir, 'Đám cưới Minh')).id;
  const jobId = unwrap(await t.service.addSources(projectId, [src]));
  expect(await t.waitForJob(jobId)).toBe('complete');
});

afterAll(async () => {
  await t?.service.shutdown();
});

describe('scan', () => {
  it('keeps two files with the same name in different folders as two assets', async () => {
    const assets = await allAssets(t, projectId);
    const twoEqualNamesInDifferentFolders = assets.filter((a) => a.primary.relativePath.endsWith('/ACH07358.ARW'));
    expect(new Set(twoEqualNamesInDifferentFolders.map((x) => x.id)).size).toBe(2);
  });

  it('does not follow a junction out of the source', async () => {
    const assets = await allAssets(t, projectId);
    expect(assets.some((a) => a.primary.relativePath.includes('secret'))).toBe(false);
    expect(assets).toHaveLength(4);
  });

  it('scans read-only files and Vietnamese names, and gives every asset a preview state', async () => {
    const assets = await allAssets(t, projectId);
    expect(assets.some((a) => a.primary.relativePath === 'Card B/ảnh cưới #1 (copy).jpg')).toBe(true);
    for (const a of assets) expect(['ready', 'preview-small'], a.primary.relativePath).toContain(a.status);
    const ro = assets.find((a) => a.primary.relativePath === 'Card A/DCIM/ACH07358.JPG')!;
    expect(ro.preview?.thumbUrl).toMatch(/^es-preview:\/\//);
  });

  it('does not change a single byte of the source tree', async () => {
    expect(await sourceTreeDigest(src)).toBe(digestBeforeScan);
  });

  it('rejects a query page larger than 200', async () => {
    expect(await t.service.queryAssets(projectId, { offset: 0, limit: 201 })).toMatchObject({ ok: false });
  });

  it('rescanning the same source does not duplicate records', async () => {
    const jobId = unwrap(await t.service.addSources(projectId, [src]));
    await t.waitForJob(jobId);
    expect(await allAssets(t, projectId)).toHaveLength(4);
  });

  it('refuses a source that contains the project folder', async () => {
    const parent = path.dirname(projectDir);
    expect(await t.service.addSources(projectId, [parent])).toMatchObject({ ok: false, code: 'SOURCE_OVERLAPS_PROJECT' });
  });
});

describe('persistence', () => {
  it('reopens with the same decisions', async () => {
    const assets = await allAssets(t, projectId);
    const [a, b] = assets;
    unwrap(await t.service.applyCommand(projectId, { type: 'set-rating', assetIds: [a!.id], rating: 4 }));
    unwrap(await t.service.applyCommand(projectId, { type: 'set-review', assetIds: [a!.id, b!.id], state: 'keep' }));
    unwrap(await t.service.applyCommand(projectId, { type: 'set-consent', assetIds: [b!.id], consent: 'allowed' }));
    const savedDecisions = (await allAssets(t, projectId)).map((x) => x.decision);
    unwrap(await t.service.closeProject(projectId));
    unwrap(await t.service.openProject(projectDir));
    const reopenedDecisions = (await allAssets(t, projectId)).map((x) => x.decision);
    expect(reopenedDecisions).toEqual(savedDecisions);
  });

  it('refuses a second writer on the same project', async () => {
    const other = makeService();
    const secondOpen = await other.service.openProject(projectDir);
    expect(secondOpen).toMatchObject({ ok: false, code: 'PROJECT_LOCKED' });
    await other.service.shutdown();
  });

  it('rejects an asset ID that belongs to another project', async () => {
    const otherDir = await makeTempDir('other-project');
    const otherId = unwrap(await t.service.createProject(otherDir, 'Khác')).id;
    const assets = await allAssets(t, projectId);
    const r = await t.service.applyCommand(otherId, { type: 'set-rating', assetIds: [assets[0]!.id], rating: 2 });
    expect(r).toMatchObject({ ok: false, code: 'UNKNOWN_ID' });
    await t.service.closeProject(otherId);
  });

  it('stores camera clock offsets in the project only, never in the file', async () => {
    const file = path.join(src, 'Card A', 'DCIM', 'ACH07358.ARW');
    const originalExifBeforeOffset = unwrap(await readPhotoMetadata(file));
    const shaBefore = await sha256(file);
    const state = unwrap(await t.service.getProjectState(projectId)) as ProjectState;
    const cam = state.cameras.find((c) => c.model === 'ILCE-7C')!;
    unwrap(await t.service.applyCommand(projectId, { type: 'set-camera-offset', cameraId: cam.cameraId, offsetSeconds: -3600 }));
    const originalExifAfterCameraOffset = unwrap(await readPhotoMetadata(file));
    expect(originalExifAfterCameraOffset).toEqual(originalExifBeforeOffset);
    expect(await sha256(file)).toBe(shaBefore);

    const asset = (await allAssets(t, projectId)).find((a) => a.primary.relativePath === 'Card A/DCIM/ACH07358.ARW')!;
    expect(asset.capturedLocal).toBe(originalExifBeforeOffset.capturedLocal);
    expect(asset.effectiveLocal).not.toBe(asset.capturedLocal);

    const before = unwrap(await t.service.getProjectState(projectId)) as ProjectState;
    const offsetBeforeProjectRestart = before.cameras.find((c) => c.cameraId === cam.cameraId)!.offsetSeconds;
    expect(offsetBeforeProjectRestart).toBe(-3600);
    unwrap(await t.service.closeProject(projectId));
    unwrap(await t.service.openProject(projectDir));
    const after = unwrap(await t.service.getProjectState(projectId)) as ProjectState;
    const offsetAfterProjectRestart = after.cameras.find((c) => c.cameraId === cam.cameraId)!.offsetSeconds;
    expect(offsetAfterProjectRestart).toBe(offsetBeforeProjectRestart);
  });

  it('refuses to open a project written by a newer schema', async () => {
    const dir = await makeTempDir('future-schema');
    const s = makeService();
    const id = unwrap(await s.service.createProject(dir, 'Tương lai')).id;
    await s.service.closeProject(id);
    const db = new DatabaseSync(path.join(dir, 'project.sqlite'));
    db.prepare("UPDATE meta SET value='99' WHERE key='schema_version'").run();
    db.close();
    expect(await s.service.openProject(dir)).toMatchObject({ ok: false, code: 'SCHEMA_TOO_NEW' });
    await s.service.shutdown();
  });
});

describe('source disconnect', () => {
  it('marks assets of a vanished source as missing and keeps their decisions', async () => {
    const base = await makeTempDir('disconnect');
    const card = path.join(base, 'SSD');
    await copyFile(fx('jpeg-sony-a7c-2'), (await mkdir(card, { recursive: true }), path.join(card, 'A.JPG')));
    const dir = path.join(base, 'project');
    await mkdir(dir);
    const s = makeService();
    const id = unwrap(await s.service.createProject(dir, 'Rút ổ'));
    await s.waitForJob(unwrap(await s.service.addSources(id.id, [card])));
    const [asset] = await allAssets(s, id.id);
    unwrap(await s.service.applyCommand(id.id, { type: 'set-review', assetIds: [asset!.id], state: 'keep' }));
    await s.service.closeProject(id.id);
    await rename(card, `${card}-unplugged`);
    unwrap(await s.service.openProject(dir));
    const [disconnectedSource] = await allAssets(s, id.id);
    expect(disconnectedSource!.status).toBe('missing');
    expect(disconnectedSource!.decision.state).toBe('keep');
    await s.service.shutdown();
  });
});

describe('cancel and resume', () => {
  it('stops recording results after cancel, then resumes without duplicates', async () => {
    const base = await makeTempDir('cancel');
    const card = path.join(base, 'card');
    for (let i = 0; i < 80; i++) {
      await writeSyntheticJpeg(path.join(card, `IMG_${String(i).padStart(4, '0')}.JPG`), { rgb: [i * 3, 100, 200 - i * 2] });
    }
    const dir = path.join(base, 'project');
    await mkdir(dir);
    const s = makeService();
    const id = unwrap(await s.service.createProject(dir, 'Hủy')).id;
    const jobId = unwrap(await s.service.addSources(id, [card]));
    await s.waitFor((e) => e.kind === 'scan' && e.jobId === jobId && e.phase === 'preview');
    unwrap(await s.service.cancelJob(jobId));
    const idsBeforeCancel = unwrap(s.service.getJob(id, jobId)).completedFileIds;
    expect(await s.waitForJob(jobId)).toBe('cancelled');
    await new Promise((r) => setTimeout(r, 1500));
    const cancelledJob = unwrap(s.service.getJob(id, jobId));
    expect(cancelledJob.state).toBe('cancelled');
    expect(cancelledJob.completedFileIds).toEqual(idsBeforeCancel);
    expect(idsBeforeCancel.length).toBeLessThan(80);

    const resume = unwrap(await s.service.addSources(id, [card]));
    expect(await s.waitForJob(resume)).toBe('complete');
    const assets = await allAssets(s, id);
    expect(assets).toHaveLength(80);
    expect(new Set(assets.map((a) => a.primary.relativePath)).size).toBe(80);
    expect(assets.every((a) => a.status === 'preview-small' || a.status === 'ready')).toBe(true);
    await s.service.shutdown();
  });
});

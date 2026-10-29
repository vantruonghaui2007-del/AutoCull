import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssetView, PairCandidate } from '../../src/shared/contracts';
import { fixturePath, loadFixtures, requireVerifiedFixtures } from '../helpers/fixtures';
import { makeTempDir } from '../helpers/fs';
import { makeService, unwrap, type TestService } from '../helpers/service';

const fx = (id: string) => fixturePath(loadFixtures().find((e) => e.id === id)!);
const services: TestService[] = [];
const svc = () => {
  const s = makeService();
  services.push(s);
  return s;
};
async function all(t: TestService, id: string): Promise<AssetView[]> {
  return unwrap(await t.service.queryAssets(id, { offset: 0, limit: 200 })).items;
}
async function project(t: TestService, name: string, card: string): Promise<string> {
  const dir = path.join(await makeTempDir('fix-project'), 'p');
  await mkdir(dir);
  const id = unwrap(await t.service.createProject(dir, name)).id;
  await t.waitForJob(unwrap(await t.service.addSources(id, [card])));
  return id;
}

beforeAll(async () => {
  await requireVerifiedFixtures();
});
afterAll(async () => {
  for (const s of services) await s.service.shutdown();
});

describe('C1: a different photo at a known path never inherits decisions', () => {
  it('retires the old asset (missing, decisions kept) and indexes the new content as a new unreviewed asset', async () => {
    const t = svc();
    const card = path.join(await makeTempDir('reused-card'), 'DCIM');
    await mkdir(card, { recursive: true });
    await copyFile(fx('jpeg-sony-a7c-1'), path.join(card, 'IMG_0001.JPG'));
    const id = await project(t, 'Thẻ dùng lại', card);
    const [old] = await all(t, id);
    unwrap(await t.service.applyCommand(id, { type: 'pin', packId: 'quick', assetIds: [old!.id], pinned: true }));
    unwrap(await t.service.applyCommand(id, { type: 'set-rating', assetIds: [old!.id], rating: 5 }));

    // Another card (or a reformatted one) with a different photo under the same name.
    await rm(path.join(card, 'IMG_0001.JPG'));
    await copyFile(fx('jpeg-sony-a7c-2'), path.join(card, 'IMG_0001.JPG'));
    await t.waitForJob(unwrap(await t.service.addSources(id, [card])));
    const after = await all(t, id);
    expect(after).toHaveLength(2);
    const retired = after.find((a) => a.id === old!.id)!;
    expect(retired.status).toBe('missing');
    expect(retired.decision).toMatchObject({ state: 'keep', rating: 5 });
    const fresh = after.find((a) => a.id !== old!.id)!;
    expect(fresh.primary.relativePath).toBe('IMG_0001.JPG');
    expect(fresh.decision).toMatchObject({ state: 'unreviewed', rating: 0 });
    expect(fresh.packs.quick).toEqual({ member: false, pinned: false });
    expect(t.events.some((e) => e.kind === 'scan' && e.phase === 'file-error' && /khác/.test(e.message ?? ''))).toBe(true);
  });
});

describe('I1: an interrupted walk is reported and does not mark unseen files missing', () => {
  it('keeps files of an unreadable folder and finishes with errors reported', async () => {
    const t = svc();
    const root = path.join(await makeTempDir('locked'), 'card');
    const locked = path.join(root, 'locked');
    await mkdir(locked, { recursive: true });
    await copyFile(fx('jpeg-sony-a7c-1'), path.join(locked, 'A.JPG'));
    await copyFile(fx('jpeg-sony-a7c-2'), path.join(root, 'B.JPG'));
    const id = await project(t, 'Khóa', root);
    const deny = () =>
      process.platform === 'win32'
        ? execFileSync('icacls', [locked, '/deny', `${os.userInfo().username}:(OI)(CI)(RX)`], { stdio: 'ignore' })
        : chmod(locked, 0o000);
    const allow = () =>
      process.platform === 'win32' ? execFileSync('icacls', [locked, '/remove:d', os.userInfo().username], { stdio: 'ignore' }) : chmod(locked, 0o755);
    await deny();
    try {
      const job = unwrap(await t.service.addSources(id, [root]));
      await t.waitForJob(job);
      const done = t.events.filter((e) => e.kind === 'scan' && e.jobId === job && e.phase === 'complete').pop() as { message?: string };
      expect(done.message).toMatch(/lỗi/);
      expect(unwrap(t.service.getJob(id, job)).state).toBe('complete-with-errors');
      const a = (await all(t, id)).find((x) => x.primary.relativePath === 'locked/A.JPG')!;
      expect(a.status).not.toBe('missing');
    } finally {
      await allow();
    }
  });
});

describe('I2: pairing needs evidence, and confirming during a scan does not break it', () => {
  it('does not offer a pair as clean before both files have metadata', async () => {
    const { findPairCandidates } = await import('../../src/culling/decisions');
    const base = { sourceId: 's_1', paired: false, metadataRead: true, serial: null } as const;
    const c = findPairCandidates([
      { ...base, fileId: 'f_1', assetId: 'a_1', relativePath: 'A.ARW', kind: 'raw', model: null, capturedLocal: null, metadataRead: false },
      { ...base, fileId: 'f_2', assetId: 'a_2', relativePath: 'A.JPG', kind: 'jpeg', model: 'X', capturedLocal: '2026-01-01T00:00:00' },
    ]);
    expect(c[0]!.ambiguous).toBe(true);
    const s = findPairCandidates([
      { ...base, fileId: 'f_1', assetId: 'a_1', relativePath: 'A.ARW', kind: 'raw', model: 'X', capturedLocal: '2026-01-01T00:00:00', serial: '111' },
      { ...base, fileId: 'f_2', assetId: 'a_2', relativePath: 'A.JPG', kind: 'jpeg', model: 'X', capturedLocal: '2026-01-01T00:00:00', serial: '222' },
    ]);
    expect(s[0]).toMatchObject({ ambiguous: true, reason: 'Khác số máy' });
  });

  it('a scan keeps going when pairs are confirmed while JPEG previews are still queued', async () => {
    const t = makeService(8 * 1024 ** 3); // 1 image job: previews lag behind metadata
    services.push(t);
    const card = path.join(await makeTempDir('pair-during-scan'), 'card');
    await mkdir(card);
    for (let i = 0; i < 8; i++) {
      await copyFile(fx('arw-sony-a7c-1'), path.join(card, `P${i}.ARW`));
      await copyFile(fx('jpeg-sony-a7c-1'), path.join(card, `P${i}.JPG`));
    }
    const dir = path.join(await makeTempDir('pds-project'), 'p');
    await mkdir(dir);
    const id = unwrap(await t.service.createProject(dir, 'Ghép khi quét')).id;
    const job = unwrap(await t.service.addSources(id, [card]));
    await t.waitFor((e) => e.kind === 'scan' && e.jobId === job && e.phase === 'preview');
    let clean: PairCandidate[] = [];
    for (let i = 0; i < 50 && clean.length === 0; i++) {
      clean = (unwrap(await t.service.listPairCandidates(id)) as PairCandidate[]).filter((c) => !c.ambiguous);
      if (!clean.length) await new Promise((r) => setTimeout(r, 100));
    }
    expect(clean.length).toBeGreaterThan(0);
    unwrap(await t.service.applyCommand(id, { type: 'confirm-pairs', pairs: clean.map((c) => ({ rawId: c.rawId, jpegId: c.jpegId })) }));
    expect(await t.waitForJob(job)).toBe('complete');
    expect(unwrap(t.service.getJob(id, job)).state).toMatch(/^complete/);
  });
});

describe('I4: shutting down during an export cancels it cleanly', () => {
  it('removes temp files and leaves a manifest marked cancelled or verified', async () => {
    const t = makeService();
    const card = path.join(await makeTempDir('quit-export'), 'card');
    await mkdir(card);
    for (const fid of ['raf-fuji-xt3', 'cr2-canon-5d3', 'dng-adobe-5d3', 'nef-nikon-d750']) await copyFile(fx(fid), path.join(card, path.basename(fx(fid))));
    const id = await project(t, 'Thoát khi xuất', card);
    const ids = (await all(t, id)).map((a) => a.id);
    unwrap(await t.service.applyCommand(id, { type: 'set-pack-member', packId: 'edit', assetIds: ids, member: true }));
    const dest = await makeTempDir('quit-dest');
    const plan = unwrap(await t.service.planExport(id, 'edit', dest, 'copy-originals'))!;
    unwrap(await t.service.executeExport(plan.planId));
    await t.waitFor((e) => e.kind === 'export' && e.phase === 'copying');
    unwrap(await t.service.shutdown());
    const [folder] = await readdir(dest);
    const files = await readdir(path.join(dest, folder!));
    expect(files.some((f) => f.endsWith('.part'))).toBe(false);
    const manifest = JSON.parse(await readFile(path.join(dest, folder!, 'eventstory-manifest.json'), 'utf8')) as { status: string };
    expect(['cancelled', 'verified']).toContain(manifest.status);
  });
});

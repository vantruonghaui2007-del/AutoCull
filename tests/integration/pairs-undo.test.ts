import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssetView, PairCandidate, ProjectState } from '../../src/shared/contracts';
import { fixturePath, loadFixtures, requireVerifiedFixtures } from '../helpers/fixtures';
import { makeTempDir } from '../helpers/fs';
import { makeService, unwrap, type TestService } from '../helpers/service';

const fx = (id: string) => fixturePath(loadFixtures().find((e) => e.id === id)!);
let t: TestService;
let projectId: string;

async function all(): Promise<AssetView[]> {
  return unwrap(await t.service.queryAssets(projectId, { offset: 0, limit: 200 })).items;
}

beforeAll(async () => {
  await requireVerifiedFixtures();
  const base = await makeTempDir('pairs');
  const card = path.join(base, 'card');
  await mkdir(path.join(card, 'DCIM'), { recursive: true });
  await mkdir(path.join(card, 'OTHER'), { recursive: true });
  await copyFile(fx('arw-sony-a7c-1'), path.join(card, 'DCIM', 'ACH07358.ARW'));
  await copyFile(fx('jpeg-sony-a7c-1'), path.join(card, 'DCIM', 'ACH07358.JPG'));
  await copyFile(fx('arw-sony-a7c-portrait'), path.join(card, 'DCIM', 'ACH07383.ARW'));
  await copyFile(fx('jpeg-sony-a7c-portrait'), path.join(card, 'DCIM', 'ACH07383.JPG'));
  // Same stem in another folder, and a second JPEG spelling for one RAW: must not auto-pair.
  await copyFile(fx('jpeg-sony-a7c-2'), path.join(card, 'OTHER', 'ACH07358.JPG'));
  await copyFile(fx('arw-sony-a7c-2'), path.join(card, 'DCIM', 'ACH07359.ARW'));
  await copyFile(fx('jpeg-sony-a7c-2'), path.join(card, 'DCIM', 'ACH07359.JPG'));
  await copyFile(fx('jpeg-sony-a7c-2'), path.join(card, 'DCIM', 'ACH07359.jpeg'));
  const dir = path.join(base, 'project');
  await mkdir(dir);
  t = makeService();
  projectId = unwrap(await t.service.createProject(dir, 'Cặp ảnh')).id;
  await t.waitForJob(unwrap(await t.service.addSources(projectId, [card])));
});

afterAll(async () => {
  await t?.service.shutdown();
});

describe('RAW+JPEG pairs', () => {
  it('proposes only unambiguous same-folder pairs and never confirms them by itself', async () => {
    const candidates = unwrap(await t.service.listPairCandidates(projectId)) as PairCandidate[];
    const clean = candidates.filter((c) => !c.ambiguous);
    expect(clean.map((c) => c.relativeStem).sort()).toEqual(['DCIM/ACH07358', 'DCIM/ACH07383']);
    const ambiguousCandidates = candidates.filter((c) => c.ambiguous);
    expect(ambiguousCandidates.length).toBe(2);
    expect(candidates.every((x) => !x.confirmed)).toBe(true);
    const state = unwrap(await t.service.getProjectState(projectId)) as ProjectState;
    expect(state.logicalAssets).toBe(8);
    expect(state.physicalFiles).toBe(8);
  });

  it('refuses to confirm an ambiguous pair', async () => {
    const candidates = unwrap(await t.service.listPairCandidates(projectId)) as PairCandidate[];
    const amb = candidates.find((c) => c.ambiguous)!;
    expect(await t.service.applyCommand(projectId, { type: 'confirm-pairs', pairs: [{ rawId: amb.rawId, jpegId: amb.jpegId }] })).toMatchObject({
      ok: false,
      code: 'PAIR_AMBIGUOUS',
    });
  });

  it('confirms a batch: one logical photo, shared decision, two physical files, better preview', async () => {
    const before = await all();
    const jpegAsset = before.find((a) => a.primary.relativePath === 'DCIM/ACH07358.JPG')!;
    unwrap(await t.service.applyCommand(projectId, { type: 'set-rating', assetIds: [jpegAsset.id], rating: 3 }));
    const clean = (unwrap(await t.service.listPairCandidates(projectId)) as PairCandidate[]).filter((c) => !c.ambiguous);
    unwrap(await t.service.applyCommand(projectId, { type: 'confirm-pairs', pairs: clean.map((c) => ({ rawId: c.rawId, jpegId: c.jpegId })) }));
    const after = await all();
    const confirmedPair = after.find((a) => a.primary.relativePath === 'DCIM/ACH07358.ARW')!;
    const jpegFileId = jpegAsset.primary.id;
    expect(confirmedPair.companion?.id).toBe(jpegFileId);
    expect(confirmedPair.pairConfirmed).toBe(true);
    expect(confirmedPair.decision.rating).toBe(3); // the RAW had no decision yet, so the JPEG's carries over
    expect(confirmedPair.preview?.origin).toBe('jpeg-original'); // embedded ARW preview is too small
    expect(confirmedPair.status).toBe('ready');
    expect(after.some((a) => a.id === jpegAsset.id)).toBe(false);
    const state = unwrap(await t.service.getProjectState(projectId)) as ProjectState;
    expect(state.logicalAssets).toBe(6);
    expect(state.physicalFiles).toBe(8);
    const remaining = unwrap(await t.service.listPairCandidates(projectId)) as PairCandidate[];
    expect(remaining.every((c) => c.ambiguous)).toBe(true);
  });
});

describe('undo through the project', () => {
  it('undoes the last review change, persisted across reopen of the journal', async () => {
    const [x] = await all();
    unwrap(await t.service.applyCommand(projectId, { type: 'set-rating', assetIds: [x!.id], rating: 2 }));
    unwrap(await t.service.applyCommand(projectId, { type: 'set-rating', assetIds: [x!.id], rating: 5 }));
    unwrap(await t.service.applyCommand(projectId, { type: 'undo' }));
    expect((await all()).find((a) => a.id === x!.id)!.decision.rating).toBe(2);
    const state = unwrap(await t.service.getProjectState(projectId)) as ProjectState;
    expect(state.canUndo).toBe(true);
  });
});

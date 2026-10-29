import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssetView, DeliveryEvent, PackSuggestion, ProjectState } from '../../src/shared/contracts';
import { fixturePath, loadFixtures, requireVerifiedFixtures } from '../helpers/fixtures';
import { makeTempDir } from '../helpers/fs';
import { makeService, unwrap, type TestService } from '../helpers/service';

const fx = (id: string) => fixturePath(loadFixtures().find((e) => e.id === id)!);
let t: TestService;
let projectId: string;
let assets: AssetView[];

const members = async (packId: 'quick' | 'edit') => unwrap(await t.service.queryAssets(projectId, { offset: 0, limit: 200, packId })).items.map((a) => a.id).sort();

beforeAll(async () => {
  await requireVerifiedFixtures();
  const base = await makeTempDir('delivery');
  const card = path.join(base, 'card');
  await mkdir(card, { recursive: true });
  for (const id of ['jpeg-sony-a7c-1', 'jpeg-sony-a7c-2', 'jpeg-sony-a7c-portrait', 'cr2-canon-5d3']) await copyFile(fx(id), path.join(card, path.basename(fx(id))));
  const dir = path.join(base, 'project');
  await mkdir(dir);
  t = makeService();
  projectId = unwrap(await t.service.createProject(dir, 'Bàn giao')).id;
  await t.waitForJob(unwrap(await t.service.addSources(projectId, [card])));
  assets = unwrap(await t.service.queryAssets(projectId, { offset: 0, limit: 200 })).items;
  unwrap(await t.service.applyCommand(projectId, { type: 'set-review', assetIds: assets.map((a) => a.id), state: 'keep' }));
});

afterAll(async () => {
  await t?.service.shutdown();
});

describe('suggestions', () => {
  it('suggesting does not change membership; accepting is a separate command', async () => {
    unwrap(await t.service.applyCommand(projectId, { type: 'set-pack-rule', packId: 'quick', limit: 2, targetIds: [] }));
    const before = await members('quick');
    const s = unwrap(await t.service.suggestPack(projectId, 'quick')) as PackSuggestion;
    expect(s.suggestedIds).toHaveLength(2);
    expect(await members('quick')).toEqual(before);
    unwrap(await t.service.applyCommand(projectId, { type: 'accept-suggestion', packId: 'quick', assetIds: s.suggestedIds }));
    expect(await members('quick')).toEqual([...s.suggestedIds].sort());
    const state = unwrap(await t.service.getProjectState(projectId)) as ProjectState;
    expect(state.packCounts.quick.members).toBe(2);
    expect(state.packCounts.edit.members).toBe(0);
  });

  it('rejects targets that do not exist', async () => {
    const r = await t.service.applyCommand(projectId, {
      type: 'set-pack-rule',
      packId: 'quick',
      limit: 2,
      targetIds: ['t_00000000-0000-4000-8000-000000000999'],
    });
    expect(r).toMatchObject({ ok: false, code: 'UNKNOWN_ID' });
  });
});

describe('delivery history', () => {
  it('records nothing until the photographer confirms', async () => {
    expect(unwrap(await t.service.listDeliveries(projectId))).toEqual([]);
  });

  it('keeps an immutable snapshot and records corrections as new events', async () => {
    const quick = await members('quick');
    unwrap(await t.service.applyCommand(projectId, { type: 'confirm-delivery', packId: 'quick', assetIds: quick }));
    const [originalDelivery] = unwrap(await t.service.listDeliveries(projectId)) as DeliveryEvent[];
    const originalDeliverySnapshot = structuredClone(originalDelivery!);
    expect(originalDelivery!.assetIds.sort()).toEqual(quick);
    expect(Object.keys(originalDelivery!.fileFingerprints)).toHaveLength(2);

    // Later changes to the selection do not rewrite history.
    unwrap(await t.service.applyCommand(projectId, { type: 'set-pack-member', packId: 'quick', assetIds: [quick[0]!], member: false }));
    unwrap(await t.service.applyCommand(projectId, { type: 'set-rating', assetIds: quick, rating: 1 }));
    const [deliverySnapshotAfterLaterSelectionChange] = unwrap(await t.service.listDeliveries(projectId)) as DeliveryEvent[];
    expect(deliverySnapshotAfterLaterSelectionChange).toEqual(originalDeliverySnapshot);

    unwrap(await t.service.applyCommand(projectId, { type: 'correct-delivery', eventId: originalDelivery!.id, assetIds: [quick[1]!] }));
    const events = unwrap(await t.service.listDeliveries(projectId)) as DeliveryEvent[];
    expect(events).toHaveLength(2);
    const correction = events[1]!;
    expect(correction.correctsEventId).toBe(originalDelivery!.id);
    expect(events[0]).toEqual(originalDeliverySnapshot);
  });

  it('cannot be undone or edited through the review journal', async () => {
    const before = unwrap(await t.service.listDeliveries(projectId));
    unwrap(await t.service.applyCommand(projectId, { type: 'undo' }));
    expect(unwrap(await t.service.listDeliveries(projectId))).toEqual(before);
  });

  it('rejects correcting an event that does not exist', async () => {
    expect(
      await t.service.applyCommand(projectId, { type: 'correct-delivery', eventId: 'd_00000000-0000-4000-8000-000000000999', assetIds: [] }),
    ).toMatchObject({ ok: false, code: 'UNKNOWN_ID' });
  });
});

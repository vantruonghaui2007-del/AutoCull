import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssetView } from '../../src/shared/contracts';
import { makeTempDir } from '../helpers/fs';
import { writeSyntheticJpeg } from '../helpers/images';
import { makeService, unwrap, type TestService } from '../helpers/service';

let t: TestService;
let projectId: string;
const all = async (): Promise<AssetView[]> => unwrap(await t.service.queryAssets(projectId, { offset: 0, limit: 200 })).items;
const groupCount = async () => new Set((await all()).map((a) => a.groupId)).size;

beforeAll(async () => {
  const base = await makeTempDir('preset');
  const card = path.join(base, 'card');
  const cam = { width: 320, height: 214, make: 'TEST', model: 'PRESET', serial: '9', rgb: [70, 110, 150] as [number, number, number] };
  for (const [i, sec] of [0, 3, 6].entries()) await writeSyntheticJpeg(path.join(card, `P${i}.JPG`), { ...cam, dateTimeOriginal: `2026:10:01 10:00:0${sec}`, squareAt: 100 + i });
  const dir = path.join(base, 'project');
  await mkdir(dir);
  t = makeService();
  projectId = unwrap(await t.service.createProject(dir, 'Preset')).id;
  await t.waitForJob(unwrap(await t.service.addSources(projectId, [card])));
}, 120_000);

afterAll(async () => {
  await t?.service.shutdown();
});

describe('grouping presets', () => {
  it('a new project uses the event preset (frames 3 s apart are one group)', async () => {
    expect(unwrap(await t.service.getCullState(projectId)).groupingPreset).toBe('event-v2');
    expect(await groupCount()).toBe(1);
  });

  it('a project on the old preset keeps 2 s grouping until the user re-runs with the event preset', async () => {
    t.service.projects.get(projectId)!.store.setMeta('grouping_preset', 'group-v1');
    unwrap(await t.service.applyCommand(projectId, { type: 'regroup' }));
    expect(await groupCount()).toBe(3);
    unwrap(await t.service.applyCommand(projectId, { type: 'regroup', preset: 'event-v2' }));
    expect(await groupCount()).toBe(1);
    expect(unwrap(await t.service.getCullState(projectId)).groupingPreset).toBe('event-v2');
  });

  it('decisions survive a regroup', async () => {
    const id = (await all())[0]!.id;
    unwrap(await t.service.applyCommand(projectId, { type: 'set-review', assetIds: [id], state: 'keep' }));
    unwrap(await t.service.applyCommand(projectId, { type: 'regroup', preset: 'group-v1' }));
    expect((await all()).find((a) => a.id === id)!.decision.state).toBe('keep');
  });
});

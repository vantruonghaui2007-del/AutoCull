import { DatabaseSync } from 'node:sqlite';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import schemaV1 from '../../src/project/schema.sql?raw';
import { ProjectStore, SCHEMA_VERSION } from '../../src/project/store';
import { makeTempDir } from '../helpers/fs';
import { makeService, unwrap, type TestService } from '../helpers/service';
import { fixturePath, loadFixtures } from '../helpers/fixtures';

const services: TestService[] = [];
afterAll(async () => {
  for (const s of services) await s.service.shutdown();
});

/** Builds a project exactly as v0.1 wrote it: schema v1 only, with a decision and an undo entry. */
async function makeV1Project(): Promise<{ dir: string; assetId: string }> {
  const dir = path.join(await makeTempDir('v1-project'), 'p');
  await mkdir(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'project.sqlite'));
  db.exec(schemaV1);
  const put = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  put.run('schema_version', '1');
  put.run('project_id', 'p_00000000-0000-4000-8000-000000000001');
  put.run('name', 'Dự án v1');
  put.run('created_at', '2026-10-01T00:00:00Z');
  db.prepare("INSERT INTO pack_rule VALUES ('quick', 12, '[]'), ('edit', 120, '[]')").run();
  db.prepare("INSERT INTO source VALUES ('s_00000000-0000-4000-8000-000000000001', 'card', ?, '2026-10-01', 1)").run(path.join(dir, '..', 'card'));
  db.prepare(
    "INSERT INTO file (id, source_id, relative_path, rel_key, kind, bytes, mtime_ms, sampled_hash) VALUES ('f_00000000-0000-4000-8000-000000000001', 's_00000000-0000-4000-8000-000000000001', 'A.JPG', 'A.JPG', 'jpeg', 10, 0, ?)",
  ).run('0'.repeat(64));
  const assetId = 'a_00000000-0000-4000-8000-000000000001';
  db.prepare("INSERT INTO asset (id, primary_file_id, media_status, seq) VALUES (?, 'f_00000000-0000-4000-8000-000000000001', 'ready', 1)").run(assetId);
  db.prepare("INSERT INTO decision VALUES (?, 'keep', 4, 'allowed', '[]')").run(assetId);
  db.prepare("INSERT INTO undo (at, command, before) VALUES ('2026-10-01', '{\"type\":\"set-rating\"}', '{}')").run();
  db.close();
  return { dir, assetId };
}

describe('schema migration v1 → v2', () => {
  it('upgrades in place, keeps decisions and undo, and leaves a consistent backup', async () => {
    const { dir, assetId } = await makeV1Project();
    const opened = ProjectStore.open(dir);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const store = opened.value;
    expect(SCHEMA_VERSION).toBe(2);
    expect(store.schemaVersion()).toBe(2);
    expect(store.decision(assetId)).toMatchObject({ state: 'keep', rating: 4, consent: 'allowed' });
    expect(store.meta('grouping_preset')).toBe('group-v1');
    expect(store.canUndo()).toBe(true);
    store.close();
    const backups = (await readdir(dir)).filter((f) => /^project\.v1-backup-.*\.sqlite$/.test(f));
    expect(backups).toHaveLength(1);
    const b = new DatabaseSync(path.join(dir, backups[0]!), { readOnly: true });
    expect((b.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value).toBe('1');
    expect(b.prepare('SELECT rating FROM decision').get()).toMatchObject({ rating: 4 });
    b.close();
  });

  it('rolls back and keeps the v1 file untouched when the migration fails', async () => {
    const { dir } = await makeV1Project();
    // Sabotage: a table name the migration needs to create already exists with another shape.
    const db = new DatabaseSync(path.join(dir, 'project.sqlite'));
    db.exec('CREATE TABLE face_analysis (oops INTEGER)');
    db.close();
    const r = ProjectStore.open(dir);
    expect(r).toMatchObject({ ok: false, code: 'MIGRATION_FAILED' });
    const after = new DatabaseSync(path.join(dir, 'project.sqlite'), { readOnly: true });
    expect((after.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value).toBe('1');
    expect(after.prepare('SELECT rating FROM decision').get()).toMatchObject({ rating: 4 });
    after.close();
    // The lock is released so the user can retry after fixing the cause.
    expect((await readdir(dir)).includes('project.lock')).toBe(false);
  });

  it('a migrated project still scans, undoes and exports portable sessions', async () => {
    const { dir } = await makeV1Project();
    const card = path.join(dir, '..', 'card');
    await mkdir(card, { recursive: true });
    await copyFile(fixturePath(loadFixtures().find((e) => e.id === 'jpeg-sony-a7c-1')!), path.join(card, 'B.JPG'));
    await writeFile(path.join(card, 'A.JPG'), 'not really a jpeg');
    const t = makeService();
    services.push(t);
    const id = unwrap(await t.service.openProject(dir)).id;
    await t.waitForJob(unwrap(await t.service.addSources(id, [card])));
    const items = unwrap(await t.service.queryAssets(id, { offset: 0, limit: 50 })).items;
    // The v1 record of A.JPG had a different content sample, so it is retired (kept with its decision) and A.JPG is re-indexed.
    expect(items.length).toBe(3);
    expect(items.find((a) => a.id === 'a_00000000-0000-4000-8000-000000000001')).toMatchObject({ status: 'missing', decision: { state: 'keep', rating: 4 } });
    unwrap(await t.service.applyCommand(id, { type: 'set-rating', assetIds: [items[0]!.id], rating: 1 }));
    unwrap(await t.service.applyCommand(id, { type: 'undo' }));
    unwrap(await t.service.exportPortable(id, path.join(dir, '..', 'session.json')));
  });
});

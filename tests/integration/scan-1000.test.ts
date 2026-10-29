import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AssetView } from '../../src/shared/contracts';
import { makeTempDir, workRoot } from '../helpers/fs';
import { writeSyntheticJpeg } from '../helpers/images';
import { makeService, unwrap, type TestService } from '../helpers/service';

// Queue behaviour with 1,000 small synthetic JPEGs added in several batches.
// This is not a RAW performance benchmark.
let base: string;
let t: TestService;
const batches = ['lo-1', 'lo-2', 'lo-3', 'lo-4'];

beforeAll(async () => {
  base = await makeTempDir('scan1000');
  let n = 0;
  for (const b of batches) {
    for (let i = 0; i < 250; i++, n++) {
      await writeSyntheticJpeg(path.join(base, 'cards', b, `DSC_${String(n).padStart(5, '0')}.JPG`), {
        width: 64,
        height: 48,
        rgb: [(n * 7) % 200, (n * 3) % 200, (n * 11) % 200],
        make: 'TEST',
        model: 'SYNTH',
        dateTimeOriginal: `2026:10:01 10:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`,
      });
    }
  }
  t = makeService();
}, 600_000);

afterAll(async () => {
  await t?.service.shutdown();
});

it('scans 1,000 files in batches with early progress, cancel/resume and paged queries', async () => {
  const projectDir = path.join(base, 'project');
  await mkdir(projectDir);
  const started = Date.now();
  const id = unwrap(await t.service.createProject(projectDir, '1000 ảnh')).id;
  const root = (b: string) => path.join(base, 'cards', b);

  const jobA = unwrap(await t.service.addSources(id, [root('lo-1')]));
  const jobB = unwrap(await t.service.addSources(id, [root('lo-2')]));
  const firstProgress = await t.waitFor((e) => e.kind === 'scan' && e.jobId === jobA && e.phase === 'discovered');
  const firstProgressMs = Date.now() - started;
  expect(t.events.some((e) => e.kind === 'scan' && e.jobId === jobA && e.phase === 'complete')).toBe(false);
  expect(firstProgress).toBeTruthy();

  await t.waitFor((e) => e.kind === 'scan' && e.jobId === jobB && e.phase === 'preview');
  unwrap(await t.service.cancelJob(jobB));
  expect(await t.waitForJob(jobB)).toBe('cancelled');
  expect(await t.waitForJob(jobA)).toBe('complete');

  const jobC = unwrap(await t.service.addSources(id, [root('lo-3'), root('lo-4')]));
  const resumeB = unwrap(await t.service.addSources(id, [root('lo-2')]));
  expect(await t.waitForJob(jobC, 600_000)).toBe('complete');
  expect(await t.waitForJob(resumeB, 600_000)).toBe('complete');
  const totalMs = Date.now() - started;

  const all: AssetView[] = [];
  let pages = 0;
  for (let offset = 0; ; offset += 200) {
    const page = unwrap(await t.service.queryAssets(id, { offset, limit: 200 }));
    expect(page.items.length).toBeLessThanOrEqual(200);
    pages++;
    all.push(...page.items);
    if (all.length >= page.total) break;
  }
  expect(all).toHaveLength(1000);
  expect(new Set(all.map((a) => a.id)).size).toBe(1000);
  expect(pages).toBe(5);
  expect(all.every((a) => a.preview !== null)).toBe(true);
  expect(await t.service.queryAssets(id, { offset: 0, limit: 500 })).toMatchObject({ ok: false });

  await mkdir(path.join(workRoot, 'reports'), { recursive: true });
  await writeFile(
    path.join(workRoot, 'reports', `scan-1000-${process.platform}-${process.arch}.json`),
    `${JSON.stringify({ at: new Date().toISOString(), files: 1000, kind: 'synthetic 64x48 JPEG', firstProgressMs, totalMs, budget: (await t.service.status()).ok }, null, 2)}\n`,
  );
}, 900_000);

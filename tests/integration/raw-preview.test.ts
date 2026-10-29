import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeExifTool, exiftoolVersion, readPhotoMetadata } from '../../src/media/exiftool';
import { extractPreview, MAX_PREVIEW_BYTES, MAX_PREVIEW_PIXELS, withinDecodeLimits } from '../../src/media/previews';
import { MediaQueue } from '../../src/worker/queue';
import { resourceBudget } from '../../src/worker/service';
import { makeTempDir, sha256, workRoot } from '../helpers/fs';
import { fixturePath, requireVerifiedFixtures, type FixtureEntry } from '../helpers/fixtures';

let entries: FixtureEntry[];
let cacheRoot: string;
const reportRows: Record<string, unknown>[] = [];

beforeAll(async () => {
  entries = await requireVerifiedFixtures();
  cacheRoot = await makeTempDir('preview-cache');
});

afterAll(async () => {
  const helper = await exiftoolVersion().catch(() => null);
  await closeExifTool();
  const dir = path.join(workRoot, 'reports');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `raw-support-${process.platform}-${process.arch}.json`),
    `${JSON.stringify({ at: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version, exiftool: helper, sharp: sharp.versions, rows: reportRows }, null, 2)}\n`,
  );
});

describe('fixture coverage', () => {
  it('has verified real samples for every target format', () => {
    const supportedFixtureKinds = [...new Set(entries.filter((e) => e.expectedPreview !== 'NO_PREVIEW').map((e) => e.kind))];
    expect(supportedFixtureKinds).toEqual(expect.arrayContaining(['cr2', 'cr3', 'nef', 'arw', 'dng', 'raf', 'jpeg']));
  });

  it('reports the bundled ExifTool version', async () => {
    expect(await exiftoolVersion()).toMatch(/^\d+\.\d+/);
  });
});

describe('extractPreview on real camera files', () => {
  const cases = () => entries.filter((e) => e.expectedPreview !== 'NO_PREVIEW');

  it('extracts the expected preview, with correct orientation, without touching the original', async () => {
    for (const e of cases()) {
      const source = fixturePath(e);
      const expectedOriginalSha = e.sha256;
      expect(await sha256(source)).toBe(expectedOriginalSha);
      const meta = await readPhotoMetadata(source);
      expect(meta.ok, `${e.id} metadata`).toBe(true);
      const preview = await extractPreview(source, cacheRoot, {
        kind: e.kind === 'jpeg' ? 'jpeg' : 'raw',
        orientation: meta.ok ? meta.value.orientation : null,
      });
      expect(preview, e.id).toMatchObject({ ok: true, value: { origin: e.expectedPreview } });
      expect(await sha256(source)).toBe(expectedOriginalSha);
      reportRows.push({
        id: e.id,
        kind: e.kind,
        model: e.model,
        compression: e.compression,
        timeSource: meta.ok ? meta.value.timeSource : null,
        orientation: meta.ok ? meta.value.orientation : null,
        preview: preview.ok
          ? { origin: preview.value.origin, tag: preview.value.sourceTag, width: preview.value.width, height: preview.value.height, insufficientForFocus: preview.value.insufficientForFocus }
          : { error: preview.code },
        originalUnchanged: (await sha256(source)) === expectedOriginalSha,
      });
      if (!preview.ok) continue;
      const out = await sharp(path.join(cacheRoot, preview.value.cacheId)).metadata();
      expect(out.width, e.id).toBe(preview.value.width);
      expect(out.height, e.id).toBe(preview.value.height);
      const portrait = e.expectedOrientation === 6 || e.expectedOrientation === 8;
      if (portrait) expect(preview.value.height, `${e.id} portrait`).toBeGreaterThan(preview.value.width);
      else expect(preview.value.width, `${e.id} landscape`).toBeGreaterThanOrEqual(preview.value.height);
      // Output is already upright: no orientation tag left for a second rotation.
      expect(out.orientation ?? 1, `${e.id} upright`).toBe(1);
      const thumb = await stat(path.join(cacheRoot, preview.value.thumbCacheId));
      expect(thumb.size).toBeGreaterThan(0);
    }
  });

  it('reads camera, time source and orientation as recorded, without inferring a timezone', async () => {
    for (const e of cases()) {
      const meta = await readPhotoMetadata(fixturePath(e));
      expect(meta.ok, e.id).toBe(true);
      if (!meta.ok) continue;
      expect(meta.value.timeSource, e.id).toBe(e.expectedTimeSource);
      if (e.model) expect(meta.value.cameraModel, e.id).toBe(e.model);
      if (e.expectedOrientation !== null) expect(meta.value.orientation, e.id).toBe(e.expectedOrientation);
      if (meta.value.timeSource !== 'exif-explicit') expect(meta.value.explicitOffsetMinutes, e.id).toBeNull();
    }
  });

  it('rotates a portrait RAW preview the same way as the camera JPEG of the same frame', async () => {
    const raw = entries.find((e) => e.id === 'arw-sony-a7c-portrait')!;
    const jpg = entries.find((e) => e.id === 'jpeg-sony-a7c-portrait')!;
    const rawMeta = await readPhotoMetadata(fixturePath(raw));
    const a = await extractPreview(fixturePath(raw), cacheRoot, { kind: 'raw', orientation: rawMeta.ok ? rawMeta.value.orientation : null });
    const b = await extractPreview(fixturePath(jpg), cacheRoot, { kind: 'jpeg', orientation: null });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const small = (file: string, rotate = 0) =>
      sharp(path.join(cacheRoot, file)).rotate(rotate).resize(24, 36, { fit: 'fill' }).greyscale().raw().toBuffer();
    const diff = (x: Buffer, y: Buffer) => x.reduce((s, v, i) => s + Math.abs(v - y[i]!), 0) / x.length;
    const same = diff(await small(a.value.cacheId), await small(b.value.cacheId));
    const flipped = diff(await small(a.value.cacheId, 180), await small(b.value.cacheId));
    expect(same).toBeLessThan(12);
    expect(same).toBeLessThan(flipped / 2);
  });

  it('marks small embedded previews as insufficient for focus checks', async () => {
    const arw = entries.find((e) => e.id === 'arw-sony-a7c-1')!;
    const r = await extractPreview(fixturePath(arw), cacheRoot, { kind: 'raw', orientation: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.insufficientForFocus).toBe(r.value.width < 2000 && r.value.height < 2000);
  });
});

describe('failure modes', () => {
  it('reports NO_PREVIEW for a truncated RAW and leaves it untouched', async () => {
    const e = entries.find((x) => x.expectedPreview === 'NO_PREVIEW')!;
    const before = await sha256(fixturePath(e));
    const missingPreview = await extractPreview(fixturePath(e), cacheRoot, { kind: 'raw', orientation: null });
    expect(missingPreview).toMatchObject({ ok: false, code: 'NO_PREVIEW' });
    expect(await sha256(fixturePath(e))).toBe(before);
  });

  it('reports a missing capture time as missing, not guessed', async () => {
    const e = entries.find((x) => x.id === 'jpeg-no-exif')!;
    const missingExifTime = await readPhotoMetadata(fixturePath(e));
    expect(missingExifTime.ok).toBe(true);
    if (missingExifTime.ok) expect(missingExifTime.value.timeSource).toBe('missing');
  });

  it('decodes an over-limit JPEG only through shrink-on-load and caps the output size', async () => {
    const dir = await makeTempDir('big-jpeg');
    const big = path.join(dir, 'big.jpg');
    await sharp({ create: { width: 6400, height: 4800, channels: 3, background: { r: 90, g: 120, b: 150 } } })
      .jpeg()
      .toFile(big);
    const r = await extractPreview(big, cacheRoot, { kind: 'jpeg', orientation: 1 });
    expect(r).toMatchObject({ ok: true, value: { origin: 'jpeg-original' } });
    if (r.ok) expect(Math.max(r.value.width, r.value.height)).toBeLessThanOrEqual(2560);
  });

  it('applies the 16 MiB / 24 MP decode limits', () => {
    expect(MAX_PREVIEW_BYTES).toBe(16 * 1024 * 1024);
    expect(MAX_PREVIEW_PIXELS).toBe(24_000_000);
    expect(withinDecodeLimits({ bytes: 17 * 1024 * 1024, width: 1000, height: 1000 })).toBe(false);
    expect(withinDecodeLimits({ bytes: 1000, width: 6000, height: 4100 })).toBe(false);
    expect(withinDecodeLimits({ bytes: 1000, width: 6000, height: 4000 })).toBe(true);
  });
});

describe('MediaQueue', () => {
  it('never runs more than one image job at once on an 8 GB machine', async () => {
    const budget = resourceBudget(8 * 1024 ** 3);
    const q = new MediaQueue({ ...budget, timeoutMs: 5000 });
    let active = 0;
    let maxActiveImageJobsOn8Gb = 0;
    const job = 'j_00000000-0000-4000-8000-000000000001';
    await Promise.all(
      Array.from({ length: 6 }, () =>
        q.run('image', job, async () => {
          active++;
          maxActiveImageJobsOn8Gb = Math.max(maxActiveImageJobsOn8Gb, active);
          await new Promise((r) => setTimeout(r, 20));
          active--;
        }),
      ),
    );
    expect(maxActiveImageJobsOn8Gb).toBeLessThanOrEqual(1);
    expect(budget).toEqual({ metadataJobs: 2, imageJobs: 1 });
    expect(resourceBudget(16 * 1024 ** 3)).toEqual({ metadataJobs: 4, imageJobs: 2 });
  });

  it('isolates a timed-out file and keeps processing the rest', async () => {
    const q = new MediaQueue({ metadataJobs: 1, imageJobs: 1, timeoutMs: 100 });
    const job = 'j_00000000-0000-4000-8000-000000000002';
    // A stuck task stops when its signal is aborted (as the RAW helper and ExifTool's own timeout do);
    // its slot is freed only then, so the next file still gets processed without overlap.
    const hang = q.run('metadata', job, (signal) => new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));
    const next = q.run('metadata', job, async () => 'done');
    expect(await hang).toMatchObject({ ok: false, code: 'TIMEOUT' });
    expect(await next).toMatchObject({ ok: true, value: 'done' });
  });

  it('cancelling a job drops its queued work without affecting another job', async () => {
    const q = new MediaQueue({ metadataJobs: 1, imageJobs: 1, timeoutMs: 5000 });
    const oldJob = 'j_00000000-0000-4000-8000-000000000003';
    const newJob = 'j_00000000-0000-4000-8000-000000000004';
    const ran: string[] = [];
    const slow = q.run('image', oldJob, async () => {
      await new Promise((r) => setTimeout(r, 50));
      ran.push('old-1');
    });
    const queuedOld = q.run('image', oldJob, async () => ran.push('old-2'));
    const queuedNew = q.run('image', newJob, async () => ran.push('new-1'));
    q.cancelJob(oldJob);
    expect(await queuedOld).toMatchObject({ ok: false, code: 'CANCELLED' });
    await slow;
    await queuedNew;
    expect(ran).not.toContain('old-2');
    expect(ran).toContain('new-1');
  });
});

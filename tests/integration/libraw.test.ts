import { copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeRaw, librawHelperPath, LIBRAW_LIMITS, librawVersion } from '../../src/media/libraw';
import { fixturePath, loadFixtures, requireVerifiedFixtures } from '../helpers/fixtures';
import { makeTempDir, sha256 } from '../helpers/fs';

const fx = (id: string) => fixturePath(loadFixtures().find((e) => e.id === id)!);

beforeAll(async () => {
  await requireVerifiedFixtures();
});

describe('LibRaw helper', () => {
  it('is the pinned LibRaw version with the plan limits', async () => {
    expect(librawHelperPath()).toBeTruthy();
    expect(await librawVersion()).toBe('0.22.3');
    expect(LIBRAW_LIMITS).toEqual({ maxMegapixels: 60, timeoutMs: 60_000, maxRssMiB: 1536 });
  });

  it('decodes each target RAW format read-only, upright, at full sensor size', async () => {
    for (const id of ['arw-sony-a7c-1', 'cr2-canon-5d3', 'cr3-canon-r6-craw', 'nef-nikon-d750', 'raf-fuji-xt3', 'dng-adobe-5d3']) {
      const before = await sha256(fx(id));
      const r = await decodeRaw(fx(id), new AbortController().signal);
      expect(r.ok, `${id}: ${r.ok ? '' : r.message}`).toBe(true);
      if (!r.ok) continue;
      expect(r.value.width * r.value.height, id).toBeGreaterThan(9_000_000);
      expect(r.value.rgb.length, id).toBe(r.value.width * r.value.height * 3);
      expect(await sha256(fx(id))).toBe(before);
    }
  }, 300_000);

  it('applies the RAW orientation exactly once (portrait frame comes out portrait)', async () => {
    const r = await decodeRaw(fx('arw-sony-a7c-portrait'), new AbortController().signal);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.height).toBeGreaterThan(r.value.width);
  });

  it('reports a truncated or non-RAW file with a specific error', async () => {
    const bad = await decodeRaw(fx('arw-truncated'), new AbortController().signal);
    expect(bad).toMatchObject({ ok: false });
    if (!bad.ok) expect(bad.code).toMatch(/^RAW_/);
    const dir = await makeTempDir('libraw-bad');
    await writeFile(path.join(dir, 'x.CR2'), 'not a raw file at all');
    const junk = await decodeRaw(path.join(dir, 'x.CR2'), new AbortController().signal);
    expect(junk).toMatchObject({ ok: false, code: 'RAW_UNSUPPORTED' });
  });

  it('reads paths with Vietnamese characters', async () => {
    const dir = await makeTempDir('libraw-ảnh cưới');
    const p = path.join(dir, 'Ảnh cưới #1.ARW');
    await copyFile(fx('arw-sony-a7c-1'), p);
    expect((await decodeRaw(p, new AbortController().signal)).ok).toBe(true);
  });

  it('cancel kills the helper and resolves only after it has exited', async () => {
    const ac = new AbortController();
    const pending = decodeRaw(fx('raf-fuji-xt3'), ac.signal);
    setTimeout(() => ac.abort(), 50);
    const r = await pending;
    expect(r).toMatchObject({ ok: false, code: 'CANCELLED' });
    if (!r.ok) expect(r.exited).toBe(true);
  });

  it('a timeout kills the helper too', async () => {
    const r = await decodeRaw(fx('raf-fuji-xt3'), new AbortController().signal, { timeoutMs: 30 });
    expect(r).toMatchObject({ ok: false, code: 'RAW_TIMEOUT' });
    if (!r.ok) expect(r.exited).toBe(true);
  });

  it('output can be encoded by Sharp as an upright analysis image', async () => {
    const r = await decodeRaw(fx('cr2-canon-5d3'), new AbortController().signal);
    if (!r.ok) throw new Error(r.message);
    const jpeg = await sharp(r.value.rgb, { raw: { width: r.value.width, height: r.value.height, channels: 3 } }).resize(512).jpeg().toBuffer();
    expect((await sharp(jpeg).metadata()).width).toBe(512);
  });
});

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp, { type Metadata, type Sharp } from 'sharp';
import type { PreviewRecord, Result } from '../shared/contracts';
import { extractEmbedded, inspectFile, type PreviewCandidate } from './exiftool';

export const PREVIEW_ALGORITHM = 'preview-v1';
export const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
export const MAX_PREVIEW_PIXELS = 24_000_000;
export const PREVIEW_LONG_EDGE = 2560;
export const THUMB_LONG_EDGE = 360;
/** Below this long edge a preview is not enough to judge critical focus. */
export const FOCUS_CHECK_MIN_EDGE = 2000;
/** JPEG shrink-on-load decodes at up to 1/8 scale per side, i.e. 1/64 of the pixels. */
const SHRINK_ON_LOAD_FACTOR = 64;

sharp.cache({ memory: 256, files: 0, items: 200 });
sharp.concurrency(1);

export function withinDecodeLimits(c: { bytes: number; width: number; height: number }): boolean {
  return c.bytes <= MAX_PREVIEW_BYTES && c.width * c.height <= MAX_PREVIEW_PIXELS;
}

/**
 * Applies an EXIF orientation explicitly. Sharp mirrors (flip/flop) before rotating,
 * so 5 and 7 are expressed as rotate+flip / rotate+flop accordingly.
 */
export function applyOrientation(img: Sharp, orientation: number | null): Sharp {
  switch (orientation) {
    case 2:
      return img.flop();
    case 3:
      return img.rotate(180);
    case 4:
      return img.flip();
    case 5:
      return img.rotate(90).flip();
    case 6:
      return img.rotate(90);
    case 7:
      return img.rotate(90).flop();
    case 8:
      return img.rotate(270);
    default:
      return img;
  }
}

function isJpeg(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8;
}

async function writeAtomic(file: string, data: Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, data, { flag: 'wx' });
  try {
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

interface Rendered {
  preview: Buffer;
  thumb: Buffer;
  width: number;
  height: number;
  orientationApplied: number | null;
}

async function render(pipeline: Sharp, orientation: number | null, autoOrient: boolean): Promise<Rendered> {
  const oriented = autoOrient ? pipeline.rotate() : applyOrientation(pipeline, orientation);
  const { data, info } = await oriented
    .resize({ width: PREVIEW_LONG_EDGE, height: PREVIEW_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer({ resolveWithObject: true });
  const thumb = await sharp(data)
    .resize({ width: THUMB_LONG_EDGE, height: THUMB_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 75 })
    .toBuffer();
  return { preview: data, thumb, width: info.width, height: info.height, orientationApplied: orientation };
}

export interface ExtractOptions {
  kind: 'raw' | 'jpeg';
  /** Orientation of the original file (from its EXIF). Used when the embedded image has none. */
  orientation: number | null;
  /** Stable cache key (e.g. fileId + sampled hash). Defaults to path + size + mtime. */
  cacheKey?: string;
  /** Pre-read candidates, to avoid a second ExifTool call. */
  candidates?: PreviewCandidate[];
}

async function defaultCacheKey(filePath: string): Promise<string> {
  const st = await stat(filePath);
  return `${path.resolve(filePath)}|${st.size}|${st.mtimeMs}`;
}

async function renderEmbedded(
  filePath: string,
  candidates: PreviewCandidate[],
  orientation: number | null,
): Promise<{ rendered: Rendered; tag: string } | null> {
  for (const c of candidates) {
    if (c.bytes > MAX_PREVIEW_BYTES || c.bytes < 2048) continue;
    let buf: Buffer;
    try {
      buf = await extractEmbedded(filePath, c.tag);
    } catch {
      continue;
    }
    if (!isJpeg(buf)) continue;
    let meta: Metadata;
    try {
      meta = await sharp(buf).metadata();
    } catch {
      continue;
    }
    if (!meta.width || !meta.height) continue;
    if (!withinDecodeLimits({ bytes: buf.length, width: meta.width, height: meta.height })) continue;
    try {
      // If the embedded JPEG carries its own orientation, honour it once; otherwise use the RAW's.
      const own = meta.orientation && meta.orientation !== 1 ? meta.orientation : null;
      const rendered = await render(
        sharp(buf, { limitInputPixels: MAX_PREVIEW_PIXELS, failOn: 'truncated' }),
        own ?? orientation,
        false,
      );
      return { rendered, tag: c.tag };
    } catch {
      continue;
    }
  }
  return null;
}

async function renderJpegOriginal(filePath: string): Promise<Rendered> {
  const st = await stat(filePath);
  const meta = await sharp(filePath, { limitInputPixels: false }).metadata();
  if (!meta.width || !meta.height || meta.format !== 'jpeg') throw new Error('Không phải JPEG hợp lệ');
  const fits = withinDecodeLimits({ bytes: st.size, width: meta.width, height: meta.height });
  // Over-limit JPEGs are decoded only through libvips shrink-on-load, which never
  // materialises more than MAX_PREVIEW_PIXELS when the shrink factor applies.
  const limit = fits ? MAX_PREVIEW_PIXELS : MAX_PREVIEW_PIXELS * SHRINK_ON_LOAD_FACTOR;
  if (meta.width * meta.height > limit) throw new Error('Ảnh vượt giới hạn giải mã');
  const r = await render(sharp(filePath, { limitInputPixels: limit, sequentialRead: true }), null, true);
  return { ...r, orientationApplied: meta.orientation ?? 1 };
}

/** Display preview + thumbnail from an already-upright RGB image (LibRaw output). */
export async function previewFromRgb(
  rgb: { data: Buffer; width: number; height: number },
  cacheRoot: string,
  cacheKey: string,
  sourceTag: string,
): Promise<PreviewRecord> {
  const hex = createHash('sha256').update(`${PREVIEW_ALGORITHM}|${cacheKey}`).digest('hex');
  const rendered = await render(sharp(rgb.data, { raw: { width: rgb.width, height: rgb.height, channels: 3 } }), null, false);
  await mkdir(cacheRoot, { recursive: true });
  const cacheId = `${hex}-p.jpg`;
  const thumbCacheId = `${hex}-t.jpg`;
  await writeAtomic(path.join(cacheRoot, cacheId), rendered.preview);
  await writeAtomic(path.join(cacheRoot, thumbCacheId), rendered.thumb);
  return {
    cacheId,
    thumbCacheId,
    width: rendered.width,
    height: rendered.height,
    bytes: rendered.preview.length,
    origin: 'libraw',
    sourceTag,
    orientationApplied: null,
    insufficientForFocus: Math.max(rendered.width, rendered.height) < FOCUS_CHECK_MIN_EDGE,
  };
}

/**
 * Produces a normalised, upright preview + thumbnail in `cacheRoot`. Sources are only read.
 * RAW: embedded JPEG candidates in order of size, within the decode limits.
 * JPEG: the original file itself.
 */
export async function extractPreview(filePath: string, cacheRoot: string, opts: ExtractOptions): Promise<Result<PreviewRecord>> {
  try {
    const key = opts.cacheKey ?? (await defaultCacheKey(filePath));
    const hex = createHash('sha256').update(`${PREVIEW_ALGORITHM}|${key}`).digest('hex');
    let rendered: Rendered;
    let origin: PreviewRecord['origin'];
    let sourceTag: string;
    if (opts.kind === 'jpeg') {
      rendered = await renderJpegOriginal(filePath);
      origin = 'jpeg-original';
      sourceTag = 'JPEG';
    } else {
      let candidates = opts.candidates;
      if (!candidates) {
        const insp = await inspectFile(filePath);
        if (!insp.ok) return insp;
        candidates = insp.value.candidates;
      }
      const got = await renderEmbedded(filePath, candidates, opts.orientation);
      if (!got) return { ok: false, code: 'NO_PREVIEW', message: 'Không có ảnh xem trước nhúng dùng được trong tệp.' };
      rendered = got.rendered;
      origin = 'embedded';
      sourceTag = got.tag;
    }
    await mkdir(cacheRoot, { recursive: true });
    const cacheId = `${hex}-p.jpg`;
    const thumbCacheId = `${hex}-t.jpg`;
    await writeAtomic(path.join(cacheRoot, cacheId), rendered.preview);
    await writeAtomic(path.join(cacheRoot, thumbCacheId), rendered.thumb);
    return {
      ok: true,
      value: {
        cacheId,
        thumbCacheId,
        width: rendered.width,
        height: rendered.height,
        bytes: rendered.preview.length,
        origin,
        sourceTag,
        orientationApplied: rendered.orientationApplied,
        insufficientForFocus: Math.max(rendered.width, rendered.height) < FOCUS_CHECK_MIN_EDGE,
      },
    };
  } catch (e) {
    return { ok: false, code: 'PREVIEW_ERROR', message: (e as Error).message };
  }
}

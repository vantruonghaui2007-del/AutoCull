import sharp from 'sharp';
import type { FeatureVector, Result } from '../shared/contracts';

export const FEATURE_ALGORITHM = 'feat-v1:dhash64+hist32+lap4+clip2';
const ANALYSIS_EDGE = 512;
const HIST_BINS = 32;

/**
 * Technical signals from an already-upright preview: perceptual dHash, grey histogram,
 * Laplacian variance (relative sharpness of the preview) and clipped fraction.
 * These are relative helpers for comparing frames, not an aesthetic or focus verdict.
 */
export async function computeFeatures(previewPath: string): Promise<Result<FeatureVector>> {
  try {
    const { data, info } = await sharp(previewPath)
      .resize({ width: ANALYSIS_EDGE, height: ANALYSIS_EDGE, fit: 'inside', withoutEnlargement: true })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const w = info.width;
    const h = info.height;
    const grey = info.channels === 1 ? data : extractFirstChannel(data, info.channels);

    const dh = await sharp(grey, { raw: { width: w, height: h, channels: 1 } }).resize(9, 8, { fit: 'fill' }).raw().toBuffer();
    let bits = 0n;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        bits = (bits << 1n) | (dh[y * 9 + x]! > dh[y * 9 + x + 1]! ? 1n : 0n);
      }
    }

    const histogram = new Array<number>(HIST_BINS).fill(0);
    let clipped = 0;
    for (const v of grey) {
      histogram[Math.min(HIST_BINS - 1, v >> 3)]! += 1;
      if (v <= 2 || v >= 253) clipped++;
    }
    const total = grey.length;

    const laplacianVariance = laplacianVarianceOf(grey, w, h);


    return {
      ok: true,
      value: {
        hash: bits.toString(16).padStart(16, '0'),
        histogram: histogram.map((c) => c / total),
        laplacianVariance: Math.round(laplacianVariance * 100) / 100,
        clippedFraction: clipped / total,
        width: w,
        height: h,
        algorithmVersion: FEATURE_ALGORITHM,
      },
    };
  } catch (e) {
    return { ok: false, code: 'FEATURE_ERROR', message: (e as Error).message };
  }
}

function extractFirstChannel(data: Buffer, channels: number): Buffer {
  const out = Buffer.alloc(data.length / channels);
  for (let i = 0; i < out.length; i++) out[i] = data[i * channels]!;
  return out;
}

function laplacianVarianceOf(grey: Uint8Array, w: number, h: number): number {
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = grey[i - 1]! + grey[i + 1]! + grey[i - w]! + grey[i + w]! - 4 * grey[i]!;
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  const mean = count ? sum / count : 0;
  return count ? sumSq / count - mean * mean : 0;
}

/** Face crops are compared at this size, so faces of slightly different size stay comparable. */
export const FACE_CROP_EDGE = 128;
/** Smaller crops (in preview pixels) carry too little detail to judge sharpness. */
export const MIN_FACE_CROP_PX = 24;

/**
 * Relative sharpness of each face: Laplacian variance of the face box (ratios of the upright frame)
 * cut from the display preview, resized to a fixed size. null when the crop is too small. These
 * values are only meaningful when compared inside one group.
 */
export async function faceCropSharpness(previewPath: string, boxes: { left: number; top: number; width: number; height: number }[]): Promise<(number | null)[]> {
  const { data, info } = await sharp(previewPath).greyscale().raw().toBuffer({ resolveWithObject: true });
  const grey = info.channels === 1 ? data : extractFirstChannel(data, info.channels);
  const out: (number | null)[] = [];
  for (const b of boxes) {
    const left = Math.max(0, Math.floor(b.left * info.width));
    const top = Math.max(0, Math.floor(b.top * info.height));
    const width = Math.min(info.width - left, Math.round(b.width * info.width));
    const height = Math.min(info.height - top, Math.round(b.height * info.height));
    if (width < MIN_FACE_CROP_PX || height < MIN_FACE_CROP_PX) {
      out.push(null);
      continue;
    }
    const crop = await sharp(grey, { raw: { width: info.width, height: info.height, channels: 1 } })
      .extract({ left, top, width, height })
      .resize(FACE_CROP_EDGE, FACE_CROP_EDGE, { fit: 'fill' })
      .raw()
      .toBuffer();
    out.push(Math.round(laplacianVarianceOf(crop, FACE_CROP_EDGE, FACE_CROP_EDGE) * 100) / 100);
  }
  return out;
}
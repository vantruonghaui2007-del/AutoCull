import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { applyOrientation } from './previews';

/** Bump when the way the analysis JPEG is produced changes: cached results become stale. */
export const PREP_VERSION = 'prep-v2';
export const MAX_SEND_EDGE = 3840;
export const FALLBACK_EDGE = 2560;
export const MAX_PAYLOAD_BYTES = Math.floor(2.5 * 1024 * 1024);
const QUALITIES = [85, 80, 75, 70];
/** Upper bound on decoded input; matches the RAW helper limit. */
export const MAX_ANALYSIS_INPUT_PIXELS = 60_000_000;
/** JPEG supports shrink-on-load; accept high-resolution camera JPEGs while bounding malformed input. */
export const MAX_JPEG_INPUT_PIXELS = 100_000_000;

export interface AnalysisJpeg {
  jpeg: Buffer;
  width: number;
  height: number;
  quality: number;
}

/**
 * JPEG sent for face analysis: upright (orientation applied exactly once), long edge ≤ 3840 px,
 * never upscaled, no metadata (EXIF/GPS/XMP stripped — Sharp writes none unless asked),
 * ≤ 2.5 MiB: quality 85 → 70, then long edge 2560 px.
 */
export type AnalysisInput = Buffer | string | { raw: { data: Buffer; width: number; height: number } };

export async function encodeForAnalysis(input: AnalysisInput, orient: { autoOrient: true } | { orientation: number | null }): Promise<AnalysisJpeg> {
  const rawInput = typeof input === 'object' && 'raw' in input ? input.raw : null;
  const metadata = rawInput ? null : await sharp(input as Buffer | string, { limitInputPixels: MAX_JPEG_INPUT_PIXELS }).metadata();
  const pixelLimit = metadata?.format === 'jpeg' ? MAX_JPEG_INPUT_PIXELS : MAX_ANALYSIS_INPUT_PIXELS;
  for (const edge of [MAX_SEND_EDGE, FALLBACK_EDGE]) {
    let base =
      typeof input === 'object' && 'raw' in input
        ? sharp(input.raw.data, { raw: { width: input.raw.width, height: input.raw.height, channels: 3 }, limitInputPixels: MAX_ANALYSIS_INPUT_PIXELS })
        : sharp(input, { limitInputPixels: pixelLimit, failOn: 'truncated' });
    base = 'autoOrient' in orient ? base.rotate() : applyOrientation(base, orient.orientation);
    const resized = await base
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (const quality of QUALITIES) {
      const jpeg = await sharp(resized.data, { raw: { width: resized.info.width, height: resized.info.height, channels: resized.info.channels } })
        .jpeg({ quality, mozjpeg: false })
        .toBuffer();
      if (jpeg.length <= MAX_PAYLOAD_BYTES) return { jpeg, width: resized.info.width, height: resized.info.height, quality };
    }
  }
  throw Object.assign(new Error('Ảnh phân tích vẫn vượt 2,5 MiB sau khi giảm chất lượng và kích thước.'), { code: 'ANALYSIS_IMAGE_TOO_LARGE' });
}

/**
 * Identity of an analysis input: which file plays which role (confirmed companion JPEG or the
 * primary file), that file's content sample, and the preprocessing version. Anything else
 * changing (file replaced, pair confirmed, preprocessing updated) makes earlier results stale.
 */
export function analysisInputKey(role: 'companion' | 'primary', fileId: string, sampledHash: string): string {
  return createHash('sha256').update(`${role}|${fileId}|${sampledHash}|${PREP_VERSION}`).digest('hex');
}

/** Earlier prep-v2 builds accidentally omitted role. The same file/preprocessing is still the same image. */
export function compatibleInputKey(role: 'companion' | 'primary', fileId: string, sampledHash: string, storedKey?: string): string {
  const legacy = createHash('sha256').update(`|${fileId}|${sampledHash}|${PREP_VERSION}`).digest('hex');
  return storedKey === legacy ? legacy : analysisInputKey(role, fileId, sampledHash);
}

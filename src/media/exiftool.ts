import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ExifTool } from 'exiftool-vendored';
import type { PhotoMetadata, Result } from '../shared/contracts';

/**
 * Read-only ExifTool adapter. The underlying ExifTool instance is private; this module
 * exposes only metadata reads and embedded-image extraction to memory. There is no
 * method that writes to a source file.
 */

export const PREVIEW_TAGS = ['JpgFromRaw', 'PreviewImage', 'OtherImage', 'ThumbnailImage'] as const;
export type PreviewTagName = (typeof PREVIEW_TAGS)[number];

export interface PreviewCandidate {
  tag: PreviewTagName;
  bytes: number;
}

export interface FileInspection {
  metadata: PhotoMetadata;
  candidates: PreviewCandidate[];
  warnings: string[];
}

let instance: ExifTool | null = null;
let maxProcs = 2;

async function vendoredExiftoolPath(): Promise<string> {
  const mod: { default: string } =
    process.platform === 'win32' ? await import('exiftool-vendored.exe') : await import('exiftool-vendored.pl');
  const packed = mod.default;
  // Packaged builds: the helper must run from app.asar.unpacked (checked first, because
  // Electron's fs reports asar-internal paths as existing).
  const unpacked = packed
    .split(path.sep)
    .map((s) => (s === 'app.asar' ? 'app.asar.unpacked' : s))
    .join(path.sep);
  if (unpacked !== packed && existsSync(unpacked)) return unpacked;
  if (!packed.split(path.sep).includes('app.asar') && existsSync(packed)) return packed;
  // Never fall back to an exiftool found on PATH: the app must ship its own helper.
  throw new Error(`Không tìm thấy ExifTool đi kèm ứng dụng (${unpacked}).`);
}

export function configureExifTool(options: { maxProcs: number }): void {
  maxProcs = Math.max(1, options.maxProcs);
}

function exiftool(): ExifTool {
  if (!instance) {
    instance = new ExifTool({
      maxProcs,
      taskTimeoutMillis: 30_000,
      exiftoolPath: vendoredExiftoolPath,
      geolocation: false,
    });
  }
  return instance;
}

export async function exiftoolVersion(): Promise<string> {
  return exiftool().version();
}

export async function closeExifTool(): Promise<void> {
  const et = instance;
  instance = null;
  if (et) await et.end();
}

export function exiftoolChildPids(): number[] {
  return instance ? instance.pids : [];
}

const DATE_RE = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?/;
const OFFSET_RE = /^([+-])(\d{2}):?(\d{2})$/;

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

export function parseCaptureTime(
  dateTimeOriginal: unknown,
  subSec: unknown,
): string | null {
  const s = str(dateTimeOriginal);
  if (!s) return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se, frac] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (year < 1980 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(se) > 60) return null;
  let fraction = frac ?? '';
  const sub = str(subSec);
  if (!fraction && sub && /^\d+$/.test(sub)) fraction = `.${sub}`;
  return `${y}-${mo}-${d}T${h}:${mi}:${se}${fraction.slice(0, 4)}`;
}

export function parseOffsetMinutes(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const m = OFFSET_RE.exec(s);
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  if (minutes > 14 * 60) return null;
  return m[1] === '-' ? -minutes : minutes;
}

function serialOf(tags: Record<string, unknown>): string | null {
  for (const key of ['SerialNumber', 'BodySerialNumber', 'InternalSerialNumber']) {
    const s = str(tags[key]);
    if (s && !/^[0\s]+$/.test(s)) return s;
  }
  return null;
}

export function cameraIdFor(make: string | null, model: string | null, scope: string): string {
  const key = `${(make ?? '').toLowerCase()}|${(model ?? '').toLowerCase()}|${scope}`;
  return `c_${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

export function metadataFromTags(tags: Record<string, unknown>): PhotoMetadata {
  const make = str(tags.Make);
  const model = str(tags.Model);
  const serial = serialOf(tags);
  const capturedLocal = parseCaptureTime(tags.DateTimeOriginal, tags.SubSecTimeOriginal);
  const offset = capturedLocal ? parseOffsetMinutes(tags.OffsetTimeOriginal) : null;
  const o = Number(tags.Orientation);
  return {
    cameraId: serial && (make || model) ? cameraIdFor(make, model, `serial:${serial}`) : null,
    cameraMake: make,
    cameraModel: model,
    cameraSerial: serial,
    capturedLocal,
    explicitOffsetMinutes: offset,
    timeSource: capturedLocal === null ? 'missing' : offset === null ? 'exif-no-zone' : 'exif-explicit',
    orientation: Number.isInteger(o) && o >= 1 && o <= 8 ? o : null,
  };
}

const BINARY_RE = /Binary data (\d+) bytes/;

export function candidatesFromTags(tags: Record<string, unknown>): PreviewCandidate[] {
  const out: PreviewCandidate[] = [];
  for (const tag of PREVIEW_TAGS) {
    const v = str(tags[tag]);
    const m = v ? BINARY_RE.exec(v) : null;
    if (m) out.push({ tag, bytes: Number(m[1]) });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

const READ_ARGS = [
  '-n',
  '-Make',
  '-Model',
  '-SerialNumber',
  '-BodySerialNumber',
  '-InternalSerialNumber',
  '-DateTimeOriginal',
  '-SubSecTimeOriginal',
  '-OffsetTimeOriginal',
  '-Orientation',
  ...PREVIEW_TAGS.map((t) => `-${t}`),
];

export async function inspectFile(filePath: string): Promise<Result<FileInspection>> {
  try {
    const tags = (await exiftool().readRaw(filePath, { readArgs: READ_ARGS })) as unknown as Record<string, unknown>;
    const warnings = [...((tags.warnings as string[] | undefined) ?? []), ...((tags.errors as string[] | undefined) ?? [])];
    return {
      ok: true,
      value: { metadata: metadataFromTags(tags), candidates: candidatesFromTags(tags), warnings },
    };
  } catch (e) {
    return { ok: false, code: 'METADATA_ERROR', message: (e as Error).message };
  }
}

export async function readPhotoMetadata(filePath: string): Promise<Result<PhotoMetadata>> {
  const r = await inspectFile(filePath);
  return r.ok ? { ok: true, value: r.value.metadata } : r;
}

export async function extractEmbedded(filePath: string, tag: PreviewTagName): Promise<Buffer> {
  return exiftool().extractBinaryTagToBuffer(tag, filePath);
}

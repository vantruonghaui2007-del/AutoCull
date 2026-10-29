import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export interface SyntheticOptions {
  width?: number;
  height?: number;
  make?: string;
  model?: string;
  serial?: string;
  /** EXIF DateTimeOriginal as 'YYYY:MM:DD HH:mm:ss'. */
  dateTimeOriginal?: string;
  /** Base colour; a diagonal gradient is added so images are not flat. */
  rgb?: [number, number, number];
  /** Shifts a bright square across the frame to simulate a slightly different shot. */
  squareAt?: number;
}

/** Writes a small synthetic JPEG with optional EXIF. These are test inputs, not camera evidence. */
export async function writeSyntheticJpeg(file: string, o: SyntheticOptions = {}): Promise<string> {
  const width = o.width ?? 96;
  const height = o.height ?? 64;
  const [r, g, b] = o.rgb ?? [80, 110, 140];
  const px = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const grad = Math.round(((x + y) / (width + height)) * 80);
      px[i] = Math.min(255, r + grad);
      px[i + 1] = Math.min(255, g + grad);
      px[i + 2] = Math.min(255, b + grad);
    }
  }
  if (o.squareAt !== undefined) {
    const s = Math.floor(height / 3);
    const x0 = Math.min(width - s, Math.max(0, Math.floor(o.squareAt)));
    for (let y = s; y < 2 * s; y++) for (let x = x0; x < x0 + s; x++) px.fill(250, (y * width + x) * 3, (y * width + x) * 3 + 3);
  }
  await mkdir(path.dirname(file), { recursive: true });
  let img = sharp(px, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 });
  const ifd0: Record<string, string> = {};
  if (o.make) ifd0.Make = o.make;
  if (o.model) ifd0.Model = o.model;
  const exif: Record<string, Record<string, string>> = {};
  if (Object.keys(ifd0).length) exif.IFD0 = ifd0;
  const ifd2: Record<string, string> = {};
  if (o.dateTimeOriginal) ifd2.DateTimeOriginal = o.dateTimeOriginal;
  if (o.serial) ifd2.BodySerialNumber = o.serial;
  if (Object.keys(ifd2).length) exif.IFD2 = ifd2;
  if (Object.keys(exif).length) img = img.withExif(exif);
  await img.toFile(file);
  return file;
}

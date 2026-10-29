#!/usr/bin/env node
// Builds the app icons from the master artwork (square PNG with alpha):
//   build/icon.png  1024 px  (electron-builder: macOS/Linux, runtime window icon)
//   build/icon.ico  16–256 px PNG-compressed entries (Windows exe, installer, shortcuts)
// Usage: node scripts/make-icons.mjs [master.png]   (default: build/icon-master.png)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..');
const master = path.resolve(process.argv[2] ?? path.join(root, 'build', 'icon-master.png'));
const out = path.join(root, 'build');
await mkdir(out, { recursive: true });
const src = await readFile(master);
const meta = await sharp(src).metadata();
if (meta.width !== meta.height || meta.width < 512) throw new Error(`Icon master must be square and ≥512 px (got ${meta.width}×${meta.height})`);

const png = (size) => sharp(src).resize(size, size, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer();
await writeFile(path.join(out, 'icon.png'), await png(1024));

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map(png));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // icon
header.writeUInt16LE(sizes.length, 4);
const dir = Buffer.alloc(16 * sizes.length);
let offset = header.length + dir.length;
sizes.forEach((s, i) => {
  const e = i * 16;
  dir.writeUInt8(s >= 256 ? 0 : s, e);
  dir.writeUInt8(s >= 256 ? 0 : s, e + 1);
  dir.writeUInt8(0, e + 2);
  dir.writeUInt8(0, e + 3);
  dir.writeUInt16LE(1, e + 4);
  dir.writeUInt16LE(32, e + 6);
  dir.writeUInt32LE(images[i].length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += images[i].length;
});
await writeFile(path.join(out, 'icon.ico'), Buffer.concat([header, dir, ...images]));
console.log(`icons written from ${path.basename(master)} (${meta.width}px): build/icon.png, build/icon.ico [${sizes.join(', ')}]`);

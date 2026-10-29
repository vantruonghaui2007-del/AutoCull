// Restores test fixtures listed in tests/fixtures/manifest.json into tests/fixtures/files/.
// Binaries are not committed: CC0 samples are downloaded, user samples are copied read-only
// from the path recorded in the manifest, derived samples are regenerated. Every file is
// verified against the recorded SHA-256; a mismatch is an error, never a skip.
//
// Usage: node scripts/fixtures.ts [--record]   (--record writes missing sha256 values)
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface Entry {
  id: string;
  file: string;
  kind: string;
  source: {
    type: 'url' | 'user' | 'derived';
    url?: string;
    localPath?: string;
    derivedFrom?: string;
    transform?: string;
    license: string;
  };
  sha256: string | null;
}

const root = path.resolve(import.meta.dirname, '..');
const manifestPath = path.join(root, 'tests', 'fixtures', 'manifest.json');
const filesRoot = path.join(root, 'tests', 'fixtures', 'files');
const record = process.argv.includes('--record');

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('error', reject)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')));
  });
}

async function derive(entry: Entry, out: string, byId: Map<string, Entry>): Promise<void> {
  const base = byId.get(entry.source.derivedFrom ?? '');
  if (!base) throw new Error(`${entry.id}: derivedFrom not found`);
  const input = path.join(filesRoot, base.file);
  const [op, arg] = (entry.source.transform ?? '').split(':');
  if (op === 'truncate') {
    const fh = await open(input, 'r');
    const buf = Buffer.alloc(Number(arg));
    await fh.read(buf, 0, buf.length, 0);
    await fh.close();
    await writeFile(out, buf, { flag: 'wx' });
  } else if (op === 'strip-metadata') {
    const sharp = (await import('sharp')).default;
    await sharp(input).rotate().resize({ width: Number(arg) || 1600 }).jpeg({ quality: 85 }).toFile(out);
  } else {
    throw new Error(`${entry.id}: unknown transform ${entry.source.transform}`);
  }
}

async function main(): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { entries: Entry[] };
  const byId = new Map(manifest.entries.map((e) => [e.id, e]));
  let failures = 0;
  let changed = false;
  // Non-derived first so derived inputs exist.
  const ordered = [...manifest.entries].sort((a, b) => Number(a.source.type === 'derived') - Number(b.source.type === 'derived'));
  for (const entry of ordered) {
    const out = path.join(filesRoot, entry.file);
    await mkdir(path.dirname(out), { recursive: true });
    if (!existsSync(out)) {
      if (entry.source.type === 'url') {
        const res = await fetch(entry.source.url!);
        if (!res.ok) throw new Error(`${entry.id}: HTTP ${res.status}`);
        await writeFile(out, Buffer.from(await res.arrayBuffer()), { flag: 'wx' });
      } else if (entry.source.type === 'user') {
        await copyFile(entry.source.localPath!, out);
      } else {
        await derive(entry, out, byId);
      }
    }
    const actual = await sha256(out);
    if (entry.sha256 === null && record) {
      entry.sha256 = actual;
      changed = true;
      console.log(`recorded ${entry.id} ${actual}`);
    } else if (entry.sha256 !== actual) {
      failures++;
      console.error(`MISMATCH ${entry.id}: expected ${entry.sha256} got ${actual}`);
    } else {
      console.log(`ok ${entry.id}`);
    }
  }
  if (changed) await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (failures) {
    console.error(`${failures} fixture(s) failed verification`);
    process.exit(1);
  }
}

await main();

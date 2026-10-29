import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot, sha256 } from './fs';

export interface FixtureEntry {
  id: string;
  file: string;
  kind: 'cr2' | 'cr3' | 'nef' | 'arw' | 'dng' | 'raf' | 'jpeg';
  sha256: string;
  make: string | null;
  model: string | null;
  compression: string;
  expectedOrientation: number | null;
  expectedPreview: 'embedded' | 'jpeg-original' | 'NO_PREVIEW';
  expectedTimeSource: 'exif-explicit' | 'exif-no-zone' | 'missing' | null;
  source: { type: string; license: string };
}

export const fixturesRoot = path.join(repoRoot, 'tests', 'fixtures', 'files');

export function loadFixtures(): FixtureEntry[] {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'manifest.json'), 'utf8')) as {
    entries: FixtureEntry[];
  };
  return manifest.entries;
}

export function fixturePath(entry: FixtureEntry): string {
  return path.join(fixturesRoot, entry.file);
}

/** Throws (never skips) when a fixture is absent or differs from the manifest. Run `npm run fixtures` first. */
export async function requireVerifiedFixtures(): Promise<FixtureEntry[]> {
  const entries = loadFixtures();
  for (const e of entries) {
    const p = fixturePath(e);
    if (!existsSync(p)) throw new Error(`Thiếu fixture ${e.id} (${e.file}). Chạy: npm run fixtures`);
    const actual = await sha256(p);
    if (actual !== e.sha256) throw new Error(`Fixture ${e.id} sai SHA-256: ${actual}`);
  }
  return entries;
}

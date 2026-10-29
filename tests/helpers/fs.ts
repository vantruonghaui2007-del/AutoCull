import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
import path from 'node:path';

// __dirname works under both Vitest and Playwright's CommonJS test loader.
export const repoRoot = path.resolve(__dirname, '..', '..');
/** Scratch area required by the plan: `work/` of the workspace (parent of the repo). */
export const workRoot = path.resolve(repoRoot, '..', 'work');

export async function makeTempDir(prefix: string): Promise<string> {
  await mkdir(workRoot, { recursive: true });
  return mkdtemp(path.join(workRoot, `${prefix}-`));
}

export function sha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(filePath)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function listFiles(root: string, rel = ''): Promise<string[]> {
  const entries = await readdir(path.join(root, rel), { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) continue; // links/junctions are not part of the tree's own content
    if (e.isDirectory()) out.push(...(await listFiles(root, childRel)));
    else out.push(childRel);
  }
  return out;
}

/** Sorted relative paths + full SHA-256 of every file's content. */
export async function sourceTreeDigest(root: string): Promise<string> {
  const files = (await listFiles(root)).sort();
  const hash = createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(await sha256(path.join(root, rel)));
    hash.update('\n');
  }
  return hash.digest('hex');
}

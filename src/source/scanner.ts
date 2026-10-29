import { opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isPathInside } from '../main/paths';
import type { FileRecord } from '../shared/contracts';

export const RAW_EXTENSIONS = new Set(['.cr2', '.cr3', '.nef', '.arw', '.dng', '.raf']);
export const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg']);

const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', '.spotlight-v100', '.trashes', '.fseventsd', '.temporaryitems']);

export function kindOf(name: string): FileRecord['kind'] | null {
  if (name.startsWith('._')) return null; // macOS AppleDouble metadata
  const ext = path.extname(name).toLowerCase();
  if (RAW_EXTENSIONS.has(ext)) return 'raw';
  if (JPEG_EXTENSIONS.has(ext)) return 'jpeg';
  if (ext === '.xmp') return 'xmp';
  return null;
}

export interface DirError {
  kind: 'dir-error';
  relativePath: string;
  message: string;
}

export interface DiscoveredFile {
  relativePath: string;
  absolutePath: string;
  kind: FileRecord['kind'];
  bytes: number;
  mtimeMs: number;
}

/**
 * Walks a source root without following symlinks or junctions, and checks that every
 * directory's real location stays inside the real root. Only reads directory entries and stats.
 */
export async function* walkSource(root: string, signal?: AbortSignal): AsyncGenerator<DiscoveredFile | DirError> {
  const realRoot = await realpath(root);
  const stack: string[] = [''];
  while (stack.length) {
    if (signal?.aborted) return;
    const rel = stack.pop()!;
    const dirAbs = rel ? path.join(realRoot, ...rel.split('/')) : realRoot;
    let dirReal: string;
    let dir;
    try {
      dirReal = await realpath(dirAbs);
      if (!isPathInside(realRoot, dirReal)) continue;
      dir = await opendir(dirAbs);
    } catch (e) {
      // Unreadable folder (permissions, disconnected volume): report it, never treat its files as gone.
      yield { kind: 'dir-error', relativePath: rel || '.', message: (e as Error).message };
      continue;
    }
    const subdirs: string[] = [];
    const files: DiscoveredFile[] = [];
    for await (const entry of dir) {
      if (entry.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name.toLowerCase())) subdirs.push(childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      const kind = kindOf(entry.name);
      if (!kind) continue;
      const abs = path.join(dirAbs, entry.name);
      try {
        const st = await stat(abs);
        files.push({ relativePath: childRel, absolutePath: abs, kind, bytes: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // vanished or unreadable between readdir and stat: skip; it will be reported missing on next scan
      }
    }
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    for (const f of files) yield f;
    subdirs.sort().reverse();
    stack.push(...subdirs);
  }
}

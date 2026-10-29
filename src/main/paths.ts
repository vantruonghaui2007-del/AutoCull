import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Result } from '../shared/contracts';

type Platform = NodeJS.Platform;

function pathApi(platform: Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Comparable form of a path: Unicode NFC, and case-folded where the default file system is case-insensitive. */
export function comparablePath(p: string, platform: Platform = process.platform): string {
  const api = pathApi(platform);
  let out = api.resolve(p.normalize('NFC'));
  if (platform === 'win32' || platform === 'darwin') out = out.toLowerCase();
  return out;
}

/** Segment-wise containment check (never a string-prefix test). `child === parent` counts as inside. */
export function isPathInside(parent: string, child: string, platform: Platform = process.platform): boolean {
  const api = pathApi(platform);
  const rel = api.relative(comparablePath(parent, platform), comparablePath(child, platform));
  if (rel === '') return true;
  return !rel.startsWith('..') && !api.isAbsolute(rel);
}

export function pathsOverlap(a: string, b: string, platform: Platform = process.platform): boolean {
  return isPathInside(a, b, platform) || isPathInside(b, a, platform);
}

async function realpathOfNearestExisting(candidate: string): Promise<string> {
  const rest: string[] = [];
  let current = candidate;
  for (;;) {
    try {
      const real = await realpath(current);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
      const parent = path.dirname(current);
      if (parent === current) throw e;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolves `candidate` through symlinks/junctions and accepts it only when the real location
 * stays inside the real location of `root`. Paths that do not exist yet are resolved through
 * their nearest existing ancestor. Returns the real path.
 */
export async function resolveAllowedPath(root: string, candidate: string): Promise<Result<string>> {
  if (!path.isAbsolute(candidate) || !path.isAbsolute(root)) {
    return { ok: false, code: 'PATH_NOT_ABSOLUTE', message: 'Đường dẫn phải là tuyệt đối.' };
  }
  if (candidate.split(/[\\/]+/).includes('..')) {
    return { ok: false, code: 'PATH_TRAVERSAL', message: 'Không chấp nhận ".." trong đường dẫn.' };
  }
  try {
    const realRoot = await realpath(root);
    const realCandidate = await realpathOfNearestExisting(candidate);
    if (!isPathInside(realRoot, realCandidate)) {
      return { ok: false, code: 'PATH_OUTSIDE_ROOT', message: 'Đường dẫn nằm ngoài thư mục được cấp quyền.' };
    }
    return { ok: true, value: realCandidate };
  } catch (e) {
    return { ok: false, code: 'PATH_UNAVAILABLE', message: (e as Error).message };
  }
}

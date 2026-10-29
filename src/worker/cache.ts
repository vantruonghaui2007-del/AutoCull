import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { extractPreview } from '../media/previews';
import type { ProjectStore } from '../project/store';
import type { Result } from '../shared/contracts';
import { err, ok } from '../shared/schemas';
import { absolutePathOf } from './scan';

export const PREVIEW_CACHE_BYTES = 1024 ** 3;
const CACHE_FILE = /^[0-9a-f]{64}-(t|p)\.jpg$/;

/**
 * Keeps the preview cache under `maxBytes` by deleting large previews (never thumbnails) in
 * least-recently-used order. Only files whose names are cache IDs inside this project's cache
 * folder are considered; database rows stay so a preview can be regenerated on demand.
 */
export async function evictPreviewCache(store: ProjectStore, maxBytes = PREVIEW_CACHE_BYTES): Promise<{ evicted: number; bytes: number }> {
  const root = store.cacheRoot;
  const sizes = new Map<string, number>();
  for (const name of await readdir(root)) {
    if (!CACHE_FILE.test(name)) continue;
    try {
      sizes.set(name, (await stat(path.join(root, name))).size);
    } catch {
      /* vanished */
    }
  }
  let total = [...sizes.values()].reduce((a, b) => a + b, 0);
  if (total <= maxBytes) return { evicted: 0, bytes: total };
  const lastUsed = new Map(store.allPreviews().map((p) => [p.cacheId, p.lastUsedAt]));
  const candidates = [...sizes.keys()].filter((n) => n.endsWith('-p.jpg')).sort((a, b) => (lastUsed.get(a) ?? 0) - (lastUsed.get(b) ?? 0) || a.localeCompare(b));
  let evicted = 0;
  for (const name of candidates) {
    if (total <= maxBytes) break;
    try {
      await unlink(path.join(root, name));
      total -= sizes.get(name)!;
      evicted++;
    } catch {
      /* in use or gone */
    }
  }
  return { evicted, bytes: total };
}

/** Re-extracts an evicted preview from its source file under the same cache name. */
export async function restorePreview(store: ProjectStore, cacheFile: string): Promise<Result<boolean>> {
  if (!CACHE_FILE.test(cacheFile)) return err('INVALID_ARGUMENT', 'Tên bộ đệm không hợp lệ.');
  const row = store.allPreviews().find((p) => p.cacheId === cacheFile || p.thumbCacheId === cacheFile);
  if (!row) return err('UNKNOWN_ID', 'Không có preview này.');
  const file = store.file(row.fileId);
  const source = file ? store.source(file.sourceId) : undefined;
  if (!file || !source || !source.online || file.missing) return err('SOURCE_MISSING', 'Nguồn không truy cập được để tạo lại preview.');
  const meta = store.metadata(file.id);
  const r = await extractPreview(absolutePathOf(source, file), store.cacheRoot, {
    kind: file.kind === 'jpeg' ? 'jpeg' : 'raw',
    orientation: meta?.orientation ?? null,
    cacheKey: `${file.id}|${file.sampledHash}`,
  });
  if (!r.ok) return r;
  if (r.value.cacheId !== row.cacheId) return err('PREVIEW_CHANGED', 'Preview tạo lại khác bản đã lưu; hãy quét lại.');
  store.touchPreviews([file.id]);
  return ok(true);
}

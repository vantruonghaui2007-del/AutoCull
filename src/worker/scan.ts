import { stat } from 'node:fs/promises';
import path from 'node:path';
import { inspectFile } from '../media/exiftool';
import { decodeRaw } from '../media/libraw';
import { extractPreview, previewFromRgb } from '../media/previews';
import type { AssetCore, FileRow, ProjectStore, SourceRow } from '../project/store';
import { fingerprint } from '../source/fingerprint';
import { walkSource } from '../source/scanner';
import type { FileId, MediaStatus, ProgressEvent } from '../shared/contracts';
import type { MediaQueue } from './queue';

export interface ScanContext {
  store: ProjectStore;
  queue: MediaQueue;
  /** Shared single-slot preparation queue, also used by AI. Waiting does not start a task timeout. */
  rawQueue?: MediaQueue;
  emit(e: ProgressEvent): void;
  /** Called after an asset's preview changed, inside the job (e.g. compute features). */
  onAssetMedia?(assetId: string, token: string): Promise<void>;
  /** Called once all files of a run are processed, before 'complete' is emitted. */
  afterScan?(): void;
}

export interface ScanRun {
  jobId: string;
  /** Queue key for this run; a resumed job gets a new token. */
  token: string;
  closing: boolean;
  userCancelled: boolean;
  done: Promise<void>;
}

export function absolutePathOf(source: SourceRow, file: Pick<FileRow, 'relativePath'>): string {
  return path.join(source.rootPath, ...file.relativePath.split('/'));
}

/** "DCIM/IMG_1.CR2", "DCIM/IMG_1.xmp" and "DCIM/IMG_1.CR2.xmp" all map to "dcim/img_1". */
export function stemKey(relativePath: string): string {
  const dir = path.posix.dirname(relativePath).normalize('NFC').toLowerCase();
  let base = path.posix.basename(relativePath).normalize('NFC').toLowerCase();
  base = base.replace(/\.xmp$/, '').replace(/\.(cr2|cr3|nef|arw|dng|raf|jpe?g)$/, '');
  return `${dir}/${base}`;
}

/** Links each XMP sidecar to the RAW in the same folder with the same stem, only if exactly one matches. */
export function linkSidecars(store: ProjectStore, sourceId: string): void {
  const files = store.filesOfSource(sourceId);
  const raws = new Map<string, FileRow[]>();
  for (const f of files) if (f.kind === 'raw') raws.set(stemKey(f.relativePath), [...(raws.get(stemKey(f.relativePath)) ?? []), f]);
  for (const x of files) {
    if (x.kind !== 'xmp') continue;
    const match = raws.get(stemKey(x.relativePath));
    store.linkSidecar(x.id, match && match.length === 1 ? match[0]!.id : null);
  }
}

class Throttle {
  private last = new Map<string, number>();
  constructor(private readonly ms: number) {}
  should(key: string): boolean {
    const now = Date.now();
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < this.ms) return false;
    this.last.set(key, now);
    return true;
  }
}

function statusFromAsset(store: ProjectStore, a: AssetCore): MediaStatus | null {
  const p = store.displayPreview(a);
  if (p) return p.insufficientForFocus ? 'preview-small' : 'ready';
  return null;
}

export async function runScan(ctx: ScanContext, run: ScanRun, sources: SourceRow[]): Promise<void> {
  const { store, queue } = ctx;
  const projectId = store.id;
  const jobId = run.jobId;
  const throttle = new Throttle(150);
  const already = store.jobFiles(jobId);
  const inJob = new Set(already.map((f) => f.fileId));
  let seq = already.length;
  let total = already.filter((f) => !f.done).length;
  let doneCount = 0;
  let discovered = 0;
  let errors = 0;
  const emit = (phase: Extract<ProgressEvent, { kind: 'scan' }>['phase'], fileId?: FileId, message?: string, force = false) => {
    if (phase === 'file-error') errors++;
    if (!force && phase !== 'file-error' && !throttle.should(phase)) return;
    ctx.emit({ kind: 'scan', projectId, jobId, phase, fileId, done: doneCount, total, message });
  };
  const stopped = () => run.closing || queue.isCancelled(run.token);
  const pending: Promise<void>[] = [];

  const processFile = async (source: SourceRow, fileId: FileId): Promise<void> => {
    const file = store.file(fileId);
    if (!file || file.kind === 'xmp') return;
    const abs = absolutePathOf(source, file);
    // The owning asset can change while we wait (e.g. a RAW+JPEG pair is confirmed): re-resolve after each await.
    const meta = await queue.run('metadata', run.token, () => inspectFile(abs));
    if (stopped() || (!meta.ok && meta.code === 'CANCELLED')) return;
    const insp = meta.ok && meta.value.ok ? meta.value.value : null;
    const metaError = !meta.ok ? meta.message : meta.value.ok ? null : meta.value.message;
    const previous = store.metadata(fileId);
    // A transient read failure must not erase a good earlier read of the same content.
    const keepPrevious = !insp && previous && !previous.error && previous.readHash === file.sampledHash;
    if (!keepPrevious) store.saveMetadata(fileId, insp?.metadata ?? null, file.sampledHash, metaError);
    if (metaError) emit('file-error', fileId, `${file.relativePath}: không đọc được metadata (${metaError})`);
    const owner = store.assetByFile(fileId);
    if (owner) store.refreshAssetDerived(owner.id);
    emit('metadata', fileId);

    const prev = await queue.run('image', run.token, () =>
      extractPreview(abs, store.cacheRoot, {
        kind: file.kind === 'jpeg' ? 'jpeg' : 'raw',
        orientation: insp?.metadata.orientation ?? null,
        cacheKey: `${fileId}|${file.sampledHash}`,
        candidates: insp?.candidates,
      }),
    );
    if (stopped() || (!prev.ok && prev.code === 'CANCELLED')) return;
    let result = prev.ok ? prev.value : { ok: false as const, code: prev.code, message: prev.message };
    if (!result.ok && result.code === 'NO_PREVIEW' && file.kind === 'raw') {
      // No usable embedded preview: decode the RAW itself (read-only, separate helper process).
      const fallback = await (ctx.rawQueue ?? queue).run('image', run.token, async (signal) => {
        const d = await decodeRaw(abs, signal);
        if (!d.ok) return { ok: false as const, code: d.code, message: d.message };
        const rec = await previewFromRgb({ data: d.value.rgb, width: d.value.width, height: d.value.height }, store.cacheRoot, `${fileId}|${file.sampledHash}|libraw`, 'LibRaw');
        return { ok: true as const, value: rec };
      });
      if (stopped() || (!fallback.ok && fallback.code === 'CANCELLED')) return;
      if (fallback.ok && fallback.value.ok) result = fallback.value;
      else if (fallback.ok) result = { ok: false as const, code: 'NO_PREVIEW', message: `Không có preview nhúng; giải mã RAW cũng lỗi (${fallback.value.code}).` };
    }
    if (result.ok) store.savePreview(fileId, result.value, file.sampledHash);
    else store.deletePreview(fileId);
    const fresh = store.assetByFile(fileId);
    if (fresh) {
      const fromPreview = statusFromAsset(store, fresh);
      if (fromPreview) store.setMediaStatus(fresh.id, fromPreview);
      else if (fresh.primaryFileId === fileId) {
        if (!result.ok && result.code === 'NO_PREVIEW') store.setMediaStatus(fresh.id, 'no-preview', result.message);
        else if (!result.ok) store.setMediaStatus(fresh.id, 'error', result.message);
      }
      if (ctx.onAssetMedia) await ctx.onAssetMedia(fresh.id, run.token);
      if (stopped()) return;
    }
    store.markJobFileDone(jobId, fileId);
    doneCount++;
    if (!result.ok) emit('file-error', fileId, `${file.relativePath}: ${result.message}`);
    emit('preview', fileId);
  };

  // One file failing must never take the whole job down.
  const process = (source: SourceRow, fileId: FileId): Promise<void> =>
    processFile(source, fileId).catch((e: unknown) => {
      if (!run.closing) emit('file-error', fileId, `Lỗi xử lý tệp: ${(e as Error)?.message ?? String(e)}`);
    });

  // Files left unfinished by an interrupted earlier run of this job.
  const sourceById = new Map(store.sources().map((s) => [s.id, s]));
  for (const jf of already) {
    if (jf.done) continue;
    const f = store.file(jf.fileId);
    const s = f ? sourceById.get(f.sourceId) : undefined;
    if (f && s) pending.push(process(s, f.id));
  }

  for (const source of sources) {
    if (stopped()) break;
    try {
      const st = await stat(source.rootPath);
      if (!st.isDirectory()) throw new Error('not a directory');
      store.setSourceOnline(source.id, true);
    } catch {
      store.setSourceOnline(source.id, false);
      emit('file-error', undefined, `Không truy cập được nguồn "${source.label}" (đã tháo ổ hoặc mất quyền?)`, true);
      continue;
    }
    const seen = new Set<FileId>();
    let walkFailed = false;
    try {
      for await (const f of walkSource(source.rootPath)) {
        if (stopped()) break;
        if (f.kind === 'dir-error') {
          walkFailed = true;
          emit('file-error', undefined, `Không đọc được thư mục "${f.relativePath}" trong nguồn "${source.label}": ${f.message}`);
          continue;
        }
        let row = store.fileByPath(source.id, f.relativePath);
        let needsWork: boolean;
        if (row && row.bytes === f.bytes && row.mtimeMs === f.mtimeMs) {
          if (row.missing || row.stale) store.setFileFlags(row.id, { missing: false, stale: false });
          needsWork = row.kind !== 'xmp' && !(store.metadata(row.id)?.readHash === row.sampledHash && store.preview(row.id)?.readHash === row.sampledHash);
        } else {
          let fp: { bytes: number; sampledHash: string };
          try {
            fp = await fingerprint(f.absolutePath);
          } catch (e) {
            emit('file-error', undefined, `${f.relativePath}: ${(e as Error).message}`);
            continue;
          }
          if (stopped()) break;
          row = store.fileByPath(source.id, f.relativePath);
          const changed = row !== undefined && (row.sampledHash !== fp.sampledHash || row.bytes !== fp.bytes);
          if (row && changed) {
            // Different content at a known path (another card, reformatted card, edited file):
            // it is a different photo. Never let it inherit the old photo's decisions.
            store.retireFile(row.id);
            emit(
              'file-error',
              row.id,
              `${f.relativePath}: nội dung khác với ảnh đã quét trước. Ảnh cũ giữ nguyên quyết định và được đánh dấu thiếu nguồn; tệp này được thêm như ảnh mới.`,
            );
            row = undefined;
          }
          if (row) {
            store.updateFileIdentity(row.id, fp.bytes, f.mtimeMs, fp.sampledHash);
            row = store.file(row.id)!;
            needsWork = row.kind !== 'xmp' && store.preview(row.id)?.readHash !== row.sampledHash;
          } else {
            const input = { sourceId: source.id, relativePath: f.relativePath, kind: f.kind, bytes: fp.bytes, mtimeMs: f.mtimeMs, sampledHash: fp.sampledHash };
            row = store.tx(() => {
              const inserted = store.insertFile(input);
              if (inserted.kind !== 'xmp') store.insertAsset(inserted.id);
              return inserted;
            });
            needsWork = row.kind !== 'xmp';
          }
        }
        seen.add(row.id);
        discovered++;
        if (needsWork) {
          if (!inJob.has(row.id)) {
            inJob.add(row.id);
            store.addJobFile(jobId, row.id, seq++);
            total++;
            pending.push(process(source, row.id));
          }
        }
        emit('discovered', row.id, `Đã tìm thấy ${discovered} tệp`);
      }
    } catch (e) {
      walkFailed = true;
      emit('file-error', undefined, `Lỗi khi đọc nguồn "${source.label}": ${(e as Error).message}`, true);
    }
    if (!stopped() && !walkFailed) {
      for (const f of store.filesOfSource(source.id)) if (!seen.has(f.id) && !f.missing) store.setFileFlags(f.id, { missing: true });
      linkSidecars(store, source.id);
    }
  }
  await Promise.all(pending);
  if (run.closing) return; // project closed mid-scan: job stays 'running' and resumes on next open
  const cancelled = queue.isCancelled(run.token);
  ctx.afterScan?.();
  const state = cancelled ? 'cancelled' : errors > 0 ? 'complete-with-errors' : 'complete';
  store.setJobState(jobId, state);
  const summary = errors > 0 ? `Xong nhưng có ${errors} lỗi/cảnh báo — xem danh sách thông báo.` : undefined;
  emit(cancelled ? 'cancelled' : 'complete', undefined, summary, true);
}

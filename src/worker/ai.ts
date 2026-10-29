import { createHash } from 'node:crypto';
import sharp, { type Metadata } from 'sharp';
import { extractEmbedded, inspectFile } from '../media/exiftool';
import { compatibleInputKey, encodeForAnalysis, MAX_ANALYSIS_INPUT_PIXELS, PREP_VERSION, type AnalysisJpeg } from '../media/analysis-image';
import { decodeRaw, librawVersion } from '../media/libraw';
import { previewFromRgb } from '../media/previews';
import type { AssetCore, ProjectStore } from '../project/store';
import type { AiQuotaView, AnalysisSourceKind, ProgressEvent, Result } from '../shared/contracts';
import { err, ok } from '../shared/schemas';
import type { MediaQueue } from './queue';
import { absolutePathOf } from './scan';

export const PROVIDER = 'aws-rekognition-detectfaces';
const REQUEST_TIMEOUT_MS = 55_000;
const EMBEDDED_ENOUGH_EDGE = 2000;

export type ClientResult =
  | { kind: 'done'; requestId: string; faces: unknown[] }
  | { kind: 'processing'; requestId: string }
  | { kind: 'failed'; requestId: string | null; code: string }
  | { kind: 'quota'; code: string }
  | { kind: 'unauthorized' }
  | { kind: 'rejected'; status: number; code: string }
  | { kind: 'not-found' }
  | { kind: 'network'; message: string };

/** HTTP client for the pilot backend. Never retries on its own: a retry reuses the same idempotency key. */
export class AiClient {
  private readonly base: string;
  constructor(
    endpoint: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = endpoint.replace(/\/+$/, '');
  }

  private async call(path: string, init: RequestInit): Promise<{ status: number; json: Record<string, unknown> | null } | { network: string }> {
    try {
      const r = await this.fetchImpl(`${this.base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${this.token}`, ...(init.headers as Record<string, string>) },
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const json = (await r.json().catch(() => null)) as Record<string, unknown> | null;
      return { status: r.status, json };
    } catch (e) {
      return { network: (e as Error)?.message ?? String(e) };
    }
  }

  private interpret(r: Awaited<ReturnType<AiClient['call']>>): ClientResult {
    if ('network' in r) return { kind: 'network', message: r.network };
    const j = r.json ?? {};
    if (r.status === 200 && j.status === 'done') return { kind: 'done', requestId: String(j.requestId), faces: (j.faces as unknown[]) ?? [] };
    if ((r.status === 200 || r.status === 502) && j.status === 'failed') return { kind: 'failed', requestId: (j.requestId as string) ?? null, code: String(j.errorCode ?? 'PROVIDER_ERROR') };
    if (r.status === 202 || (r.status === 200 && j.status === 'processing')) return { kind: 'processing', requestId: String(j.requestId) };
    if (r.status === 401) return { kind: 'unauthorized' };
    if (r.status === 429) return { kind: 'quota', code: String(j.error ?? 'QUOTA_EXHAUSTED') };
    if (r.status === 404) return { kind: 'not-found' };
    if (r.status >= 500) return { kind: 'network', message: `HTTP ${r.status}` };
    return { kind: 'rejected', status: r.status, code: String(j.error ?? `HTTP_${r.status}`) };
  }

  async analyze(jpeg: Buffer, idempotencyKey: string, signal?: AbortSignal): Promise<ClientResult> {
    return this.interpret(
      await this.call('/v1/face-analysis', {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey, 'content-type': 'image/jpeg' },
        body: new Uint8Array(jpeg),
        signal,
      }),
    );
  }

  async getRequest(requestId: string, signal?: AbortSignal): Promise<ClientResult> {
    return this.interpret(await this.call(`/v1/requests/${encodeURIComponent(requestId)}`, { method: 'GET', signal }));
  }

  async quota(): Promise<Result<AiQuotaView>> {
    const r = await this.call('/v1/quota', { method: 'GET' });
    if ('network' in r) return err('AI_NETWORK', `Không kết nối được dịch vụ phân tích: ${r.network}`);
    if (r.status === 401) return err('AI_UNAUTHORIZED', 'Token phân tích không hợp lệ hoặc đã bị thu hồi.');
    if (r.status !== 200 || !r.json) return err('AI_ERROR', `Dịch vụ phân tích trả HTTP ${r.status}.`);
    return ok(r.json as unknown as AiQuotaView);
  }
}

/** Which file the analysis JPEG comes from: a confirmed companion JPEG wins over the RAW. */
export function analysisRole(asset: AssetCore): { role: 'companion' | 'primary'; fileId: string } {
  return asset.companionJpegId && asset.pairConfirmed ? { role: 'companion', fileId: asset.companionJpegId } : { role: 'primary', fileId: asset.primaryFileId };
}

export function expectedInputKey(store: ProjectStore, asset: AssetCore): string | null {
  const { role, fileId } = analysisRole(asset);
  const f = store.file(fileId);
  return f ? compatibleInputKey(role, f.id, f.sampledHash, store.faceAnalysis(asset.id)?.inputKey) : null;
}

export function idempotencyKeyFor(projectId: string, assetId: string, inputKey: string): string {
  return createHash('sha256').update(`${projectId}|${assetId}|${inputKey}|${PROVIDER}`).digest('base64url');
}

export interface PreparedAnalysis extends AnalysisJpeg {
  kind: AnalysisSourceKind;
  fileId: string;
  /** Full decoded RGB when LibRaw was used (can become the display preview). */
  libraw?: { data: Buffer; width: number; height: number };
}

/**
 * Builds the analysis JPEG from the best available source, read-only:
 * (1) confirmed companion JPEG or JPEG original, (2) the largest embedded JPEG if it has enough
 * detail (long edge ≥ 2000 px, ≤ 60 MP), (3) LibRaw decode otherwise; if LibRaw fails, a small
 * embedded JPEG is still used (marked embedded-small). Errors carry a specific code.
 */
export async function prepareAnalysisImage(store: ProjectStore, asset: AssetCore, signal: AbortSignal): Promise<PreparedAnalysis> {
  const { role, fileId } = analysisRole(asset);
  const file = store.file(fileId);
  const source = file ? store.source(file.sourceId) : undefined;
  if (!file || !source || !source.online || file.missing) throw Object.assign(new Error('Thiếu tệp nguồn.'), { code: 'SOURCE_MISSING' });
  const abs = absolutePathOf(source, file);
  if (file.kind === 'jpeg') {
    const a = await encodeForAnalysis(abs, { autoOrient: true });
    return { ...a, kind: role === 'companion' ? 'companion-jpeg' : 'jpeg-original', fileId };
  }
  const insp = await inspectFile(abs);
  let small: { buf: Buffer; orientation: number | null } | null = null;
  if (insp.ok) {
    for (const c of insp.value.candidates) {
      if (c.bytes < 2048) continue;
      let buf: Buffer;
      try {
        buf = await extractEmbedded(abs, c.tag);
      } catch {
        continue;
      }
      let meta: Metadata;
      try {
        meta = await sharp(buf).metadata();
      } catch {
        continue;
      }
      if (!meta.width || !meta.height || meta.width * meta.height > MAX_ANALYSIS_INPUT_PIXELS) continue;
      const own = meta.orientation && meta.orientation !== 1 ? meta.orientation : null;
      const orientation = own ?? insp.value.metadata.orientation;
      if (Math.max(meta.width, meta.height) >= EMBEDDED_ENOUGH_EDGE) {
        return { ...(await encodeForAnalysis(buf, { orientation })), kind: 'embedded', fileId };
      }
      small ??= { buf, orientation };
    }
  }
  if (signal.aborted) throw Object.assign(new Error('Đã hủy.'), { code: 'CANCELLED' });
  const decoded = await decodeRaw(abs, signal);
  if (decoded.ok) {
    const rgb = { data: decoded.value.rgb, width: decoded.value.width, height: decoded.value.height };
    // LibRaw output is already rotated: do not apply the EXIF orientation again.
    return { ...(await encodeForAnalysis({ raw: rgb }, { orientation: null })), kind: 'libraw', fileId, libraw: rgb };
  }
  if (decoded.code === 'CANCELLED') throw Object.assign(new Error(decoded.message), { code: 'CANCELLED' });
  if (small) return { ...(await encodeForAnalysis(small.buf, { orientation: small.orientation })), kind: 'embedded-small', fileId };
  throw Object.assign(new Error(`Không tạo được ảnh phân tích: ${decoded.message}`), { code: decoded.code });
}

/** Saves the LibRaw decode as the display preview when the embedded one was small or missing. */
export async function saveLibrawPreview(store: ProjectStore, asset: AssetCore, rgb: { data: Buffer; width: number; height: number }): Promise<void> {
  const file = store.file(asset.primaryFileId);
  if (!file) return;
  const current = store.preview(file.id);
  if (current && !current.insufficientForFocus) return;
  const version = (await librawVersion()) ?? 'LibRaw';
  const rec = await previewFromRgb(rgb, store.cacheRoot, `|${file.sampledHash}|libraw`, `LibRaw ${version}`);
  store.savePreview(file.id, rec, file.sampledHash);
  const a = store.asset(asset.id);
  const dp = a ? store.displayPreview(a) : null;
  if (a && dp) store.setMediaStatus(a.id, dp.insufficientForFocus ? 'preview-small' : 'ready');
}
export interface AnalysisRun {
  jobId: string;
  projectId: string;
  cancelled: boolean;
  controller?: AbortController;
  done: Promise<unknown>;
}

export interface AnalysisOutcome {
  status: 'complete' | 'stopped' | 'cancelled';
  message?: string;
  /** Photos whose request hit a network error (kept pending; read back on the next run). */
  networkErrors: number;
}

/**
 * Analyses the given assets one by one. A cached result for the same input is reused; a pending
 * request is read back first; every send reuses a deterministic idempotency key, so a lost
 * response never causes a second paid call. A late response is saved only if the asset still has
 * the same input. Quota or token problems stop the run with a clear message.
 */
export async function runFaceAnalysis(
  ctx: { store: ProjectStore; queue: MediaQueue; client: AiClient; emit(e: ProgressEvent): void },
  run: AnalysisRun,
  assetIds: string[],
  opts: { retryFailed?: boolean } = {},
): Promise<AnalysisOutcome> {
  const { store, client } = ctx;
  const total = assetIds.length;
  let done = 0;
  let networkStreak = 0;
  let networkErrors = 0;
  const emit = (phase: Extract<ProgressEvent, { kind: 'analysis' }>['phase'], message?: string, assetId?: string): AnalysisOutcome => {
    ctx.emit({ kind: 'analysis', projectId: run.projectId, jobId: run.jobId, phase, done, total, assetId, message });
    return { status: phase === 'progress' ? 'complete' : phase, message, networkErrors };
  };
  const now = () => new Date().toISOString();

  for (const id of assetIds) {
    if (run.cancelled) return emit('cancelled', 'Đã hủy phân tích.');
    const asset = store.asset(id);
    const key = asset ? expectedInputKey(store, asset) : null;
    if (!asset || !key) {
      done++;
      continue;
    }
    const row = store.faceAnalysis(id);
    let current = row && row.provider === PROVIDER && row.inputKey === key ? row : null;
    let idem = current?.status === 'pending' ? current.idempotencyKey : idempotencyKeyFor(run.projectId, id, key);
    if (current?.status === 'failed' && opts.retryFailed) {
      // An explicit retry is a new paid call, so it needs a new key (the old one replays the stored failure).
      idem = createHash('sha256').update(`${current.idempotencyKey}|retry`).digest('base64url');
      current = null;
    }
    if (current && (current.status === 'done' || current.status === 'failed')) {
      done++;
      emit('progress', undefined, id);
      continue;
    }

    const save = (r: ClientResult, meta: { width: number | null; height: number | null; bytes: number | null; kind: AnalysisSourceKind; fileId: string }) => {
      const a = store.asset(id);
      if (!a || expectedInputKey(store, a) !== key) return; // late response for content that changed: discard
      const base = { assetId: id, inputKey: key, sourceKind: meta.kind, sourceFileId: meta.fileId, prepVersion: PREP_VERSION, provider: PROVIDER, idempotencyKey: idem, imageWidth: meta.width, imageHeight: meta.height, uploadBytes: meta.bytes, updatedAt: now() };
      if (r.kind === 'done') store.upsertFaceAnalysis({ ...base, requestId: r.requestId, status: 'done', resultJson: JSON.stringify(r.faces), error: null });
      else if (r.kind === 'failed') store.upsertFaceAnalysis({ ...base, requestId: r.requestId, status: 'failed', resultJson: null, error: r.code });
      else if (r.kind === 'rejected') store.upsertFaceAnalysis({ ...base, requestId: null, status: 'failed', resultJson: null, error: r.code });
      else if (r.kind === 'processing') store.upsertFaceAnalysis({ ...base, requestId: r.requestId, status: 'pending', resultJson: null, error: null });
    };

    let result: ClientResult;
    if (current && current.status === 'pending') {
      const meta = { width: current.imageWidth, height: current.imageHeight, bytes: current.uploadBytes, kind: current.sourceKind, fileId: current.sourceFileId };
      result = current.requestId ? await client.getRequest(current.requestId, run.controller?.signal) : { kind: 'not-found' };
      if (result.kind === 'not-found') {
        // Re-send with the SAME key: the backend returns the stored result if the first call went through.
        const prep = await ctx.queue.run('image', run.jobId, (signal) => prepareAnalysisImage(store, asset, signal));
        if (!prep.ok) {
          done++;
          emit('progress', `Không chuẩn bị được ảnh: ${prep.message}`, id);
          continue;
        }
        const still = store.asset(id);
        if (run.cancelled) return emit('cancelled', 'Đã hủy phân tích.');
        if (!still || expectedInputKey(store, still) !== key) { done++; continue; }
        result = await client.analyze(prep.value.jpeg, idem, run.controller?.signal);
        Object.assign(meta, { width: prep.value.width, height: prep.value.height, bytes: prep.value.jpeg.length, kind: prep.value.kind, fileId: prep.value.fileId });
      }
      if (result.kind !== 'network' && result.kind !== 'quota' && result.kind !== 'unauthorized') save(result, meta);
    } else {
      const prep = await ctx.queue.run('image', run.jobId, async (signal) => {
        const p = await prepareAnalysisImage(store, asset, signal);
        // A LibRaw decode also upgrades a small embedded display preview; free the RGB right after.
        if (p.libraw) await saveLibrawPreview(store, asset, p.libraw).catch(() => {});
        return { ...p, libraw: undefined };
      });
      // The asset may have been merged into a pair or changed while its image was prepared.
      const still = store.asset(id);
      if (run.cancelled) return emit('cancelled', 'Đã hủy phân tích.');
      if (!still || expectedInputKey(store, still) !== key) {
        done++;
        emit('progress', undefined, id);
        continue;
      }
      if (!prep.ok) {
        const code = (prep as { code: string }).code;
        if (code !== 'CANCELLED') {
          store.upsertFaceAnalysis({
            assetId: id, inputKey: key, sourceKind: 'embedded', sourceFileId: asset.primaryFileId, prepVersion: PREP_VERSION, provider: PROVIDER,
            idempotencyKey: idem, requestId: null, status: 'failed', imageWidth: null, imageHeight: null, uploadBytes: null, resultJson: null,
            error: `LOCAL:${prep.message}`, updatedAt: now(),
          });
        }
        done++;
        emit('progress', `Không chuẩn bị được ảnh: ${prep.message}`, id);
        continue;
      }
      const meta = { width: prep.value.width, height: prep.value.height, bytes: prep.value.jpeg.length, kind: prep.value.kind, fileId: prep.value.fileId };
      // Record the intent before sending, so a crash or lost response can be resumed with the same key.
      store.upsertFaceAnalysis({ assetId: id, inputKey: key, sourceKind: meta.kind, sourceFileId: meta.fileId, prepVersion: PREP_VERSION, provider: PROVIDER, idempotencyKey: idem, requestId: null, status: 'pending', imageWidth: meta.width, imageHeight: meta.height, uploadBytes: meta.bytes, resultJson: null, error: null, updatedAt: now() });
      result = await client.analyze(prep.value.jpeg, idem, run.controller?.signal);
      if (result.kind !== 'network' && result.kind !== 'quota' && result.kind !== 'unauthorized') save(result, meta);
    }

    if (run.cancelled) return emit('cancelled', 'Đã hủy phân tích.');
    if (result.kind === 'quota') {
      if (current?.status !== 'pending') store.deleteFaceAnalysisIfPending(id, key);
      return emit('stopped', result.code === 'GLOBAL_QUOTA_EXHAUSTED' ? 'Hết lượt phân tích chung của pilot trong tháng.' : 'Hết lượt phân tích của bạn trong tháng.');
    }
    if (result.kind === 'unauthorized') {
      if (current?.status !== 'pending') store.deleteFaceAnalysisIfPending(id, key);
      return emit('stopped', 'Token phân tích không hợp lệ hoặc đã bị thu hồi.');
    }
    if (result.kind === 'network') {
      networkStreak++;
      networkErrors++;
      done++;
      emit('progress', `Mất kết nối khi phân tích (sẽ đọc lại kết quả ở lần chạy sau): ${result.message}`, id);
      if (networkStreak >= 3) return emit('stopped', 'Mất kết nối tới dịch vụ phân tích. Các ảnh đã xử lý vẫn dùng được; chạy lại khi có mạng.');
      continue;
    }
    networkStreak = 0;
    done++;
    emit('progress', undefined, id);
  }
  return emit('complete');
}

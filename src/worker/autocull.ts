import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { rankGroup, type RankInput } from '../culling/ranking';
import { faceCropSharpness, FEATURE_ALGORITHM } from '../media/features';
import type { CullRecommendationRow, ProjectStore } from '../project/store';
import type { AssetId, ProgressEvent } from '../shared/contracts';
import { expectedInputKey, analysisRole, runFaceAnalysis, PROVIDER, type AiClient, type AnalysisRun } from './ai';
import { contentHashIdentity, exactDuplicateSets, regroup, type GroupState } from './grouping';
import { groupRevision, revisionContext } from './revision';
import type { MediaQueue } from './queue';
import { absolutePathOf } from './scan';
import { runLocalAnalysis, type LocalDetect } from './local-analysis';
import { LOCAL_PROVIDER } from '../shared/local-analysis';

export interface AutoCullRun {
  runId: string;
  projectId: string;
  cancelled: boolean;
  analysis: AnalysisRun;
  done: Promise<unknown>;
}

export interface AutoCullContext {
  project: GroupState & { runs: Map<string, { done: Promise<unknown> }> };
  /** Main media queue (face crops). */
  queue: MediaQueue;
  /** Single-slot queue used for analysis image preparation. */
  analysisQueue: MediaQueue;
  /** null when the analysis service is not configured: the run still groups and ranks. */
  client: AiClient | null;
  localDetect?: LocalDetect;
  /** Why analysis is not allowed right now (shown instead of the generic message). */
  aiBlocked?: string | null;
  emit(e: ProgressEvent): void;
  /** Face-crop sharpness per asset + analysis input + preview, reused across runs. */
  cropCache: Map<string, (number | null)[]>;
}

const sha256File = (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });

/** Full SHA-256 only for files that share size and content sample with another file (cached). */
async function hashDuplicateCandidates(store: ProjectStore, stopped: () => boolean): Promise<void> {
  const buckets = new Map<string, { id: string; abs: string; sampledHash: string }[]>();
  for (const a of store.allAssets()) {
    const f = store.file(a.primaryFileId);
    const s = f ? store.source(f.sourceId) : undefined;
    if (!f || !s || !s.online || f.missing || f.stale) continue;
    const key = `${f.bytes}|${f.sampledHash}`;
    const entry = { id: f.id, abs: absolutePathOf(s, f), sampledHash: contentHashIdentity(f) };
    const list = buckets.get(key);
    if (list) list.push(entry);
    else buckets.set(key, [entry]);
  }
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    for (const f of list) {
      if (stopped()) return;
      if (store.contentHash(f.id)?.sampledHash === f.sampledHash) continue;
      try {
        const indexed = store.file(f.id)!;
        const before = await stat(f.abs);
        if (before.size !== indexed.bytes || before.mtimeMs !== indexed.mtimeMs) continue;
        const sha = await sha256File(f.abs);
        const after = await stat(f.abs);
        if (after.size === before.size && after.mtimeMs === before.mtimeMs && contentHashIdentity(store.file(f.id)!) === f.sampledHash) {
          store.saveContentHash(f.id, f.sampledHash, sha);
        }
      } catch {
        /* unreadable now: not treated as a duplicate */
      }
    }
  }
}

/** Assets that still need a face analysis result for their current input. */
function needsAnalysis(store: ProjectStore, assetId: AssetId, provider = PROVIDER): boolean {
  const a = store.asset(assetId);
  if (!a) return false;
  const f = store.file(analysisRole(a).fileId);
  const s = f ? store.source(f.sourceId) : undefined;
  if (!f || !s || !s.online || f.missing) return false;
  const key = expectedInputKey(store, a);
  const row = store.faceAnalysis(assetId);
  return !(row && row.provider === provider && row.inputKey === key && (row.status === 'done' || provider === PROVIDER && row.status === 'failed'));
}

async function rankAlbum(ctx: AutoCullContext, run: AutoCullRun): Promise<Omit<CullRecommendationRow, 'runId'>[]> {
  const { store, groups } = ctx.project;
  const features = store.features();
  const dupSetOf = new Map<AssetId, number>();
  exactDuplicateSets(store).forEach((set, i) => set.forEach((id) => dupSetOf.set(id, i)));
  // Snapshot first: anything that changes while ranking makes the stored revision stale (safe side).
  const revCtx = revisionContext(store);
  const grouped = new Set(groups.flatMap((g) => g.assetIds));
  const all = [...groups.map((g) => ({ id: g.id, assetIds: g.assetIds })), ...store.allAssets().filter((a) => !grouped.has(a.id)).map((a) => ({ id: `single:${a.id}`, assetIds: [a.id] }))];
  const out: Omit<CullRecommendationRow, 'runId'>[] = [];

  for (const g of all) {
    if (run.cancelled) return out;
    const inputs: RankInput[] = [];
    for (const id of g.assetIds) {
      const a = store.asset(id);
      if (!a) continue;
      const view = store.analysisView(a);
      const row = store.faceAnalysis(id);
      const feat = features.get(id);
      const vec = feat && feat.algorithmVersion === FEATURE_ALGORITHM ? (JSON.parse(feat.json) as { laplacianVariance: number; clippedFraction: number }) : null;
      const faces = view?.status === 'done' ? (view.faces ?? []) : null;
      let crops: (number | null)[] = [];
      const dp = store.displayPreview(a);
      if (faces && faces.length && dp && row) {
        const key = `${id}|${row.provider}|${row.inputKey}|${row.updatedAt}|${dp.cacheId}`;
        const cached = ctx.cropCache.get(key);
        if (cached) crops = cached;
        else {
          const r = await ctx.queue.run('image', run.runId, () => faceCropSharpness(path.join(store.cacheRoot, dp.cacheId), faces.map((f) => f.bbox)));
          if (r.ok) {
            crops = r.value;
            ctx.cropCache.set(key, crops);
          }
        }
      }
      inputs.push({
        assetId: id,
        analysis: view ? view.status : 'none',
        faces,
        faceCropSharpness: crops,
        wholeImageSharpness: vec?.laplacianVariance ?? null,
        clippedFraction: vec?.clippedFraction ?? null,
      });
    }
    const revision = groupRevision(revCtx, g.assetIds);
    const ranked = rankGroup(inputs);
    // Byte-identical copies: every copy except the best-ranked one is marked.
    const seenDup = new Set<number>();
    for (const r of ranked) {
      const set = dupSetOf.get(r.assetId);
      if (set === undefined) continue;
      if (seenDup.has(set)) r.reasons.push('EXACT_DUPLICATE');
      else seenDup.add(set);
    }
    for (const r of ranked) {
      out.push({ assetId: r.assetId, groupId: g.id, rank: r.rank, label: r.label, bestAssetId: r.bestAssetId, reasons: r.reasons, quality: r.quality, revision });
    }
  }
  return out;
}

/**
 * One AutoCull pass over the whole album: exact-duplicate hashing, grouping with the project's
 * preset, face analysis of photos without a current result, ranking of every group, and storing
 * the recommendations. Decisions are never written. Without AI settings, offline or out of quota
 * the run still ranks what it can and ends "paused" with an honest message.
 */
export async function runAutoCull(ctx: AutoCullContext, run: AutoCullRun): Promise<void> {
  const { store } = ctx.project;
  const emit = (phase: Extract<ProgressEvent, { kind: 'autocull' }>['phase'], done = 0, total = 0, message?: string) =>
    ctx.emit({ kind: 'autocull', projectId: run.projectId, runId: run.runId, phase, done, total, message });
  const finish = (status: 'complete' | 'paused' | 'cancelled' | 'failed', message?: string) => {
    try {
      store.updateCullRun(run.runId, { status, error: message ?? null });
    } catch {
      /* store closed while finishing */
    }
    emit(status, 0, 0, message);
  };
  const cancelled = () => run.cancelled;
  try {
    // A scan in progress changes the album; wait for it to settle first.
    await Promise.all([...ctx.project.runs.values()].map((r) => r.done.catch(() => {})));
    if (cancelled()) return finish('cancelled', 'Đã hủy AutoCull.');
    emit('hashing');
    await hashDuplicateCandidates(store, cancelled);
    if (cancelled()) return finish('cancelled', 'Đã hủy AutoCull.');
    emit('grouping');
    regroup(ctx.project);
    const order = store.assetIdsInAlbumOrder();
    store.updateCullRun(run.runId, { total: order.length });

    let pause: string | null = null;
    const need = order.filter((id) => needsAnalysis(store, id, ctx.localDetect ? LOCAL_PROVIDER : PROVIDER));
    if (need.length && ctx.localDetect) {
      emit('analysis', 0, need.length);
      const outcome = await runLocalAnalysis({ store, queue: ctx.analysisQueue, detect: ctx.localDetect, emit: ctx.emit }, run.analysis, need);
      if (outcome.status === 'cancelled' || cancelled()) return finish('cancelled', 'Đã hủy phân tích local. Các kết quả đã xong được giữ lại.');
      if (outcome.status === 'stopped') pause = outcome.message ?? 'Phân tích local dừng.';
    } else if (need.length && !ctx.client) {
      pause = `${ctx.aiBlocked ?? 'Chưa cấu hình dịch vụ phân tích AI'}: ${need.length} ảnh chưa được phân tích khuôn mặt nên nằm trong "Cần xem lại". Các bước còn lại vẫn chạy.`;
    } else if (need.length) {
      emit('analysis', 0, need.length);
      const outcome = await runFaceAnalysis({ store, queue: ctx.analysisQueue, client: ctx.client!, emit: ctx.emit }, run.analysis, need);
      if (outcome.status === 'cancelled' || cancelled()) return finish('cancelled', 'Đã hủy AutoCull. Ảnh đã phân tích được giữ lại; chạy lại sẽ tiếp tục phần còn thiếu.');
      if (outcome.status === 'stopped') pause = outcome.message ?? 'Phân tích dừng giữa chừng.';
      else if (outcome.networkErrors > 0)
        pause = `Mất kết nối tới dịch vụ phân tích: ${outcome.networkErrors} ảnh chưa có kết quả (nằm trong "Cần xem lại"). Chạy lại khi có mạng; ảnh đã gửi sẽ được đọc lại, không tính phí lần hai.`;
    }

    emit('ranking', 0, order.length);
    const recs = await rankAlbum(ctx, run);
    if (cancelled()) return finish('cancelled', 'Đã hủy AutoCull.');
    store.tx(() => {
      store.replaceRecommendations(run.runId, recs);
      store.updateCullRun(run.runId, { done: order.length });
    });
    finish(pause ? 'paused' : 'complete', pause ?? undefined);
  } catch (e) {
    finish('failed', `AutoCull lỗi: ${(e as Error)?.message ?? e}`);
  }
}

export const AUTOCULL_PROVIDER = PROVIDER;

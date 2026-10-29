import { readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeExifTool, cameraIdFor, configureExifTool, exiftoolVersion } from '../media/exiftool';
import { comparablePath, pathsOverlap } from '../main/paths';
import { NO_CULL, ProjectStore, type SourceRow } from '../project/store';
import type {
  AssetPage,
  AssetQuery,
  DeliveryEvent,
  AiQuotaView,
  CullState,
  ExportPlanView,
  ExportReport,
  ExportSet,
  FileRecord,
  Group,
  PackId,
  PackSuggestion,
  PairCandidate,
  ProgressEvent,
  ProjectCommand,
  ProjectSnapshot,
  ProjectState,
  Result,
} from '../shared/contracts';
import { AssetQuerySchema, err, newId, ok, parseProjectCommand, validate } from '../shared/schemas';
import { planExport as planExportFn, memberKeyOf, membersOfPack, metadataKeyOf, revisionKeyOf, type ExportPlan } from '../export/plan';
import { executeExport as executeExportFn } from '../export/write';
import { exportPortable as exportPortableFn, importPortable as importPortableFn } from '../project/portable';
import { fingerprint } from '../source/fingerprint';
import { relinkAssets } from '../source/relink';
import { walkSource } from '../source/scanner';
import { evictPreviewCache, PREVIEW_CACHE_BYTES, restorePreview } from './cache';
import { AiClient, runFaceAnalysis, type AnalysisRun } from './ai';
import { AUTOCULL_PROVIDER, runAutoCull, type AutoCullRun } from './autocull';
import { CullIndexCache, selectedOf } from './cull-view';
import { QUALITY_CONFIG } from '../culling/ranking';
import { groupingPreset } from '../culling/groups';
import { MediaQueue } from './queue';
import { applyReviewCommand, REVIEW_COMMANDS, restoreSnapshot, type UndoSnapshot } from '../culling/decisions';
import { buildDeliveryEvent } from '../culling/delivery';
import { suggestPack, type PackInput } from '../culling/packs';
import { computeAssetFeatures, loadGroups, regroup, setGroups } from './grouping';
import { confirmPairs, loadReviewModel, pairCandidatesOf, persistReviewModel } from './review';
import { absolutePathOf, runScan, type ScanRun } from './scan';
import type { LocalDetect } from './local-analysis';
import { LOCAL_PROVIDER } from '../shared/local-analysis';

export interface ServiceDeps {
  emit(event: ProgressEvent): void;
  localDetect?: LocalDetect;
  totalMemBytes?: number;
}

export function resourceBudget(totalMemBytes: number): { metadataJobs: number; imageJobs: number } {
  const gib = totalMemBytes / 1024 ** 3;
  return gib >= 15 ? { metadataJobs: 4, imageJobs: 2 } : { metadataJobs: 2, imageJobs: 1 };
}

interface ExportJob {
  projectId: string;
  controller: AbortController;
  report: ExportReport | null;
  folder: string | null;
  done: Promise<void>;
}

export interface OpenProject {
  store: ProjectStore;
  runs: Map<string, ScanRun>;
  groupIndex: Map<string, string>;
  groups: Group[];
  /** Face-crop sharpness cache for AutoCull ranking. */
  cropCache: Map<string, (number | null)[]>;
  cullCache: CullIndexCache;
}

/** All worker operations. Methods map 1:1 to RPC method names; each returns a Result. */
export function createService(deps: ServiceDeps) {
  const totalMem = deps.totalMemBytes ?? Number(process.env.EVENTSTORY_TOTAL_MEM || os.totalmem());
  const budget = resourceBudget(totalMem);
  configureExifTool({ maxProcs: budget.metadataJobs });
  const queue = new MediaQueue({ ...budget, timeoutMs: 60_000 });
  const projects = new Map<string, OpenProject>();
  const jobProject = new Map<string, string>();
  const plans = new Map<string, ExportPlan>();
  // Face analysis: credentials live only in this process's memory (main keeps the encrypted copy).
  let aiCreds: { endpoint: string; token: string } | null = null;
  // One analysis image is prepared/decoded at a time.
  const analysisQueue = new MediaQueue({ metadataJobs: 1, imageJobs: 1, timeoutMs: 120_000 });
  const analysisRuns = new Map<string, AnalysisRun>();
  const autoCullRuns = new Map<string, AutoCullRun>();
  const exportJobs = new Map<string, ExportJob>();
  let runCounter = 0;

  const project = (projectId: string): Result<OpenProject> => {
    const p = projects.get(projectId);
    return p ? ok(p) : err('PROJECT_NOT_OPEN', 'Dự án chưa được mở.');
  };

  const startRun = (p: OpenProject, jobId: string, sources: SourceRow[]): ScanRun => {
    const run: ScanRun = { jobId, token: `${jobId}#${++runCounter}`, closing: false, userCancelled: false, done: Promise.resolve() };
    jobProject.set(jobId, p.store.id);
    p.runs.set(jobId, run);
    const ctx = {
      store: p.store,
      queue,
      rawQueue: analysisQueue,
      emit: deps.emit,
      onAssetMedia: (assetId: string, token: string) => computeAssetFeatures(p.store, queue, token, assetId),
      afterScan: () => {
        regroup(p);
        void evictPreviewCache(p.store).catch(() => {});
      },
    };
    run.done = runScan(ctx, run, sources)
      .catch((e: unknown) => {
        deps.emit({ kind: 'scan', projectId: p.store.id, jobId, phase: 'file-error', done: 0, total: 0, message: String((e as Error)?.message ?? e) });
        if (!run.closing) {
          try {
            p.store.setJobState(jobId, 'failed');
          } catch {
            /* store closed */
          }
          deps.emit({ kind: 'scan', projectId: p.store.id, jobId, phase: 'cancelled', done: 0, total: 0, message: 'Quét bị lỗi' });
        }
      })
      .finally(() => p.runs.delete(jobId));
    return run;
  };

  /** Marks files whose size/mtime changed since indexing as stale and vanished sources as offline. */
  const checkSources = async (store: ProjectStore): Promise<void> => {
    for (const s of store.sources()) {
      let online = false;
      try {
        online = (await stat(s.rootPath)).isDirectory();
      } catch {
        online = false;
      }
      store.setSourceOnline(s.id, online);
      if (!online) continue;
      for (const f of store.filesOfSource(s.id)) {
        try {
          const st = await stat(absolutePathOf(s, f));
          const changed = st.size !== f.bytes || st.mtimeMs !== f.mtimeMs;
          if (changed !== f.stale || f.missing) store.setFileFlags(f.id, { stale: changed, missing: false });
        } catch {
          if (!f.missing) store.setFileFlags(f.id, { missing: true });
        }
      }
    }
  };

  const register = async (store: ProjectStore): Promise<ProjectSnapshot> => {
    const p: OpenProject = { store, runs: new Map(), groupIndex: new Map(), groups: [], cropCache: new Map(), cullCache: new CullIndexCache() };
    store.pauseInterruptedCullRuns();
    projects.set(store.id, p);
    loadGroups(p);
    await checkSources(store);
    if (p.groups.length === 0 && store.allAssets().length > 0) regroup(p);
    // Resume scans interrupted by closing the app.
    for (const job of store.runningJobs()) {
      if (job.kind !== 'scan') continue;
      const ids = ((job.params as { sourceIds?: string[] }).sourceIds ?? []).filter((id) => store.source(id));
      startRun(p, job.id, ids.map((id) => store.source(id)!));
    }
    return store.snapshot();
  };

  const closeOne = async (projectId: string): Promise<void> => {
    const p = projects.get(projectId);
    if (!p) return;
    const mine = [...analysisRuns.values()].filter((r) => r.projectId === projectId);
    for (const r of mine) stopAnalysis(r);
    const culls = [...autoCullRuns.values()].filter((r) => r.projectId === projectId);
    for (const r of culls) stopAutoCull(r);
    for (const run of p.runs.values()) {
      run.closing = true;
      queue.cancelJob(run.token);
      analysisQueue.cancelJob(run.token);
    }
    await Promise.all([...mine.map((r) => r.done), ...culls.map((r) => r.done), ...[...p.runs.values()].map((r) => r.done)]);
    projects.delete(projectId);
    p.store.close();
  };

  const stopAnalysis = (r: AnalysisRun): void => {
    r.cancelled = true;
    r.controller?.abort();
    analysisQueue.cancelJob(r.jobId);
  };

  const stopAutoCull = (r: AutoCullRun): void => {
    r.cancelled = true;
    stopAnalysis(r.analysis);
    queue.cancelJob(r.runId);
  };

  const assertAssets = (p: OpenProject, ids: readonly string[]): Result<void> => {
    const unknown = p.store.unknownAssetIds(ids);
    return unknown.length ? err('UNKNOWN_ID', `ID không thuộc dự án: ${unknown.slice(0, 3).join(', ')}`) : ok(undefined);
  };

  const service = {
    queue,
    projects,

    /** Called immediately when consent is withdrawn. In-flight paid requests may have already started. */
    async cancelAnalysisJobs(): Promise<Result<void>> {
      for (const r of analysisRuns.values()) stopAnalysis(r);
      for (const r of autoCullRuns.values()) stopAutoCull(r);
      return ok(undefined);
    },

    async status(): Promise<Result<{ exiftoolVersion: string | null; resources: typeof budget }>> {
      let version: string | null = null;
      try {
        version = await exiftoolVersion();
      } catch {
        version = null;
      }
      return ok({ exiftoolVersion: version, resources: budget });
    },

    async setAiCredentials(endpoint: string | null, token: string | null): Promise<Result<void>> {
      if (!endpoint || !token) {
        aiCreds = null;
        return ok(undefined);
      }
      let u: URL;
      try {
        u = new URL(endpoint);
      } catch {
        return err('INVALID_ENDPOINT', 'Địa chỉ dịch vụ phân tích không hợp lệ.');
      }
      const local = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
      if (u.username || u.password) return err('INVALID_ENDPOINT', 'Địa chỉ dịch vụ không được chứa tài khoản/mật khẩu.');
      if (u.protocol !== 'https:' && !local) return err('INVALID_ENDPOINT', 'Địa chỉ dịch vụ phân tích phải dùng HTTPS.');
      if (!/^[A-Za-z0-9._~+/=-]{20,200}$/.test(token)) return err('INVALID_TOKEN', 'Token không đúng định dạng.');
      aiCreds = { endpoint: u.toString(), token };
      return ok(undefined);
    },

    async aiQuota(): Promise<Result<AiQuotaView>> {
      if (!aiCreds) return err('AI_NOT_CONFIGURED', 'Chưa cấu hình dịch vụ phân tích.');
      return new AiClient(aiCreds.endpoint, aiCreds.token).quota();
    },

    /** retryFailed: send again photos whose analysis failed (each retry is a new paid call). */
    async analyzeFaces(projectId: string, assetIds: string[], retryFailed = false): Promise<Result<string>> {
      if (!aiCreds) return err('AI_NOT_CONFIGURED', 'Chưa cấu hình dịch vụ phân tích (địa chỉ + token).');
      const p = project(projectId);
      if (!p.ok) return p;
      if (!Array.isArray(assetIds) || assetIds.length === 0 || assetIds.length > 20_000) return err('INVALID_ARGUMENT', 'Danh sách ảnh không hợp lệ.');
      const known = assertAssets(p.value, assetIds);
      if (!known.ok) return known;
      const jobId = newId('j');
      const run: AnalysisRun = { jobId, projectId, cancelled: false, controller: new AbortController(), done: Promise.resolve() };
      analysisRuns.set(jobId, run);
      const client = new AiClient(aiCreds.endpoint, aiCreds.token);
      run.done = runFaceAnalysis({ store: p.value.store, queue: analysisQueue, client, emit: deps.emit }, run, [...assetIds], { retryFailed: retryFailed === true })
        .catch((e: unknown) => deps.emit({ kind: 'analysis', projectId, jobId, phase: 'stopped', done: 0, total: assetIds.length, message: `Lỗi phân tích: ${(e as Error)?.message ?? e}` }))
        .finally(() => analysisRuns.delete(jobId));
      return ok(jobId);
    },

    /** aiBlocked: reason the caller does not allow sending images (e.g. no consent); the run then skips analysis. */
    async startAutoCull(projectId: string, aiBlocked: string | null = null, engine: 'cloud' | 'local' = 'cloud'): Promise<Result<string>> {
      if (engine !== 'cloud' && engine !== 'local') return err('INVALID_ARGUMENT', 'Engine không hợp lệ.');
      if (engine === 'local' && !deps.localDetect) return err('LOCAL_UNAVAILABLE', 'Runtime local chưa sẵn sàng.');
      const p = project(projectId);
      if (!p.ok) return p;
      const running = [...autoCullRuns.values()].find((r) => r.projectId === projectId);
      if (running) return err('AUTOCULL_RUNNING', 'AutoCull đang chạy cho dự án này.');
      const store = p.value.store;
      const runId = newId('j');
      store.createCullRun({ id: runId, provider: engine === 'local' ? LOCAL_PROVIDER : AUTOCULL_PROVIDER, configVersion: QUALITY_CONFIG.version, groupingVersion: groupingPreset(store.meta('grouping_preset')).version });
      const run: AutoCullRun = { runId, projectId, cancelled: false, analysis: { jobId: runId, projectId, cancelled: false, controller: new AbortController(), done: Promise.resolve() }, done: Promise.resolve() };
      autoCullRuns.set(runId, run);
      const client = engine === 'cloud' && aiCreds && !aiBlocked ? new AiClient(aiCreds.endpoint, aiCreds.token) : null;
      run.done = runAutoCull({ project: p.value, queue, analysisQueue, client, localDetect: engine === 'local' ? deps.localDetect : undefined, aiBlocked, emit: deps.emit, cropCache: p.value.cropCache }, run).finally(() => autoCullRuns.delete(runId));
      return ok(runId);
    },

    async getCullState(projectId: string): Promise<Result<CullState>> {
      const p = project(projectId);
      if (!p.ok) return p;
      const store = p.value.store;
      return ok({ run: store.latestCullRun(), counts: p.value.cullCache.get(store, p.value.groups).counts, groupingPreset: store.meta('grouping_preset') ?? 'group-v1' });
    },

    async shutdown(): Promise<Result<void>> {
      for (const r of autoCullRuns.values()) stopAutoCull(r);
      for (const r of analysisRuns.values()) stopAnalysis(r);
      for (const p of projects.values()) for (const r of p.runs.values()) {
        r.closing = true;
        queue.cancelJob(r.token);
        analysisQueue.cancelJob(r.token);
      }
      // Running exports are cancelled and awaited so their temp files are removed and a manifest is written.
      for (const job of exportJobs.values()) if (!job.report) job.controller.abort();
      await Promise.all([...exportJobs.values()].map((j) => j.done));
      for (const id of [...projects.keys()]) await closeOne(id);
      await closeExifTool();
      return ok(undefined);
    },

    async createProject(projectDir: string, name: string): Promise<Result<ProjectSnapshot>> {
      const r = ProjectStore.create(path.resolve(projectDir), name);
      if (!r.ok) return r;
      return ok(await register(r.value));
    },

    async openProject(projectDir: string): Promise<Result<ProjectSnapshot>> {
      const dir = path.resolve(projectDir);
      for (const p of projects.values()) {
        if (comparablePath(p.store.dir) === comparablePath(dir)) return ok(p.store.snapshot());
      }
      const r = ProjectStore.open(dir);
      if (!r.ok) return r;
      return ok(await register(r.value));
    },

    async closeProject(projectId: string): Promise<Result<void>> {
      await closeOne(projectId);
      return ok(undefined);
    },

    async getProjectState(projectId: string): Promise<Result<ProjectState>> {
      const p = project(projectId);
      if (!p.ok) return p;
      const s = p.value.store;
      const members = s.packMembers();
      const packCounts = {
        quick: { members: members.filter((m) => m.packId === 'quick').length, pinned: members.filter((m) => m.packId === 'quick' && m.pinned).length },
        edit: { members: members.filter((m) => m.packId === 'edit').length, pinned: members.filter((m) => m.packId === 'edit' && m.pinned).length },
      };
      return ok({
        snapshot: s.snapshot(),
        ...s.counts(),
        sources: s.sourceViews(),
        cameras: s.cameraViews(),
        targets: s.targets(),
        packRules: s.packRules(),
        packCounts,
        canUndo: s.canUndo(),
      });
    },

    async addSources(projectId: string, roots: string[]): Promise<Result<string>> {
      const p = project(projectId);
      if (!p.ok) return p;
      const store = p.value.store;
      const projectReal = await realpath(store.dir);
      const chosen: SourceRow[] = [];
      for (const root of roots) {
        if (typeof root !== 'string' || !path.isAbsolute(root)) return err('INVALID_SOURCE', 'Đường dẫn nguồn không hợp lệ.');
        let real: string;
        try {
          real = await realpath(root);
          if (!(await stat(real)).isDirectory()) return err('INVALID_SOURCE', 'Nguồn phải là thư mục.');
        } catch {
          return err('SOURCE_UNAVAILABLE', `Không truy cập được: ${path.basename(root)}`);
        }
        if (pathsOverlap(real, projectReal)) {
          return err('SOURCE_OVERLAPS_PROJECT', 'Thư mục nguồn và thư mục dự án không được lồng nhau. Hãy lưu dự án ở nơi khác.');
        }
        const existing = store.sources().find((s) => comparablePath(s.rootPath) === comparablePath(real));
        if (existing) {
          chosen.push(existing);
          continue;
        }
        const nested = store.sources().find((s) => pathsOverlap(s.rootPath, real));
        if (nested) return err('SOURCE_OVERLAPS_SOURCE', `Nguồn này lồng với nguồn đã có "${nested.label}".`);
        chosen.push(store.addSource(real, path.basename(real) || real));
      }
      const jobId = store.createJob('scan', { sourceIds: chosen.map((s) => s.id) });
      startRun(p.value, jobId, chosen);
      return ok(jobId);
    },

    async planExport(projectId: string, packId: ExportSet, destinationParent: string, mode: 'manifest' | 'copy-originals'): Promise<Result<ExportPlanView>> {
      const p = project(projectId);
      if (!p.ok) return p;
      const index = p.value.cullCache.get(p.value.store, p.value.groups);
      const r = await planExportFn(p.value.store, packId, destinationParent, mode, { selectedIds: selectedOf(index), cullOf: (id) => index.views.get(id) });
      if (!r.ok) return r;
      plans.set(r.value.planId, r.value);
      return ok(r.value.view);
    },

    async executeExport(planId: string): Promise<Result<string>> {
      const plan = plans.get(planId);
      if (!plan) return err('UNKNOWN_ID', 'Bản xem trước đã hết hạn; hãy xem trước lại.');
      const p = projects.get(plan.projectId);
      if (!p) return err('PROJECT_NOT_OPEN', 'Dự án chưa được mở.');
      const index = p.cullCache.get(p.store, p.groups);
      const current = plan.packId === 'selection' ? selectedOf(index) : membersOfPack(p.store, plan.packId);
      if (metadataKeyOf(p.store, plan.files.flatMap((f) => (f.fileId ? [f.fileId] : []))) !== plan.metadataKey) {
        return err('PLAN_STALE_METADATA', 'Tệp nguồn đã thay đổi (kích thước, thời gian sửa hoặc nội dung) sau khi xem trước. Hãy xem trước lại.');
      }
      if (plan.packId === 'selection' && memberKeyOf(current) === plan.memberKey && revisionKeyOf(current, (id) => index.views.get(id)) !== plan.revisionKey) {
        return err('PLAN_STALE_ANALYSIS', 'Kết quả AutoCull đã được tính lại sau khi xem trước. Hãy xem trước lại.');
      }
      if (memberKeyOf(current) !== plan.memberKey) return err('PLAN_STALE', 'Bộ chọn đã thay đổi sau khi xem trước. Hãy xem trước lại.');
      plans.delete(planId);
      const jobId = newId('j');
      const controller = new AbortController();
      const job: ExportJob = { projectId: plan.projectId, controller, report: null, folder: null, done: Promise.resolve() };
      exportJobs.set(jobId, job);
      const emit = (phase: Extract<ProgressEvent, { kind: 'export' }>['phase'], done: number, total: number, fileId?: string | null, message?: string) =>
        deps.emit({ kind: 'export', projectId: plan.projectId, jobId, phase, fileId: fileId ?? undefined, done, total, message });
      job.done = (async () => {
        try {
          const gen = executeExportFn(plan, controller.signal);
          let step = await gen.next();
          while (!step.done) {
            const e = step.value;
            emit(e.phase === 'verified' ? 'verified' : e.phase === 'failed' ? 'failed' : e.phase === 'copied' ? 'copied' : 'copying', e.done, e.total, e.fileId, e.message);
            step = await gen.next();
          }
          job.report = step.value;
          job.folder = path.join(plan.destinationParent, step.value.outputFolderName);
          emit(step.value.status === 'cancelled' ? 'cancelled' : 'complete', step.value.copiedVerified.length, plan.files.length, null, step.value.status);
        } catch (e) {
          job.report = { planId, status: 'failed', copiedVerified: [], skipped: [], failed: [{ fileId: null, outputName: '', status: 'failed', code: 'EXPORT_FAILED', message: (e as Error).message }], cancelled: [], outputFolderName: '' };
          emit('complete', 0, 0, null, (e as Error).message);
        }
      })();
      return ok(jobId);
    },

    async getExportReport(jobId: string): Promise<Result<ExportReport | null>> {
      const job = exportJobs.get(jobId);
      if (!job) return err('UNKNOWN_ID', 'Không có tác vụ xuất này.');
      return ok(job.report);
    },

    async exportFolderPath(jobId: string): Promise<Result<string>> {
      const job = exportJobs.get(jobId);
      if (!job?.folder) return err('UNKNOWN_ID', 'Chưa có thư mục xuất.');
      return ok(job.folder);
    },

    async exportPortable(projectId: string, destination: string): Promise<Result<void>> {
      const p = project(projectId);
      if (!p.ok) return p;
      return exportPortableFn(p.value.store, p.value.groups, destination);
    },

    async importPortable(filePath: string, projectDir: string): Promise<Result<ProjectSnapshot>> {
      try {
        if ((await readdir(projectDir)).length > 0) return err('PROJECT_DIR_NOT_EMPTY', 'Hãy chọn một thư mục trống cho dự án mới.');
      } catch {
        return err('INVALID_DESTINATION', 'Không truy cập được thư mục dự án.');
      }
      const r = await importPortableFn(filePath, projectDir);
      if (!r.ok) return r;
      const snap = await register(r.value.store);
      return ok(snap);
    },

    async relinkSource(projectId: string, sourceId: string, newRoot: string): Promise<Result<{ matched: number; missing: number; ambiguous: number }>> {
      const p = project(projectId);
      if (!p.ok) return p;
      const store = p.value.store;
      const source = store.source(sourceId);
      if (!source) return err('UNKNOWN_ID', 'Không có nguồn này.');
      let real: string;
      try {
        real = await realpath(newRoot);
        if (!(await stat(real)).isDirectory()) return err('INVALID_SOURCE', 'Nguồn phải là thư mục.');
      } catch {
        return err('SOURCE_UNAVAILABLE', 'Không truy cập được thư mục đã chọn.');
      }
      if (pathsOverlap(real, await realpath(store.dir))) return err('SOURCE_OVERLAPS_PROJECT', 'Thư mục nguồn và thư mục dự án không được lồng nhau.');
      const other = store.sources().find((s) => s.id !== sourceId && s.rootPath && pathsOverlap(s.rootPath, real));
      if (other) return err('SOURCE_OVERLAPS_SOURCE', `Thư mục này lồng với nguồn "${other.label}".`);
      const records = store.filesOfSource(sourceId).map((f) => ({ id: f.id, sourceId, relativePath: f.relativePath, bytes: f.bytes, sampledHash: f.sampledHash, kind: f.kind }));
      const sizes = new Set(records.map((r) => `${r.kind}|${r.bytes}`));
      const candidates: (FileRecord & { mtimeMs: number })[] = [];
      for await (const f of walkSource(real)) {
        if (f.kind === 'dir-error') continue;
        if (!sizes.has(`${f.kind}|${f.bytes}`)) continue;
        try {
          const fp = await fingerprint(f.absolutePath);
          candidates.push({ id: `cand:${f.relativePath}`, sourceId, relativePath: f.relativePath, bytes: fp.bytes, sampledHash: fp.sampledHash, kind: f.kind, mtimeMs: f.mtimeMs });
        } catch {
          /* unreadable candidate: ignored */
        }
      }
      const result = relinkAssets(records, candidates);
      store.tx(() => {
        store.setSourceRoot(sourceId, real, path.basename(real) || real);
        store.relinkFiles(
          sourceId,
          result.matched.map((m) => ({
            id: m.record.id,
            relativePath: m.candidate.relativePath,
            bytes: m.candidate.bytes,
            mtimeMs: (m.candidate as FileRecord & { mtimeMs: number }).mtimeMs,
            sampledHash: m.candidate.sampledHash,
          })),
        );
      });
      const jobId = store.createJob('scan', { sourceIds: [sourceId] });
      startRun(p.value, jobId, [store.source(sourceId)!]);
      return ok({ matched: result.matched.length, missing: result.missing.length, ambiguous: result.ambiguous.length });
    },

    async cancelJob(jobId: string): Promise<Result<void>> {
      const cull = autoCullRuns.get(jobId);
      if (cull) {
        stopAutoCull(cull);
        return ok(undefined);
      }
      const analysis = analysisRuns.get(jobId);
      if (analysis) {
        stopAnalysis(analysis);
        return ok(undefined);
      }
      const exportJob = exportJobs.get(jobId);
      if (exportJob) {
        exportJob.controller.abort();
        return ok(undefined);
      }
      const projectId = jobProject.get(jobId);
      const p = projectId ? projects.get(projectId) : undefined;
      const run = p?.runs.get(jobId);
      if (!run) return ok(undefined);
      run.userCancelled = true;
      queue.cancelJob(run.token);
      analysisQueue.cancelJob(run.token);
      return ok(undefined);
    },

    getJob(projectId: string, jobId: string): Result<{ state: string; completedFileIds: string[]; total: number }> {
      const p = project(projectId);
      if (!p.ok) return p;
      const job = p.value.store.job(jobId);
      if (!job) return err('UNKNOWN_ID', 'Không có tác vụ này.');
      const files = p.value.store.jobFiles(jobId);
      return ok({ state: job.state, completedFileIds: files.filter((f) => f.done).map((f) => f.fileId), total: files.length });
    },

    async suggestPack(projectId: string, packId: PackId): Promise<Result<PackSuggestion>> {
      const p = project(projectId);
      if (!p.ok) return p;
      const store = p.value.store;
      const rule = store.packRules().find((r) => r.id === packId);
      if (!rule) return err('UNKNOWN_ID', 'Không có bộ chọn này.');
      const signals: PackInput['signals'] = {};
      for (const [id, f] of store.features()) {
        const v = JSON.parse(f.json) as { laplacianVariance: number; clippedFraction: number };
        signals[id] = { laplacianVariance: v.laplacianVariance, clippedFraction: v.clippedFraction };
      }
      return ok(
        suggestPack({
          rule,
          members: store.packMembers(),
          decisions: Object.fromEntries(store.allDecisions()),
          groups: p.value.groups,
          targets: store.targets(),
          signals,
        }),
      );
    },

    async listDeliveries(projectId: string): Promise<Result<DeliveryEvent[]>> {
      const p = project(projectId);
      if (!p.ok) return p;
      return ok(p.value.store.deliveries());
    },

    async listPairCandidates(projectId: string): Promise<Result<PairCandidate[]>> {
      const p = project(projectId);
      if (!p.ok) return p;
      return ok(pairCandidatesOf(p.value.store));
    },

    async evictPreviewCache(projectId: string, maxBytes: number = PREVIEW_CACHE_BYTES): Promise<Result<{ evicted: number; bytes: number }>> {
      const p = project(projectId);
      if (!p.ok) return p;
      return ok(await evictPreviewCache(p.value.store, maxBytes));
    },

    async restorePreview(projectId: string, cacheFile: string): Promise<Result<boolean>> {
      const p = project(projectId);
      if (!p.ok) return p;
      return restorePreview(p.value.store, cacheFile);
    },

    async listGroups(projectId: string): Promise<Result<Group[]>> {
      const p = project(projectId);
      if (!p.ok) return p;
      return ok(p.value.groups);
    },

    async queryAssets(projectId: string, query: AssetQuery): Promise<Result<AssetPage>> {
      const q = validate(AssetQuerySchema, query);
      if (!q.ok) return q;
      const p = project(projectId);
      if (!p.ok) return p;
      let members: string[] | undefined;
      if (q.value.groupId) {
        const g = p.value.groups.find((x) => x.id === q.value.groupId);
        if (!g) return err('UNKNOWN_ID', 'Không có cụm này.');
        members = g.assetIds;
      }
      const index = p.value.cullCache.get(p.value.store, p.value.groups);
      const listMembers = q.value.list ? [...index.views].filter(([, v]) => v.list === q.value.list).map(([id]) => id) : undefined;
      const page = p.value.store.queryAssets(
        q.value,
        (id) => p.value.groupIndex.get(id) ?? null,
        members,
        (id) => index.views.get(id) ?? NO_CULL(),
        listMembers,
      );
      // Only preview access times were written since the index was validated.
      p.value.cullCache.rekey(p.value.store);
      return ok({ total: page.total, offset: q.value.offset, items: page.items });
    },

    async applyCommand(projectId: string, command: ProjectCommand): Promise<Result<ProjectSnapshot>> {
      const c = parseProjectCommand(command);
      if (!c.ok) return c;
      const p = project(projectId);
      if (!p.ok) return p;
      const store = p.value.store;
      const cmd = c.value;
      try {
        if (REVIEW_COMMANDS.has(cmd.type)) {
          const ids = 'assetIds' in cmd ? cmd.assetIds : [];
          const known = assertAssets(p.value, ids);
          if (!known.ok) return known;
          const targetIds = new Set(store.targets().map((t) => t.id));
          if (cmd.type === 'assign-target' && !targetIds.has(cmd.targetId)) return err('UNKNOWN_ID', 'Không có mục tiêu này.');
          if (cmd.type === 'remove-target' && !targetIds.has(cmd.targetId)) return err('UNKNOWN_ID', 'Không có mục tiêu này.');
          if (cmd.type === 'set-pack-rule' && cmd.targetIds.some((t) => !targetIds.has(t))) return err('UNKNOWN_ID', 'Không có mục tiêu này.');
          const model = loadReviewModel(store);
          const next = applyReviewCommand(model, cmd);
          const entry = next.journal[next.journal.length - 1]!;
          store.tx(() => {
            persistReviewModel(store, model, next);
            store.pushUndo(entry.command, entry.before);
          });
          return ok(store.snapshot());
        }
        switch (cmd.type) {
          case 'undo': {
            const model = loadReviewModel(store);
            store.tx(() => {
              const last = store.popUndo();
              if (!last) return;
              persistReviewModel(store, model, { ...restoreSnapshot(model, last.before as UndoSnapshot), journal: [] });
            });
            break;
          }
          case 'confirm-delivery':
          case 'correct-delivery': {
            const known = assertAssets(p.value, cmd.assetIds);
            if (!known.ok) return known;
            let packId: PackId;
            let corrects: string | null = null;
            if (cmd.type === 'correct-delivery') {
              const original = store.deliveries().find((e) => e.id === cmd.eventId);
              if (!original) return err('UNKNOWN_ID', 'Không có lần bàn giao này.');
              packId = original.packId;
              corrects = original.id;
            } else packId = cmd.packId;
            const fingerprints: Record<string, string> = {};
            for (const id of cmd.assetIds) {
              const a = store.asset(id)!;
              for (const fid of [a.primaryFileId, a.companionJpegId]) {
                const f = fid ? store.file(fid) : undefined;
                if (f) fingerprints[f.id] = f.sampledHash;
              }
            }
            const event = buildDeliveryEvent({ packId, assetIds: cmd.assetIds, fingerprints, correctsEventId: corrects });
            store.tx(() => store.insertDelivery(event));
            break;
          }
          case 'confirm-pairs': {
            const r = await confirmPairs(p.value, queue, cmd.pairs);
            if (!r.ok) return r;
            break;
          }
          case 'set-camera-offset': {
            if (!store.cameraViews().some((cam) => cam.cameraId === cmd.cameraId)) return err('UNKNOWN_ID', 'Không có máy ảnh này trong dự án.');
            store.tx(() => store.setCameraOffset(cmd.cameraId, cmd.offsetSeconds));
            regroup(p.value);
            break;
          }
          case 'regroup':
            if (cmd.preset) store.setMeta('grouping_preset', cmd.preset);
            regroup(p.value);
            break;
          case 'split-group': {
            const g = p.value.groups.find((x) => x.id === cmd.groupId);
            if (!g) return err('UNKNOWN_ID', 'Không có cụm này.');
            const moving = new Set(cmd.assetIds);
            if (!cmd.assetIds.every((id) => g.assetIds.includes(id))) return err('UNKNOWN_ID', 'Ảnh không thuộc cụm này.');
            const rest = g.assetIds.filter((id) => !moving.has(id));
            if (rest.length === 0) return err('INVALID_COMMAND', 'Phải để lại ít nhất một ảnh trong cụm cũ.');
            const next = p.value.groups.flatMap((x) =>
              x.id !== g.id
                ? [x]
                : [
                    { ...g, assetIds: rest, manual: true },
                    { id: newId('g'), assetIds: g.assetIds.filter((id) => moving.has(id)), confidence: g.confidence, manual: true },
                  ],
            );
            store.tx(() => store.replaceGroups(next, 'manual-edit'));
            setGroups(p.value, next);
            break;
          }
          case 'merge-groups': {
            const picked = cmd.groupIds.map((gid) => p.value.groups.find((x) => x.id === gid));
            if (picked.some((x) => !x)) return err('UNKNOWN_ID', 'Không có cụm này.');
            const ids = new Set(cmd.groupIds);
            const merged = {
              id: newId('g'),
              assetIds: picked.flatMap((x) => x!.assetIds),
              confidence: picked.every((x) => x!.confidence === 'high') ? ('high' as const) : ('low' as const),
              manual: true,
            };
            const firstIndex = p.value.groups.findIndex((x) => ids.has(x.id));
            const next = p.value.groups.filter((x) => !ids.has(x.id));
            next.splice(Math.min(firstIndex, next.length), 0, merged);
            store.tx(() => store.replaceGroups(next, 'manual-edit'));
            setGroups(p.value, next);
            break;
          }
          case 'set-camera-identity': {
            const known = assertAssets(p.value, cmd.assetIds);
            if (!known.ok) return known;
            store.tx(() => {
              for (const id of cmd.assetIds) {
                const a = store.asset(id)!;
                const m = store.assetMetadata(a);
                const camId = cameraIdFor(m?.cameraMake ?? null, m?.cameraModel ?? null, `user:${cmd.label.toLowerCase()}`);
                store.setCameraOverride([id], camId, cmd.label);
              }
            });
            regroup(p.value);
            break;
          }
          default:
            return err('NOT_IMPLEMENTED', `Chưa hỗ trợ lệnh: ${cmd.type}`);
        }
      } catch (e) {
        return err('SAVE_FAILED', `Chưa lưu được thay đổi: ${(e as Error).message}`);
      }
      return ok(store.snapshot());
    },
  };
  return service;
}

export type Service = ReturnType<typeof createService>;

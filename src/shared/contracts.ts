// Shared data contracts. Every layer imports these; do not declare parallel types.
export type ProjectId = string;
export type AssetId = string;
export type FileId = string;
export type JobId = string;
export type SourceId = string;
export type PackId = 'quick' | 'edit';
export type ReviewState = 'unreviewed' | 'keep' | 'pass' | 'review';
export type MediaStatus =
  | 'queued'
  | 'ready'
  | 'preview-small'
  | 'no-preview'
  | 'unsupported'
  | 'error'
  | 'missing'
  | 'stale';
export type ConsentState = 'unknown' | 'allowed' | 'blocked';
export type Result<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

export const PACK_IDS: readonly PackId[] = ['quick', 'edit'];
export const MEDIA_STATUSES: readonly MediaStatus[] = [
  'queued',
  'ready',
  'preview-small',
  'no-preview',
  'unsupported',
  'error',
  'missing',
  'stale',
];

export interface FileRecord {
  id: FileId;
  sourceId: SourceId;
  relativePath: string;
  bytes: number;
  sampledHash: string;
  kind: 'raw' | 'jpeg' | 'xmp';
}
export interface AssetRecord {
  id: AssetId;
  primaryFileId: FileId;
  companionJpegId: FileId | null;
  pairConfirmed: boolean;
  status: MediaStatus;
}
export interface PhotoMetadata {
  cameraId: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  cameraSerial: string | null;
  capturedLocal: string | null;
  explicitOffsetMinutes: number | null;
  timeSource: 'exif-explicit' | 'exif-no-zone' | 'missing';
  orientation: number | null;
}
export interface Decision {
  assetId: AssetId;
  state: ReviewState;
  rating: 0 | 1 | 2 | 3 | 4 | 5;
  consent: ConsentState;
  targetIds: string[];
}
export interface PackRule {
  id: PackId;
  limit: number | null;
  targetIds: string[];
}
export interface PackMember {
  packId: PackId;
  assetId: AssetId;
  pinned: boolean;
}
export interface CoverageTarget {
  id: string;
  label: string;
  required: boolean;
  requiresConsent: boolean;
  minCount: number;
}
export interface DeliveryEvent {
  id: string;
  at: string;
  packId: PackId;
  assetIds: AssetId[];
  fileFingerprints: Record<FileId, string>;
  correctsEventId: string | null;
}
export interface FeatureVector {
  hash: string;
  histogram: number[];
  laplacianVariance: number;
  clippedFraction: number;
  width: number;
  height: number;
  algorithmVersion: string;
}
export interface Group {
  id: string;
  assetIds: AssetId[];
  confidence: 'high' | 'low';
  manual: boolean;
}
export interface ProjectSnapshot {
  id: ProjectId;
  name: string;
  counts: Record<MediaStatus, number>;
  dirty: boolean;
}

export interface PreviewRecord {
  cacheId: string;
  thumbCacheId: string;
  width: number;
  height: number;
  bytes: number;
  origin: 'embedded' | 'jpeg-original' | 'libraw';
  sourceTag: string;
  orientationApplied: number | null;
  insufficientForFocus: boolean;
}

// ---------- v0.2: face analysis and AutoCull ----------

/** Where the analysed JPEG came from. */
export type AnalysisSourceKind = 'companion-jpeg' | 'jpeg-original' | 'embedded' | 'embedded-small' | 'libraw';

/** One face as observed by the provider, with the app's own reading of how certain each signal is. */
export interface FaceAssessment {
  /** Ratios of the analysed image (0..1). */
  bbox: { left: number; top: number; width: number; height: number };
  /** Short side of the face box in pixels of the image that was sent. */
  shortSidePx: number;
  /** null when the engine does not expose a face detection confidence. */
  confidence: number | null;
  pose: { yaw: number; pitch: number; roll: number } | null;
  eyes: 'open' | 'closed' | 'unknown';
  eyesConfidence: number | null;
  smile: boolean | null;
  mouthOpen: boolean | null;
  /** Provider's predicted facial expressions (observable appearance, not inner emotion). */
  expressions: { type: string; confidence: number }[];
  sharpness: number | null;
  brightness: number | null;
  occluded: boolean | null;
  sunglasses: boolean | null;
  /** Local blendshape coefficients, not probabilities or emotional judgments. */
  observedBlendshapes?: Record<string, number>;
  /** Why the eye state could not be concluded. */
  unknownReasons: ('low-face-confidence' | 'small-face' | 'low-eye-confidence' | 'pose' | 'occluded' | 'sunglasses' | 'no-eye-data')[];
}

export type CriterionState = 'known' | 'unknown' | 'not-applicable';
export interface Criterion {
  /** 0..100, null when unknown or not applicable. */
  score: number | null;
  state: CriterionState;
  note: string | null;
}
export interface QualityAssessment {
  sharpness: Criterion;
  eyes: Criterion;
  lighting: Criterion;
  composition: Criterion;
  expression: Criterion;
  /** Weighted score over the known criteria (renormalised), null if none known. */
  total: number | null;
  configVersion: string;
}

export type CullLabel = 'keep' | 'better-option' | 'review';
export interface CullRecommendation {
  assetId: AssetId;
  groupId: string;
  rank: number;
  label: CullLabel;
  bestAssetId: AssetId | null;
  reasons: string[];
  runId: string;
  revision: string;
}

export interface CullRun {
  id: string;
  status: 'running' | 'paused' | 'cancelled' | 'failed' | 'complete';
  provider: string;
  configVersion: string;
  total: number;
  done: number;
  createdAt: string;
  error: string | null;
}

export interface EffectiveSelection {
  assetId: AssetId;
  selected: boolean;
  source: 'manual-keep' | 'manual-excluded' | 'auto' | 'not-recommended' | 'no-analysis';
}

/** AutoCull view of one photo: the recommendation (if any) combined with manual decisions. */
export interface AssetCullView {
  selected: boolean;
  source: EffectiveSelection['source'];
  list: CullLabel;
  /** Recommendation of the latest run; null when the photo has not been ranked yet. */
  label: CullLabel | null;
  rank: number | null;
  bestAssetId: AssetId | null;
  reasons: string[];
  quality: QualityAssessment | null;
  runId: string | null;
  revision: string | null;
}

export interface CullState {
  /** Latest run (any status); null before the first run. */
  run: CullRun | null;
  counts: Record<CullLabel, number>;
  groupingPreset: string;
}

export interface AssetAnalysisView {
  provider?: string;
  status: 'none' | 'pending' | 'done' | 'failed' | 'stale';
  sourceKind: AnalysisSourceKind | null;
  imageWidth: number | null;
  imageHeight: number | null;
  faces: FaceAssessment[] | null;
  error: string | null;
}

export interface AiSettingsView {
  endpoint: string | null;
  hasToken: boolean;
  /** true: token encrypted with the OS keychain; false: kept in memory for this session only. */
  tokenPersisted: boolean;
  consentAt: string | null;
}

export interface AiQuotaView {
  month: string;
  resetAt: string;
  user: { used: number; limit: number };
  global: { used: number; limit: number };
}

export interface AssetQuery {
  offset: number;
  limit: number;
  packId?: PackId;
  groupId?: string;
  state?: ReviewState;
  /** Case-insensitive substring of the relative path. */
  text?: string;
  cameraId?: string;
  /** One of the three AutoCull result lists. */
  list?: CullLabel;
}

export interface FileView {
  id: FileId;
  sourceId: SourceId;
  relativePath: string;
  kind: FileRecord['kind'];
  bytes: number;
}

export interface AssetView {
  id: AssetId;
  status: MediaStatus;
  primary: FileView;
  companion: FileView | null;
  pairConfirmed: boolean;
  cameraId: string | null;
  cameraLabel: string | null;
  capturedLocal: string | null;
  effectiveLocal: string | null;
  timeSource: PhotoMetadata['timeSource'];
  timeNote: string | null;
  preview: (Omit<PreviewRecord, 'cacheId' | 'thumbCacheId'> & { url: string; thumbUrl: string }) | null;
  decision: Decision;
  groupId: string | null;
  packs: Record<PackId, { member: boolean; pinned: boolean }>;
  signals: { laplacianVariance: number; clippedFraction: number } | null;
  analysis: AssetAnalysisView | null;
  /** Effective AutoCull result (manual decisions already applied). */
  cull: AssetCullView;
  error: string | null;
}

export interface AssetPage {
  total: number;
  offset: number;
  items: AssetView[];
}

export interface SourceView {
  id: SourceId;
  label: string;
  online: boolean;
  fileCount: number;
}

export interface CameraView {
  cameraId: string;
  label: string;
  make: string | null;
  model: string | null;
  serial: string | null;
  offsetSeconds: number;
  assetCount: number;
  sampleAssetId: AssetId | null;
  sampleCapturedLocal: string | null;
  needsIdentity: boolean;
}

export interface ProjectState {
  snapshot: ProjectSnapshot;
  logicalAssets: number;
  physicalFiles: number;
  sources: SourceView[];
  cameras: CameraView[];
  targets: CoverageTarget[];
  packRules: PackRule[];
  packCounts: Record<PackId, { members: number; pinned: number }>;
  canUndo: boolean;
}

export interface PairCandidate {
  rawId: FileId;
  jpegId: FileId;
  rawAssetId: AssetId;
  jpegAssetId: AssetId;
  relativeStem: string;
  confirmed: boolean;
  ambiguous: boolean;
  reason: string | null;
}

export interface CoverageEntry {
  targetId: string;
  status: 'enough' | 'missing' | 'unknown';
  evidenceIds: AssetId[];
}

export interface PackSuggestion {
  packId: PackId;
  suggestedIds: AssetId[];
  reasons: Record<AssetId, string[]>;
  coverage: CoverageEntry[];
  conflicts: string[];
}

/** What an export takes: a legacy pack, or the effective AutoCull selection. */
export type ExportSet = PackId | 'selection';

export interface ExportPlanView {
  planId: string;
  packId: ExportSet;
  mode: 'manifest' | 'copy-originals';
  destinationLabel: string;
  logicalCount: number;
  physicalCount: number;
  projectedBytes: number;
  outputs: { assetId: AssetId; fileId: FileId; outputName: string; kind: FileRecord['kind'] | 'generated-xmp' }[];
  conflicts: string[];
  omissions: string[];
}

export interface ExportFileResult {
  fileId: FileId | null;
  outputName: string;
  status: 'verified' | 'skipped' | 'failed' | 'cancelled';
  code?: string;
  message?: string;
}

export interface ExportReport {
  planId: string;
  status: 'verified' | 'partial' | 'failed' | 'cancelled';
  copiedVerified: ExportFileResult[];
  skipped: ExportFileResult[];
  failed: ExportFileResult[];
  cancelled: ExportFileResult[];
  outputFolderName: string;
}

export interface AppStatus {
  worker: 'ready' | 'starting' | 'restarting';
  appVersion: string;
  electronVersion: string;
  exiftoolVersion: string | null;
  resources: { metadataJobs: number; imageJobs: number };
}

export type ProgressEvent =
  | {
      kind: 'scan';
      projectId: ProjectId;
      jobId: JobId;
      phase: 'discovered' | 'metadata' | 'preview' | 'file-error' | 'complete' | 'cancelled';
      fileId?: FileId;
      done: number;
      total: number;
      message?: string;
    }
  | {
      kind: 'export';
      projectId: ProjectId;
      jobId: JobId;
      phase: 'copying' | 'copied' | 'verified' | 'failed' | 'complete' | 'cancelled';
      fileId?: FileId;
      done: number;
      total: number;
      message?: string;
    }
  | {
      kind: 'analysis';
      projectId: ProjectId;
      jobId: JobId;
      phase: 'progress' | 'complete' | 'stopped' | 'cancelled';
      assetId?: AssetId;
      done: number;
      total: number;
      message?: string;
    }
  | {
      kind: 'autocull';
      projectId: ProjectId;
      runId: string;
      phase: 'grouping' | 'hashing' | 'analysis' | 'ranking' | 'complete' | 'paused' | 'cancelled' | 'failed';
      done: number;
      total: number;
      message?: string;
    }
  | { kind: 'worker-restarted' }
  | { kind: 'project-changed'; projectId: ProjectId };

export type { ProjectCommand } from './schemas';

export interface EventStoryApi {
  getAppStatus(): Promise<Result<AppStatus>>;
  createProject(name: string): Promise<Result<ProjectSnapshot | null>>;
  openProject(): Promise<Result<ProjectSnapshot | null>>;
  restoreLastProject(): Promise<Result<ProjectSnapshot | null>>;
  closeProject(projectId: ProjectId): Promise<Result<void>>;
  getProjectState(projectId: ProjectId): Promise<Result<ProjectState>>;
  chooseSources(projectId: ProjectId): Promise<Result<JobId | null>>;
  relinkSource(projectId: ProjectId, sourceId: SourceId): Promise<Result<{ matched: number; missing: number; ambiguous: number } | null>>;
  cancelJob(jobId: JobId): Promise<Result<void>>;
  queryAssets(projectId: ProjectId, query: AssetQuery): Promise<Result<AssetPage>>;
  listGroups(projectId: ProjectId): Promise<Result<Group[]>>;
  listPairCandidates(projectId: ProjectId): Promise<Result<PairCandidate[]>>;
  applyCommand(projectId: ProjectId, command: import('./schemas').ProjectCommand): Promise<Result<ProjectSnapshot>>;
  suggestPack(projectId: ProjectId, packId: PackId): Promise<Result<PackSuggestion>>;
  listDeliveries(projectId: ProjectId): Promise<Result<DeliveryEvent[]>>;
  previewExport(projectId: ProjectId, packId: ExportSet, mode: ExportPlanView['mode']): Promise<Result<ExportPlanView | null>>;
  getLocalAnalysisSettings(): Promise<Result<import('./local-analysis').LocalAnalysisSettings>>;
  selectLocalModel(): Promise<Result<import('./local-analysis').LocalAnalysisSettings>>;
  startAutoCull(projectId: ProjectId, engine?: 'cloud' | 'local'): Promise<Result<JobId>>;
  getCullState(projectId: ProjectId): Promise<Result<CullState>>;
  confirmExport(planId: string): Promise<Result<JobId>>;
  getExportReport(jobId: JobId): Promise<Result<ExportReport | null>>;
  openExportFolder(jobId: JobId): Promise<Result<void>>;
  exportPortable(projectId: ProjectId): Promise<Result<string | null>>;
  importPortable(): Promise<Result<ProjectSnapshot | null>>;
  getAiSettings(): Promise<Result<AiSettingsView>>;
  /** token: null keeps the stored token, '' removes it. */
  saveAiSettings(endpoint: string, token: string | null): Promise<Result<AiSettingsView>>;
  setAiConsent(accepted: boolean): Promise<Result<AiSettingsView>>;
  getAiQuota(): Promise<Result<AiQuotaView>>;
  /** retryFailed: send again photos whose analysis failed (a new paid call each). */
  analyzeFaces(projectId: ProjectId, assetIds: AssetId[], retryFailed?: boolean): Promise<Result<JobId>>;
  onProgress(listener: (event: ProgressEvent) => void): () => void;
}

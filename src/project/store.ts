import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import schemaSql from './schema.sql?raw';
import migration002 from './migrations/002.sql?raw';
import { cameraIdFor } from '../media/exiftool';
import { defaultDecision } from '../culling/decisions';
import { assessFace, type ProviderFaceInput } from '../culling/faces';
import { compatibleInputKey } from '../media/analysis-image';
import type {
  AnalysisSourceKind,
  AssetCullView,
  CullLabel,
  CullRun,
  QualityAssessment,
  AssetAnalysisView,
  AssetId,
  AssetQuery,
  AssetView,
  CameraView,
  CoverageTarget,
  Decision,
  DeliveryEvent,
  FaceAssessment,
  FileId,
  FileRecord,
  Group,
  MediaStatus,
  PackId,
  PackMember,
  PackRule,
  PhotoMetadata,
  PreviewRecord,
  ProjectSnapshot,
  Result,
  SourceView,
} from '../shared/contracts';
import { MEDIA_STATUSES } from '../shared/contracts';
import { err, newId, ok } from '../shared/schemas';
import { effectiveLocal, formatOffset } from '../shared/time';

export const SCHEMA_VERSION = 2;
/** SQL that upgrades schema N-1 to N. Additive only. */
const MIGRATIONS: Record<number, string> = { 2: migration002 };
export const GROUPING_PRESET_NEW_PROJECTS = 'event-v2';
const DB_FILE = 'project.sqlite';
const LOCK_FILE = 'project.lock';

type Row = Record<string, SQLInputValue>;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Exclusive project lock. A lock held by a live process (including this one) blocks a second writer. */
function acquireLock(dir: string): Result<string> {
  const lockPath = path.join(dir, LOCK_FILE);
  const token = newId('u');
  const body = JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString(), token });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, body, { flag: 'wx' });
      return ok(token);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return err('LOCK_FAILED', (e as Error).message);
      let held: { pid?: number; host?: string } = {};
      try {
        held = JSON.parse(readFileSync(lockPath, 'utf8')) as typeof held;
      } catch {
        held = {};
      }
      const sameHost = held.host === os.hostname();
      if (!sameHost || (typeof held.pid === 'number' && pidAlive(held.pid))) {
        return err(
          'PROJECT_LOCKED',
          sameHost
            ? 'Dự án đang được mở ở một cửa sổ/tiến trình khác.'
            : `Dự án đang bị khóa bởi máy "${held.host ?? '?'}". Nếu chắc chắn không còn ai mở, hãy xóa tệp project.lock.`,
        );
      }
      try {
        unlinkSync(lockPath); // stale lock from a process that no longer exists on this machine
      } catch {
        /* retry */
      }
    }
  }
  return err('PROJECT_LOCKED', 'Không lấy được khóa dự án.');
}

const EFFECTIVE_STATUS = `CASE WHEN s.online = 0 OR f.missing = 1 THEN 'missing' WHEN f.stale = 1 THEN 'stale' ELSE a.media_status END`;

export interface FileRow {
  id: FileId;
  sourceId: string;
  relativePath: string;
  kind: FileRecord['kind'];
  bytes: number;
  mtimeMs: number;
  sampledHash: string;
  stale: boolean;
  missing: boolean;
}

export interface SourceRow {
  id: string;
  label: string;
  rootPath: string;
  online: boolean;
}

export interface FaceAnalysisRow {
  assetId: AssetId;
  inputKey: string;
  sourceKind: AnalysisSourceKind;
  sourceFileId: FileId;
  prepVersion: string;
  provider: string;
  idempotencyKey: string;
  requestId: string | null;
  status: 'pending' | 'done' | 'failed';
  imageWidth: number | null;
  imageHeight: number | null;
  uploadBytes: number | null;
  resultJson: string | null;
  error: string | null;
  updatedAt: string;
}

export const NO_CULL = (): AssetCullView => ({
  selected: false,
  source: 'no-analysis',
  list: 'review',
  label: null,
  rank: null,
  bestAssetId: null,
  reasons: [],
  quality: null,
  runId: null,
  revision: null,
});

export interface CullRecommendationRow {
  runId: string;
  assetId: AssetId;
  groupId: string;
  rank: number;
  label: CullLabel;
  bestAssetId: AssetId | null;
  reasons: string[];
  quality: QualityAssessment;
  revision: string;
}

export interface AssetCore {
  id: AssetId;
  primaryFileId: FileId;
  companionJpegId: FileId | null;
  pairConfirmed: boolean;
  cameraId: string | null;
  sortTime: string | null;
  seq: number;
}

export class ProjectStore {
  dirty = false;
  private closed = false;

  private constructor(
    readonly dir: string,
    readonly db: DatabaseSync,
    readonly id: string,
    public name: string,
    private readonly lockToken: string,
  ) {}

  get cacheRoot(): string {
    return path.join(this.dir, 'cache', 'previews');
  }

  static create(dir: string, name: string): Result<ProjectStore> {
    mkdirSync(dir, { recursive: true });
    if (existsSync(path.join(dir, DB_FILE))) return err('PROJECT_EXISTS', 'Thư mục này đã có dự án.');
    const lock = acquireLock(dir);
    if (!lock.ok) return lock;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path.join(dir, DB_FILE));
      ProjectStore.pragmas(db);
      const id = newId('p');
      db.exec('BEGIN');
      db.exec(schemaSql);
      for (let v = 2; v <= SCHEMA_VERSION; v++) db.exec(MIGRATIONS[v]!);
      db.prepare("UPDATE meta SET value = ? WHERE key = 'grouping_preset'").run(GROUPING_PRESET_NEW_PROJECTS);
      const put = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
      put.run('schema_version', String(SCHEMA_VERSION));
      put.run('project_id', id);
      put.run('name', name);
      put.run('created_at', new Date().toISOString());
      const rule = db.prepare('INSERT INTO pack_rule (pack_id, limit_count, target_ids) VALUES (?, ?, ?)');
      rule.run('quick', 12, '[]');
      rule.run('edit', 120, '[]');
      db.exec('COMMIT');
      mkdirSync(path.join(dir, 'cache', 'previews'), { recursive: true });
      return ok(new ProjectStore(dir, db, id, name, lock.value));
    } catch (e) {
      db?.close();
      unlinkSync(path.join(dir, LOCK_FILE));
      return err('CREATE_FAILED', (e as Error).message);
    }
  }

  static open(dir: string): Result<ProjectStore> {
    const file = path.join(dir, DB_FILE);
    if (!existsSync(file)) return err('NOT_A_PROJECT', 'Thư mục này không chứa dự án EventStory (thiếu project.sqlite).');
    const lock = acquireLock(dir);
    if (!lock.ok) return lock;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(file);
      ProjectStore.pragmas(db);
      const meta = new Map(
        (db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]),
      );
      const version = Number(meta.get('schema_version'));
      if (!Number.isInteger(version) || version > SCHEMA_VERSION) {
        db.close();
        unlinkSync(path.join(dir, LOCK_FILE));
        return err('SCHEMA_TOO_NEW', `Dự án được tạo bởi phiên bản mới hơn (schema ${meta.get('schema_version')}). Hãy cập nhật ứng dụng.`);
      }
      if (version < SCHEMA_VERSION) {
        const migrated = ProjectStore.migrate(db, dir, version);
        if (!migrated.ok) {
          db.close();
          unlinkSync(path.join(dir, LOCK_FILE));
          return migrated;
        }
      }
      mkdirSync(path.join(dir, 'cache', 'previews'), { recursive: true });
      return ok(new ProjectStore(dir, db, meta.get('project_id')!, meta.get('name') ?? 'Dự án', lock.value));
    } catch (e) {
      db?.close();
      try {
        unlinkSync(path.join(dir, LOCK_FILE));
      } catch {
        /* ignore */
      }
      return err('OPEN_FAILED', (e as Error).message);
    }
  }

  /** Consistent backup (VACUUM INTO), then all upgrade steps in one transaction; any error rolls back. */
  private static migrate(db: DatabaseSync, dir: string, from: number): Result<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(dir, `project.v${from}-backup-${stamp}.sqlite`);
    try {
      db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    } catch (e) {
      return err('MIGRATION_FAILED', `Không sao lưu được dự án trước khi nâng cấp: ${(e as Error).message}`);
    }
    try {
      db.exec('BEGIN IMMEDIATE');
      for (let v = from + 1; v <= SCHEMA_VERSION; v++) db.exec(MIGRATIONS[v]!);
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
      db.exec('COMMIT');
      return ok(undefined);
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      return err('MIGRATION_FAILED', `Nâng cấp dự án thất bại, dữ liệu cũ giữ nguyên (bản sao lưu: ${path.basename(backup)}): ${(e as Error).message}`);
    }
  }

  schemaVersion(): number {
    return Number(this.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value);
  }

  meta(key: string): string | null {
    return this.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  private static pragmas(db: DatabaseSync): void {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000; PRAGMA synchronous = NORMAL;');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } finally {
      try {
        const lockPath = path.join(this.dir, LOCK_FILE);
        const held = JSON.parse(readFileSync(lockPath, 'utf8')) as { token?: string };
        if (held.token === this.lockToken) unlinkSync(lockPath);
      } catch {
        /* lock already gone */
      }
    }
  }

  /** Runs `fn` in one write transaction. A failure marks the project dirty instead of pretending it saved. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      this.dirty = false;
      return out;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      this.dirty = true;
      throw e;
    }
  }

  private readonly statements = new Map<string, StatementSync>();
  private prep(sql: string): StatementSync {
    let st = this.statements.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.statements.set(sql, st);
    }
    return st;
  }
  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.prep(sql).all(...params) as T[];
  }
  private get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.prep(sql).get(...params) as T | undefined;
  }
  private run(sql: string, ...params: SQLInputValue[]): void {
    this.prep(sql).run(...params);
  }

  // ---------- snapshot ----------
  snapshot(): ProjectSnapshot {
    const counts = Object.fromEntries(MEDIA_STATUSES.map((s) => [s, 0])) as Record<MediaStatus, number>;
    for (const r of this.all<{ status: MediaStatus; n: number }>(
      `SELECT ${EFFECTIVE_STATUS} AS status, COUNT(*) AS n FROM asset a JOIN file f ON f.id = a.primary_file_id JOIN source s ON s.id = f.source_id GROUP BY status`,
    )) {
      counts[r.status] = r.n;
    }
    return { id: this.id, name: this.name, counts, dirty: this.dirty };
  }

  counts(): { logicalAssets: number; physicalFiles: number } {
    const a = this.get<{ n: number; c: number }>('SELECT COUNT(*) AS n, COUNT(companion_jpeg_id) AS c FROM asset')!;
    return { logicalAssets: a.n, physicalFiles: a.n + a.c };
  }

  // ---------- sources ----------
  sources(): SourceRow[] {
    return this.all<{ id: string; label: string; root_path: string; online: number }>('SELECT * FROM source ORDER BY added_at').map(
      (r) => ({ id: r.id, label: r.label, rootPath: r.root_path, online: r.online === 1 }),
    );
  }

  source(id: string): SourceRow | undefined {
    return this.sources().find((s) => s.id === id);
  }

  addSource(rootPath: string, label: string): SourceRow {
    const id = newId('s');
    this.run('INSERT INTO source (id, label, root_path, added_at, online) VALUES (?, ?, ?, ?, 1)', id, label, rootPath, new Date().toISOString());
    return { id, label, rootPath, online: true };
  }

  setSourceOnline(id: string, online: boolean): void {
    this.run('UPDATE source SET online = ? WHERE id = ?', online ? 1 : 0, id);
  }

  setSourceRoot(id: string, rootPath: string, label: string): void {
    this.run('UPDATE source SET root_path = ?, label = ?, online = 1 WHERE id = ?', rootPath, label, id);
  }

  sourceViews(): SourceView[] {
    const counts = new Map(
      this.all<{ source_id: string; n: number }>("SELECT source_id, COUNT(*) AS n FROM file WHERE kind != 'xmp' GROUP BY source_id").map((r) => [
        r.source_id,
        r.n,
      ]),
    );
    return this.sources().map((s) => ({ id: s.id, label: s.label, online: s.online, fileCount: counts.get(s.id) ?? 0 }));
  }

  // ---------- files ----------
  private mapFile(r: Record<string, unknown>): FileRow {
    return {
      id: r.id as string,
      sourceId: r.source_id as string,
      relativePath: r.relative_path as string,
      kind: r.kind as FileRecord['kind'],
      bytes: r.bytes as number,
      mtimeMs: r.mtime_ms as number,
      sampledHash: r.sampled_hash as string,
      stale: r.stale === 1,
      missing: r.missing === 1,
    };
  }

  fileByPath(sourceId: string, relativePath: string): FileRow | undefined {
    const r = this.get<Record<string, unknown>>('SELECT * FROM file WHERE source_id = ? AND rel_key = ?', sourceId, relativePath.normalize('NFC'));
    return r ? this.mapFile(r) : undefined;
  }

  file(id: FileId): FileRow | undefined {
    const r = this.get<Record<string, unknown>>('SELECT * FROM file WHERE id = ?', id);
    return r ? this.mapFile(r) : undefined;
  }

  filesOfSource(sourceId: string): FileRow[] {
    return this.all<Record<string, unknown>>('SELECT * FROM file WHERE source_id = ?', sourceId).map((r) => this.mapFile(r));
  }

  allFiles(): FileRow[] {
    return this.all<Record<string, unknown>>('SELECT * FROM file').map((r) => this.mapFile(r));
  }

  insertFile(f: Omit<FileRow, 'id' | 'stale' | 'missing'>): FileRow {
    const id = newId('f');
    this.run(
      'INSERT INTO file (id, source_id, relative_path, rel_key, kind, bytes, mtime_ms, sampled_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      f.sourceId,
      f.relativePath,
      f.relativePath.normalize('NFC'),
      f.kind,
      f.bytes,
      f.mtimeMs,
      f.sampledHash,
    );
    return { ...f, id, stale: false, missing: false };
  }

  updateFileIdentity(id: FileId, bytes: number, mtimeMs: number, sampledHash: string, relativePath?: string, sourceId?: string): void {
    if (relativePath !== undefined && sourceId !== undefined) {
      this.run(
        'UPDATE file SET bytes = ?, mtime_ms = ?, sampled_hash = ?, stale = 0, missing = 0, relative_path = ?, rel_key = ?, source_id = ? WHERE id = ?',
        bytes,
        mtimeMs,
        sampledHash,
        relativePath,
        relativePath.normalize('NFC'),
        sourceId,
        id,
      );
    } else {
      this.run('UPDATE file SET bytes = ?, mtime_ms = ?, sampled_hash = ?, stale = 0, missing = 0 WHERE id = ?', bytes, mtimeMs, sampledHash, id);
    }
  }

  /** Detaches a file record from its path (content there is now a different photo); it stays as missing with its asset and decisions. */
  retireFile(id: FileId): void {
    this.run('UPDATE file SET rel_key = ?, missing = 1, stale = 0 WHERE id = ?', `\u0000replaced:${id}`, id);
  }

  /** Points indexed files at their relinked location (two passes so swapped paths do not collide). */
  relinkFiles(sourceId: string, moves: { id: FileId; relativePath: string; bytes: number; mtimeMs: number; sampledHash: string }[]): void {
    const park = this.db.prepare('UPDATE file SET rel_key = ? WHERE id = ?');
    for (const m of moves) park.run(`\u0000relink:${m.id}`, m.id);
    const put = this.db.prepare(
      'UPDATE file SET source_id = ?, relative_path = ?, rel_key = ?, bytes = ?, mtime_ms = ?, sampled_hash = ?, missing = 0, stale = 0 WHERE id = ?',
    );
    for (const m of moves) put.run(sourceId, m.relativePath, m.relativePath.normalize('NFC'), m.bytes, m.mtimeMs, m.sampledHash, m.id);
  }

  setFileFlags(id: FileId, flags: { stale?: boolean; missing?: boolean }): void {
    if (flags.stale !== undefined) this.run('UPDATE file SET stale = ? WHERE id = ?', flags.stale ? 1 : 0, id);
    if (flags.missing !== undefined) this.run('UPDATE file SET missing = ? WHERE id = ?', flags.missing ? 1 : 0, id);
  }

  linkSidecar(xmpId: FileId, rawId: FileId | null): void {
    this.run('UPDATE file SET sidecar_of = ? WHERE id = ?', rawId, xmpId);
  }

  sidecarOf(rawId: FileId): FileRow | undefined {
    const r = this.get<Record<string, unknown>>('SELECT * FROM file WHERE sidecar_of = ?', rawId);
    return r ? this.mapFile(r) : undefined;
  }

  // ---------- assets ----------
  private mapAsset(r: Record<string, unknown>): AssetCore {
    return {
      id: r.id as string,
      primaryFileId: r.primary_file_id as string,
      companionJpegId: (r.companion_jpeg_id as string | null) ?? null,
      pairConfirmed: r.pair_confirmed === 1,
      cameraId: (r.camera_id as string | null) ?? null,
      sortTime: (r.sort_time as string | null) ?? null,
      seq: r.seq as number,
    };
  }

  insertAsset(primaryFileId: FileId): AssetCore {
    const id = newId('a');
    const seq = (this.get<{ m: number | null }>('SELECT MAX(seq) AS m FROM asset')?.m ?? 0) + 1;
    this.run("INSERT INTO asset (id, primary_file_id, media_status, seq) VALUES (?, ?, 'queued', ?)", id, primaryFileId, seq);
    return { id, primaryFileId, companionJpegId: null, pairConfirmed: false, cameraId: null, sortTime: null, seq };
  }

  asset(id: AssetId): AssetCore | undefined {
    const r = this.get<Record<string, unknown>>('SELECT * FROM asset WHERE id = ?', id);
    return r ? this.mapAsset(r) : undefined;
  }

  assetByFile(fileId: FileId): AssetCore | undefined {
    const r = this.get<Record<string, unknown>>('SELECT * FROM asset WHERE primary_file_id = ? OR companion_jpeg_id = ?', fileId, fileId);
    return r ? this.mapAsset(r) : undefined;
  }

  allAssets(): AssetCore[] {
    return this.all<Record<string, unknown>>('SELECT * FROM asset ORDER BY seq').map((r) => this.mapAsset(r));
  }

  /** Returns the subset of `ids` that are not assets of this project. */
  unknownAssetIds(ids: readonly string[]): string[] {
    const known = new Set(this.all<{ id: string }>('SELECT id FROM asset').map((r) => r.id));
    return ids.filter((id) => !known.has(id));
  }

  setMediaStatus(assetId: AssetId, status: MediaStatus, error: string | null = null): void {
    this.run('UPDATE asset SET media_status = ?, error = ? WHERE id = ?', status, error, assetId);
  }

  setCompanion(assetId: AssetId, jpegFileId: FileId | null, confirmed: boolean): void {
    this.run('UPDATE asset SET companion_jpeg_id = ?, pair_confirmed = ? WHERE id = ?', jpegFileId, confirmed ? 1 : 0, assetId);
  }

  deleteAsset(assetId: AssetId): void {
    for (const t of ['decision', 'pack_member', 'feature', 'camera_override', 'face_analysis', 'cull_recommendation']) this.run(`DELETE FROM ${t} WHERE asset_id = ?`, assetId);
    this.run('DELETE FROM asset WHERE id = ?', assetId);
  }

  // ---------- metadata / preview ----------
  saveMetadata(fileId: FileId, m: PhotoMetadata | null, readHash: string, error: string | null): void {
    this.run(
      `INSERT INTO metadata (file_id, camera_id, make, model, serial, captured_local, explicit_offset_minutes, time_source, orientation, error, read_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(file_id) DO UPDATE SET camera_id = excluded.camera_id, make = excluded.make, model = excluded.model, serial = excluded.serial,
         captured_local = excluded.captured_local, explicit_offset_minutes = excluded.explicit_offset_minutes, time_source = excluded.time_source,
         orientation = excluded.orientation, error = excluded.error, read_hash = excluded.read_hash`,
      fileId,
      m?.cameraId ?? null,
      m?.cameraMake ?? null,
      m?.cameraModel ?? null,
      m?.cameraSerial ?? null,
      m?.capturedLocal ?? null,
      m?.explicitOffsetMinutes ?? null,
      m?.timeSource ?? 'missing',
      m?.orientation ?? null,
      error,
      readHash,
    );
  }

  metadata(fileId: FileId): (PhotoMetadata & { readHash: string; error: string | null }) | undefined {
    const r = this.get<Record<string, unknown>>('SELECT * FROM metadata WHERE file_id = ?', fileId);
    if (!r) return undefined;
    return {
      cameraId: (r.camera_id as string | null) ?? null,
      cameraMake: (r.make as string | null) ?? null,
      cameraModel: (r.model as string | null) ?? null,
      cameraSerial: (r.serial as string | null) ?? null,
      capturedLocal: (r.captured_local as string | null) ?? null,
      explicitOffsetMinutes: (r.explicit_offset_minutes as number | null) ?? null,
      timeSource: r.time_source as PhotoMetadata['timeSource'],
      orientation: (r.orientation as number | null) ?? null,
      readHash: r.read_hash as string,
      error: (r.error as string | null) ?? null,
    };
  }

  savePreview(fileId: FileId, p: PreviewRecord, readHash: string): void {
    this.run(
      `INSERT INTO preview (file_id, cache_id, thumb_cache_id, width, height, bytes, origin, source_tag, orientation_applied, insufficient, read_hash, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(file_id) DO UPDATE SET cache_id = excluded.cache_id, thumb_cache_id = excluded.thumb_cache_id, width = excluded.width,
         height = excluded.height, bytes = excluded.bytes, origin = excluded.origin, source_tag = excluded.source_tag,
         orientation_applied = excluded.orientation_applied, insufficient = excluded.insufficient, read_hash = excluded.read_hash,
         last_used_at = excluded.last_used_at`,
      fileId,
      p.cacheId,
      p.thumbCacheId,
      p.width,
      p.height,
      p.bytes,
      p.origin,
      p.sourceTag,
      p.orientationApplied,
      p.insufficientForFocus ? 1 : 0,
      readHash,
      Date.now(),
    );
  }

  deletePreview(fileId: FileId): void {
    this.run('DELETE FROM preview WHERE file_id = ?', fileId);
  }

  preview(fileId: FileId): (PreviewRecord & { readHash: string; lastUsedAt: number }) | undefined {
    const r = this.get<Record<string, unknown>>('SELECT * FROM preview WHERE file_id = ?', fileId);
    return r ? this.mapPreview(r) : undefined;
  }

  private mapPreview(r: Record<string, unknown>): PreviewRecord & { readHash: string; lastUsedAt: number } {
    return {
      cacheId: r.cache_id as string,
      thumbCacheId: r.thumb_cache_id as string,
      width: r.width as number,
      height: r.height as number,
      bytes: r.bytes as number,
      origin: r.origin as PreviewRecord['origin'],
      sourceTag: r.source_tag as string,
      orientationApplied: (r.orientation_applied as number | null) ?? null,
      insufficientForFocus: r.insufficient === 1,
      readHash: r.read_hash as string,
      lastUsedAt: r.last_used_at as number,
    };
  }

  allPreviews(): (PreviewRecord & { fileId: FileId; lastUsedAt: number })[] {
    return this.all<Record<string, unknown>>('SELECT * FROM preview').map((r) => ({ ...this.mapPreview(r), fileId: r.file_id as string }));
  }

  touchPreviews(fileIds: FileId[]): void {
    if (fileIds.length === 0) return;
    const now = Date.now();
    const st = this.prep('UPDATE preview SET last_used_at = ? WHERE file_id = ?');
    const own = !this.db.isTransaction;
    if (own) this.db.exec('BEGIN');
    try {
      for (const id of fileIds) st.run(now, id);
      if (own) this.db.exec('COMMIT');
    } catch (e) {
      if (own) this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** One row per asset with what RAW+JPEG pairing needs (single query). */
  pairInputs(): { assetId: AssetId; paired: boolean; fileId: FileId; sourceId: string; relativePath: string; kind: 'raw' | 'jpeg'; sampledHash: string; model: string | null; serial: string | null; capturedLocal: string | null; readHash: string | null }[] {
    return this.all<Record<string, unknown>>(
      `SELECT a.id AS asset_id, a.companion_jpeg_id, f.id AS file_id, f.source_id, f.relative_path, f.kind, f.sampled_hash,
              m.model, m.serial, m.captured_local, m.read_hash
       FROM asset a JOIN file f ON f.id = a.primary_file_id LEFT JOIN metadata m ON m.file_id = f.id
       WHERE f.kind != 'xmp'`,
    ).map((r) => ({
      assetId: r.asset_id as string,
      paired: r.companion_jpeg_id !== null,
      fileId: r.file_id as string,
      sourceId: r.source_id as string,
      relativePath: r.relative_path as string,
      kind: r.kind as 'raw' | 'jpeg',
      sampledHash: r.sampled_hash as string,
      model: (r.model as string | null) ?? null,
      serial: (r.serial as string | null) ?? null,
      capturedLocal: (r.captured_local as string | null) ?? null,
      readHash: (r.read_hash as string | null) ?? null,
    }));
  }

  // ---------- face analysis (v2) ----------
  faceAnalysis(assetId: AssetId): FaceAnalysisRow | undefined {
    const r = this.get<Record<string, unknown>>('SELECT * FROM face_analysis WHERE asset_id = ?', assetId);
    if (!r) return undefined;
    return {
      assetId: r.asset_id as string,
      inputKey: r.input_key as string,
      sourceKind: r.source_kind as AnalysisSourceKind,
      sourceFileId: r.source_file_id as string,
      prepVersion: r.prep_version as string,
      provider: r.provider as string,
      idempotencyKey: r.idempotency_key as string,
      requestId: (r.request_id as string | null) ?? null,
      status: r.status as FaceAnalysisRow['status'],
      imageWidth: (r.image_width as number | null) ?? null,
      imageHeight: (r.image_height as number | null) ?? null,
      uploadBytes: (r.upload_bytes as number | null) ?? null,
      resultJson: (r.result_json as string | null) ?? null,
      error: (r.error as string | null) ?? null,
      updatedAt: r.updated_at as string,
    };
  }

  upsertFaceAnalysis(a: FaceAnalysisRow): void {
    this.run(
      `INSERT INTO face_analysis (asset_id, input_key, source_kind, source_file_id, prep_version, provider, idempotency_key, request_id, status,
         image_width, image_height, upload_bytes, result_json, error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(asset_id) DO UPDATE SET input_key = excluded.input_key, source_kind = excluded.source_kind, source_file_id = excluded.source_file_id,
         prep_version = excluded.prep_version, provider = excluded.provider, idempotency_key = excluded.idempotency_key, request_id = excluded.request_id,
         status = excluded.status, image_width = excluded.image_width, image_height = excluded.image_height, upload_bytes = excluded.upload_bytes,
         result_json = excluded.result_json, error = excluded.error, updated_at = excluded.updated_at`,
      a.assetId,
      a.inputKey,
      a.sourceKind,
      a.sourceFileId,
      a.prepVersion,
      a.provider,
      a.idempotencyKey,
      a.requestId,
      a.status,
      a.imageWidth,
      a.imageHeight,
      a.uploadBytes,
      a.resultJson,
      a.error,
      a.updatedAt,
    );
  }

  /** Removes a pending row created for a send that the backend refused before calling AWS. */
  deleteFaceAnalysisIfPending(assetId: AssetId, inputKey: string): void {
    this.run("DELETE FROM face_analysis WHERE asset_id = ? AND input_key = ? AND status = 'pending' AND request_id IS NULL", assetId, inputKey);
  }

  /** Analysis state for display; `stale` when the stored result belongs to other content/preprocessing. */
  analysisView(a: AssetCore): AssetAnalysisView | null {
    const row = this.faceAnalysis(a.id);
    if (!row) return null;
    const { role, fileId } = a.companionJpegId && a.pairConfirmed ? { role: 'companion' as const, fileId: a.companionJpegId } : { role: 'primary' as const, fileId: a.primaryFileId };
    const f = this.file(fileId);
    const fresh = !!f && !f.missing && !f.stale && compatibleInputKey(role, f.id, f.sampledHash, row.inputKey) === row.inputKey;
    let faces: FaceAssessment[] | null = null;
    if (row.status === 'done' && row.resultJson && row.imageWidth && row.imageHeight) {
      faces = row.provider.startsWith('mediapipe-face-landmarker-')
        ? JSON.parse(row.resultJson) as FaceAssessment[]
        : (JSON.parse(row.resultJson) as ProviderFaceInput[]).map((pf) => assessFace(pf, row.imageWidth!, row.imageHeight!));
    }
    return {
      status: fresh ? row.status : 'stale',
      provider: row.provider,
      sourceKind: row.sourceKind,
      imageWidth: row.imageWidth,
      imageHeight: row.imageHeight,
      faces,
      error: row.error,
    };
  }

  // ---------- AutoCull (v2) ----------
  /** Rows changed on this connection since it opened (monotonic): a cheap cache key for derived views. */
  totalChanges(): number {
    return this.get<{ n: number }>('SELECT total_changes() AS n')!.n;
  }

  /** Identity of every stored analysis (no result payload). */
  faceAnalysisMeta(): Map<AssetId, { inputKey: string; status: string; updatedAt: string }> {
    return new Map(
      this.all<{ asset_id: string; input_key: string; status: string; updated_at: string }>('SELECT asset_id, input_key, status, updated_at FROM face_analysis').map((r) => [
        r.asset_id,
        { inputKey: r.input_key, status: r.status, updatedAt: r.updated_at },
      ]),
    );
  }

  createCullRun(r: { id: string; provider: string; configVersion: string; groupingVersion: string }): void {
    this.run(
      "INSERT INTO cull_run (id, created_at, status, provider, config_version, grouping_version, total, done) VALUES (?, ?, 'running', ?, ?, ?, 0, 0)",
      r.id,
      new Date().toISOString(),
      r.provider,
      r.configVersion,
      r.groupingVersion,
    );
  }

  updateCullRun(id: string, patch: { status?: CullRun['status']; total?: number; done?: number; error?: string | null }): void {
    const cur = this.get<Record<string, unknown>>('SELECT * FROM cull_run WHERE id = ?', id);
    if (!cur) return;
    const status = patch.status ?? (cur.status as string);
    const finished = status !== 'running' ? new Date().toISOString() : null;
    this.run(
      'UPDATE cull_run SET status = ?, total = ?, done = ?, error = ?, finished_at = ? WHERE id = ?',
      status,
      patch.total ?? (cur.total as number),
      patch.done ?? (cur.done as number),
      patch.error === undefined ? ((cur.error as string | null) ?? null) : patch.error,
      finished,
      id,
    );
  }

  latestCullRun(): CullRun | null {
    const r = this.get<Record<string, unknown>>('SELECT * FROM cull_run ORDER BY created_at DESC, rowid DESC LIMIT 1');
    if (!r) return null;
    return {
      id: r.id as string,
      status: r.status as CullRun['status'],
      provider: r.provider as string,
      configVersion: r.config_version as string,
      total: r.total as number,
      done: r.done as number,
      createdAt: r.created_at as string,
      error: (r.error as string | null) ?? null,
    };
  }

  /** Runs left 'running' by a closed or crashed app are shown as paused; the user can start again. */
  pauseInterruptedCullRuns(): void {
    this.run(
      "UPDATE cull_run SET status = 'paused', error = COALESCE(error, 'Bị gián đoạn khi ứng dụng đóng.'), finished_at = ? WHERE status = 'running'",
      new Date().toISOString(),
    );
  }

  /** Only the latest ranked run's recommendations are kept. */
  replaceRecommendations(runId: string, recs: Omit<CullRecommendationRow, 'runId'>[]): void {
    this.run('DELETE FROM cull_recommendation');
    // Assets removed while the run was ranking (e.g. a JPEG merged into a RAW+JPEG pair) are skipped.
    const put = this.db.prepare(
      `INSERT INTO cull_recommendation (run_id, asset_id, group_id, rank, label, best_asset_id, reasons, quality, revision)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM asset WHERE id = ?2)`,
    );
    for (const r of recs) put.run(runId, r.assetId, r.groupId, r.rank, r.label, r.bestAssetId, JSON.stringify(r.reasons), JSON.stringify(r.quality), r.revision);
  }

  recommendations(): Map<AssetId, CullRecommendationRow> {
    const out = new Map<AssetId, CullRecommendationRow>();
    for (const r of this.all<Record<string, unknown>>('SELECT * FROM cull_recommendation')) {
      out.set(r.asset_id as string, {
        runId: r.run_id as string,
        assetId: r.asset_id as string,
        groupId: r.group_id as string,
        rank: r.rank as number,
        label: r.label as CullLabel,
        bestAssetId: (r.best_asset_id as string | null) ?? null,
        reasons: JSON.parse(r.reasons as string) as string[],
        quality: JSON.parse(r.quality as string) as QualityAssessment,
        revision: r.revision as string,
      });
    }
    return out;
  }

  contentHash(fileId: FileId): { sampledHash: string; sha256: string } | undefined {
    const r = this.get<{ sampled_hash: string; sha256: string }>('SELECT sampled_hash, sha256 FROM content_hash WHERE file_id = ?', fileId);
    return r ? { sampledHash: r.sampled_hash, sha256: r.sha256 } : undefined;
  }

  saveContentHash(fileId: FileId, sampledHash: string, sha256: string): void {
    this.run(
      'INSERT INTO content_hash (file_id, sampled_hash, sha256) VALUES (?, ?, ?) ON CONFLICT(file_id) DO UPDATE SET sampled_hash = excluded.sampled_hash, sha256 = excluded.sha256',
      fileId,
      sampledHash,
      sha256,
    );
  }

  // ---------- cameras & time ----------
  cameraOffset(cameraId: string): number {
    return this.get<{ offset_seconds: number }>('SELECT offset_seconds FROM camera WHERE camera_id = ?', cameraId)?.offset_seconds ?? 0;
  }

  setCameraOffset(cameraId: string, offsetSeconds: number): void {
    this.run(
      'INSERT INTO camera (camera_id, offset_seconds) VALUES (?, ?) ON CONFLICT(camera_id) DO UPDATE SET offset_seconds = excluded.offset_seconds',
      cameraId,
      offsetSeconds,
    );
    for (const a of this.all<{ id: string }>('SELECT id FROM asset WHERE camera_id = ?', cameraId)) this.refreshAssetDerived(a.id);
  }

  setCameraOverride(assetIds: AssetId[], cameraId: string, label: string): void {
    this.run('INSERT INTO camera (camera_id, label) VALUES (?, ?) ON CONFLICT(camera_id) DO UPDATE SET label = excluded.label', cameraId, label);
    const st = this.db.prepare(
      'INSERT INTO camera_override (asset_id, camera_id) VALUES (?, ?) ON CONFLICT(asset_id) DO UPDATE SET camera_id = excluded.camera_id',
    );
    for (const id of assetIds) {
      st.run(id, cameraId);
      this.refreshAssetDerived(id);
    }
  }

  cameraOverride(assetId: AssetId): string | null {
    return this.get<{ camera_id: string }>('SELECT camera_id FROM camera_override WHERE asset_id = ?', assetId)?.camera_id ?? null;
  }

  /** Metadata used for an asset: the primary file's, falling back to a confirmed companion JPEG's for time. */
  assetMetadata(a: AssetCore): (PhotoMetadata & { error: string | null }) | null {
    const primary = this.metadata(a.primaryFileId) ?? null;
    if (a.companionJpegId && a.pairConfirmed && (!primary || primary.timeSource === 'missing')) {
      const comp = this.metadata(a.companionJpegId);
      if (comp && comp.timeSource !== 'missing') return { ...(primary ?? comp), capturedLocal: comp.capturedLocal, explicitOffsetMinutes: comp.explicitOffsetMinutes, timeSource: comp.timeSource };
    }
    return primary;
  }

  effectiveCameraId(a: AssetCore): string | null {
    const override = this.cameraOverride(a.id);
    if (override) return override;
    const m = this.assetMetadata(a);
    if (!m) return null;
    if (m.cameraId) return m.cameraId;
    if (!m.cameraMake && !m.cameraModel) return null;
    const file = this.file(a.primaryFileId);
    // Without a serial number two bodies of the same model cannot be told apart: scope by source.
    return cameraIdFor(m.cameraMake, m.cameraModel, `source:${file?.sourceId ?? ''}`);
  }

  refreshAssetDerived(assetId: AssetId): void {
    const a = this.asset(assetId);
    if (!a) return;
    const cameraId = this.effectiveCameraId(a);
    const m = this.assetMetadata(a);
    const offset = cameraId ? this.cameraOffset(cameraId) : 0;
    const sortTime = effectiveLocal(m?.capturedLocal ?? null, offset);
    if (cameraId) this.run('INSERT OR IGNORE INTO camera (camera_id) VALUES (?)', cameraId);
    this.run('UPDATE asset SET camera_id = ?, sort_time = ? WHERE id = ?', cameraId, sortTime, assetId);
  }

  cameraViews(): CameraView[] {
    const rows = this.all<Record<string, unknown>>(
      `SELECT a.camera_id, COUNT(*) AS n, MIN(a.id) AS sample, cam.offset_seconds, cam.label,
              m.make, m.model, m.serial, m.captured_local, s.label AS source_label,
              (SELECT COUNT(*) FROM camera_override o WHERE o.camera_id = a.camera_id) AS overrides
       FROM asset a
       JOIN file f ON f.id = a.primary_file_id
       JOIN source s ON s.id = f.source_id
       LEFT JOIN metadata m ON m.file_id = a.primary_file_id
       LEFT JOIN camera cam ON cam.camera_id = a.camera_id
       WHERE a.camera_id IS NOT NULL
       GROUP BY a.camera_id
       ORDER BY m.model, a.camera_id`,
    );
    return rows.map((r) => {
      const serial = (r.serial as string | null) ?? null;
      const model = (r.model as string | null) ?? null;
      const userLabel = (r.label as string | null) ?? null;
      const sample = this.get<{ id: string; captured_local: string | null }>(
        `SELECT a.id, m.captured_local FROM asset a LEFT JOIN metadata m ON m.file_id = a.primary_file_id
         WHERE a.camera_id = ? ORDER BY a.sort_time IS NULL, a.sort_time, a.seq LIMIT 1`,
        r.camera_id as string,
      );
      const overridden = (r.overrides as number) > 0;
      return {
        cameraId: r.camera_id as string,
        label: userLabel ?? (serial ? `${model ?? 'Máy ảnh'} · số máy ${serial}` : `${model ?? 'Máy ảnh'} · nguồn ${r.source_label as string}`),
        make: (r.make as string | null) ?? null,
        model,
        serial: overridden ? null : serial,
        offsetSeconds: (r.offset_seconds as number | null) ?? 0,
        assetCount: r.n as number,
        sampleAssetId: sample?.id ?? null,
        sampleCapturedLocal: sample?.captured_local ?? null,
        needsIdentity: !serial && !overridden,
      };
    });
  }

  // ---------- decisions ----------
  decision(assetId: AssetId): Decision {
    const r = this.get<Record<string, unknown>>('SELECT * FROM decision WHERE asset_id = ?', assetId);
    return r ? this.mapDecision(r) : defaultDecision(assetId);
  }

  private mapDecision(r: Record<string, unknown>): Decision {
    return {
      assetId: r.asset_id as string,
      state: r.state as Decision['state'],
      rating: r.rating as Decision['rating'],
      consent: r.consent as Decision['consent'],
      targetIds: JSON.parse(r.target_ids as string) as string[],
    };
  }

  allDecisions(): Map<AssetId, Decision> {
    const out = new Map<AssetId, Decision>();
    for (const a of this.all<{ id: string }>('SELECT id FROM asset')) out.set(a.id, defaultDecision(a.id));
    for (const r of this.all<Record<string, unknown>>('SELECT * FROM decision')) out.set(r.asset_id as string, this.mapDecision(r));
    return out;
  }

  saveDecision(d: Decision): void {
    this.run(
      `INSERT INTO decision (asset_id, state, rating, consent, target_ids) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(asset_id) DO UPDATE SET state = excluded.state, rating = excluded.rating, consent = excluded.consent, target_ids = excluded.target_ids`,
      d.assetId,
      d.state,
      d.rating,
      d.consent,
      JSON.stringify(d.targetIds),
    );
  }

  // ---------- targets / packs ----------
  targets(): CoverageTarget[] {
    return this.all<Record<string, unknown>>('SELECT * FROM target ORDER BY position, id').map((r) => ({
      id: r.id as string,
      label: r.label as string,
      required: r.required === 1,
      requiresConsent: r.requires_consent === 1,
      minCount: r.min_count as number,
    }));
  }

  replaceTargets(targets: CoverageTarget[]): void {
    this.run('DELETE FROM target');
    const st = this.db.prepare('INSERT INTO target (id, label, required, requires_consent, min_count, position) VALUES (?, ?, ?, ?, ?, ?)');
    targets.forEach((t, i) => st.run(t.id, t.label, t.required ? 1 : 0, t.requiresConsent ? 1 : 0, t.minCount, i));
  }

  packRules(): PackRule[] {
    return this.all<Record<string, unknown>>("SELECT * FROM pack_rule ORDER BY CASE pack_id WHEN 'quick' THEN 0 ELSE 1 END").map((r) => ({
      id: r.pack_id as PackId,
      limit: (r.limit_count as number | null) ?? null,
      targetIds: JSON.parse(r.target_ids as string) as string[],
    }));
  }

  savePackRule(rule: PackRule): void {
    this.run(
      'INSERT INTO pack_rule (pack_id, limit_count, target_ids) VALUES (?, ?, ?) ON CONFLICT(pack_id) DO UPDATE SET limit_count = excluded.limit_count, target_ids = excluded.target_ids',
      rule.id,
      rule.limit,
      JSON.stringify(rule.targetIds),
    );
  }

  packMembers(): PackMember[] {
    return this.all<Record<string, unknown>>('SELECT * FROM pack_member').map((r) => ({
      packId: r.pack_id as PackId,
      assetId: r.asset_id as string,
      pinned: r.pinned === 1,
    }));
  }

  replacePackMembers(members: PackMember[]): void {
    this.run('DELETE FROM pack_member');
    const st = this.db.prepare('INSERT INTO pack_member (pack_id, asset_id, pinned) VALUES (?, ?, ?)');
    for (const m of members) st.run(m.packId, m.assetId, m.pinned ? 1 : 0);
  }

  // ---------- groups ----------
  groups(): (Group & { configVersion: string })[] {
    return this.all<Record<string, unknown>>('SELECT * FROM grp').map((r) => ({
      id: r.id as string,
      assetIds: JSON.parse(r.asset_ids as string) as string[],
      confidence: r.confidence as Group['confidence'],
      manual: r.manual === 1,
      configVersion: r.config_version as string,
    }));
  }

  replaceGroups(groups: Group[], configVersion: string): void {
    this.run('DELETE FROM grp');
    const st = this.db.prepare('INSERT INTO grp (id, confidence, manual, config_version, asset_ids) VALUES (?, ?, ?, ?, ?)');
    for (const g of groups) st.run(g.id, g.confidence, g.manual ? 1 : 0, configVersion, JSON.stringify(g.assetIds));
  }

  // ---------- features ----------
  saveFeature(assetId: AssetId, algorithmVersion: string, json: string): void {
    this.run(
      'INSERT INTO feature (asset_id, algorithm_version, json) VALUES (?, ?, ?) ON CONFLICT(asset_id) DO UPDATE SET algorithm_version = excluded.algorithm_version, json = excluded.json',
      assetId,
      algorithmVersion,
      json,
    );
  }

  features(): Map<AssetId, { algorithmVersion: string; json: string }> {
    return new Map(
      this.all<{ asset_id: string; algorithm_version: string; json: string }>('SELECT * FROM feature').map((r) => [
        r.asset_id,
        { algorithmVersion: r.algorithm_version, json: r.json },
      ]),
    );
  }

  // ---------- deliveries ----------
  deliveries(): DeliveryEvent[] {
    return this.all<Record<string, unknown>>('SELECT * FROM delivery ORDER BY seq').map((r) => ({
      id: r.id as string,
      at: r.at as string,
      packId: r.pack_id as PackId,
      assetIds: JSON.parse(r.asset_ids as string) as string[],
      fileFingerprints: JSON.parse(r.file_fingerprints as string) as Record<string, string>,
      correctsEventId: (r.corrects_event_id as string | null) ?? null,
    }));
  }

  insertDelivery(e: DeliveryEvent): void {
    const seq = (this.get<{ m: number | null }>('SELECT MAX(seq) AS m FROM delivery')?.m ?? 0) + 1;
    this.run(
      'INSERT INTO delivery (id, at, pack_id, asset_ids, file_fingerprints, corrects_event_id, seq) VALUES (?, ?, ?, ?, ?, ?, ?)',
      e.id,
      e.at,
      e.packId,
      JSON.stringify(e.assetIds),
      JSON.stringify(e.fileFingerprints),
      e.correctsEventId,
      seq,
    );
  }

  // ---------- undo journal ----------
  pushUndo(command: unknown, before: unknown): void {
    this.run('INSERT INTO undo (at, command, before) VALUES (?, ?, ?)', new Date().toISOString(), JSON.stringify(command), JSON.stringify(before));
    // Keep the journal bounded.
    this.run('DELETE FROM undo WHERE seq <= (SELECT MAX(seq) FROM undo) - 500');
  }

  popUndo(): { command: unknown; before: unknown } | null {
    const r = this.get<{ seq: number; command: string; before: string }>('SELECT * FROM undo ORDER BY seq DESC LIMIT 1');
    if (!r) return null;
    this.run('DELETE FROM undo WHERE seq = ?', r.seq);
    return { command: JSON.parse(r.command), before: JSON.parse(r.before) };
  }

  canUndo(): boolean {
    return (this.get<{ n: number }>('SELECT COUNT(*) AS n FROM undo')?.n ?? 0) > 0;
  }

  // ---------- jobs ----------
  createJob(kind: string, params: unknown): string {
    const id = newId('j');
    this.run("INSERT INTO job (id, kind, state, created_at, params) VALUES (?, ?, 'running', ?, ?)", id, kind, new Date().toISOString(), JSON.stringify(params));
    return id;
  }

  setJobState(id: string, state: 'running' | 'complete' | 'complete-with-errors' | 'cancelled' | 'failed'): void {
    this.run('UPDATE job SET state = ? WHERE id = ?', state, id);
  }

  job(id: string): { id: string; kind: string; state: string; params: unknown } | undefined {
    const r = this.get<{ id: string; kind: string; state: string; params: string }>('SELECT * FROM job WHERE id = ?', id);
    return r ? { ...r, params: JSON.parse(r.params) } : undefined;
  }

  runningJobs(): { id: string; kind: string; params: unknown }[] {
    return this.all<{ id: string; kind: string; params: string }>("SELECT * FROM job WHERE state = 'running'").map((r) => ({
      ...r,
      params: JSON.parse(r.params),
    }));
  }

  addJobFile(jobId: string, fileId: FileId, seq: number): void {
    this.run('INSERT OR IGNORE INTO job_file (job_id, file_id, done, seq) VALUES (?, ?, 0, ?)', jobId, fileId, seq);
  }

  markJobFileDone(jobId: string, fileId: FileId): void {
    this.run('UPDATE job_file SET done = 1 WHERE job_id = ? AND file_id = ?', jobId, fileId);
  }

  jobFiles(jobId: string): { fileId: FileId; done: boolean }[] {
    return this.all<{ file_id: string; done: number }>('SELECT file_id, done FROM job_file WHERE job_id = ? ORDER BY seq', jobId).map((r) => ({
      fileId: r.file_id,
      done: r.done === 1,
    }));
  }

  // ---------- query ----------
  queryAssets(
    query: AssetQuery,
    groupOf: (id: AssetId) => string | null,
    groupMembers?: AssetId[],
    cullOf: (id: AssetId) => AssetCullView = NO_CULL,
    listMembers?: AssetId[],
  ): { total: number; items: AssetView[] } {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    let join = '';
    if (query.packId) {
      join += ' JOIN pack_member pm ON pm.asset_id = a.id AND pm.pack_id = ?';
      params.push(query.packId);
    }
    if (query.cameraId) {
      where.push('a.camera_id = ?');
      params.push(query.cameraId);
    }
    if (query.text) {
      where.push("f.relative_path LIKE ? ESCAPE '\\'");
      params.push(`%${query.text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    }
    if (query.state) {
      where.push("COALESCE(d.state, 'unreviewed') = ?");
      params.push(query.state);
    }
    if (groupMembers) {
      where.push(`a.id IN (SELECT value FROM json_each(?))`);
      params.push(JSON.stringify(groupMembers));
    }
    if (listMembers) {
      where.push(`a.id IN (SELECT value FROM json_each(?))`);
      params.push(JSON.stringify(listMembers));
    }
    const base = `FROM asset a
      JOIN file f ON f.id = a.primary_file_id
      JOIN source s ON s.id = f.source_id
      LEFT JOIN decision d ON d.asset_id = a.id
      ${join}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
    const total = this.get<{ n: number }>(`SELECT COUNT(*) AS n ${base}`, ...params)!.n;
    const rows = this.all<Record<string, unknown>>(
      `SELECT a.id, ${EFFECTIVE_STATUS} AS status ${base}
       ORDER BY a.sort_time IS NULL, a.sort_time, f.relative_path, a.seq
       LIMIT ? OFFSET ?`,
      ...params,
      query.limit,
      query.offset,
    );
    const items: AssetView[] = [];
    const memberRows = this.packMembers();
    const touched: FileId[] = [];
    for (const r of rows) {
      const view = this.assetView(r.id as string, r.status as MediaStatus, groupOf, memberRows, cullOf);
      if (!view) continue;
      items.push(view);
      const a = this.asset(view.id);
      const dp = a ? this.displayPreview(a) : null;
      if (dp) touched.push(dp.fileId);
    }
    this.touchPreviews(touched);
    return { total, items };
  }

  /** Every asset ID in the album's display order (time, then path). */
  assetIdsInAlbumOrder(): AssetId[] {
    return this.all<{ id: string }>(
      'SELECT a.id FROM asset a JOIN file f ON f.id = a.primary_file_id ORDER BY a.sort_time IS NULL, a.sort_time, f.relative_path, a.seq',
    ).map((r) => r.id);
  }

  assetStatus(assetId: AssetId): MediaStatus | undefined {
    return this.get<{ status: MediaStatus }>(
      `SELECT ${EFFECTIVE_STATUS} AS status FROM asset a JOIN file f ON f.id = a.primary_file_id JOIN source s ON s.id = f.source_id WHERE a.id = ?`,
      assetId,
    )?.status;
  }

  /** Preview chosen for display: the primary's, or a confirmed companion JPEG's when that is better. */
  displayPreview(a: AssetCore): (PreviewRecord & { readHash: string; lastUsedAt: number; fileId: FileId }) | null {
    const p = this.preview(a.primaryFileId);
    const c = a.companionJpegId && a.pairConfirmed ? this.preview(a.companionJpegId) : undefined;
    if (c && (!p || (p.insufficientForFocus && !c.insufficientForFocus))) return { ...c, fileId: a.companionJpegId! };
    return p ? { ...p, fileId: a.primaryFileId } : null;
  }

  assetView(id: AssetId, status: MediaStatus, groupOf: (id: AssetId) => string | null, members: PackMember[], cullOf: (id: AssetId) => AssetCullView = NO_CULL): AssetView | null {
    const a = this.asset(id);
    if (!a) return null;
    const pf = this.file(a.primaryFileId)!;
    const cf = a.companionJpegId ? this.file(a.companionJpegId) : undefined;
    const m = this.assetMetadata(a);
    const offset = a.cameraId ? this.cameraOffset(a.cameraId) : 0;
    const p = this.displayPreview(a);
    const feat = this.get<{ json: string }>('SELECT json FROM feature WHERE asset_id = ?', id);
    const f = feat ? (JSON.parse(feat.json) as { laplacianVariance: number; clippedFraction: number }) : null;
    const err0 = this.get<{ error: string | null }>('SELECT error FROM asset WHERE id = ?', id)?.error ?? null;
    const cams = a.cameraId ? this.get<{ label: string | null }>('SELECT label FROM camera WHERE camera_id = ?', a.cameraId) : undefined;
    const notes: string[] = [];
    if (!m || m.timeSource === 'missing') notes.push('Thiếu giờ chụp trong EXIF');
    else if (m.timeSource === 'exif-no-zone') notes.push('EXIF không ghi múi giờ');
    if (offset !== 0) notes.push(`Đã chỉnh lệch giờ máy ${formatOffset(offset)} (chỉ trong dự án)`);
    const packs = {
      quick: { member: false, pinned: false },
      edit: { member: false, pinned: false },
    };
    for (const pm of members) if (pm.assetId === id) packs[pm.packId] = { member: true, pinned: pm.pinned };
    const fv = (x: FileRow) => ({ id: x.id, sourceId: x.sourceId, relativePath: x.relativePath, kind: x.kind, bytes: x.bytes });
    return {
      id,
      status,
      primary: fv(pf),
      companion: cf ? fv(cf) : null,
      pairConfirmed: a.pairConfirmed,
      cameraId: a.cameraId,
      cameraLabel: cams?.label ?? (m ? [m.cameraMake, m.cameraModel].filter(Boolean).join(' ') || null : null),
      capturedLocal: m?.capturedLocal ?? null,
      effectiveLocal: effectiveLocal(m?.capturedLocal ?? null, offset),
      timeSource: m?.timeSource ?? 'missing',
      timeNote: notes.length ? notes.join(' · ') : null,
      preview: p
        ? {
            url: `es-preview://${this.id}/${p.cacheId}`,
            thumbUrl: `es-preview://${this.id}/${p.thumbCacheId}`,
            width: p.width,
            height: p.height,
            bytes: p.bytes,
            origin: p.origin,
            sourceTag: p.sourceTag,
            orientationApplied: p.orientationApplied,
            insufficientForFocus: p.insufficientForFocus,
          }
        : null,
      decision: this.decision(id),
      groupId: groupOf(id),
      packs,
      signals: f ? { laplacianVariance: f.laplacianVariance, clippedFraction: f.clippedFraction } : null,
      analysis: this.analysisView(a),
      cull: cullOf(id),
      error: err0,
    };
  }
}

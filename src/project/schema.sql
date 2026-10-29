-- EventStory Cull project schema, version 1.
-- The worker is the only writer. Decisions, pack membership, pins, targets, clock offsets,
-- manual groups, deliveries and the undo journal never depend on analysis results.

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE source (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  root_path TEXT NOT NULL,
  added_at TEXT NOT NULL,
  online INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE file (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source(id),
  relative_path TEXT NOT NULL,
  rel_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('raw', 'jpeg', 'xmp')),
  bytes INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  sampled_hash TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  missing INTEGER NOT NULL DEFAULT 0,
  sidecar_of TEXT REFERENCES file(id),
  UNIQUE (source_id, rel_key)
);
CREATE INDEX file_hash ON file (bytes, sampled_hash);

CREATE TABLE asset (
  id TEXT PRIMARY KEY,
  primary_file_id TEXT NOT NULL UNIQUE REFERENCES file(id),
  companion_jpeg_id TEXT UNIQUE REFERENCES file(id),
  pair_confirmed INTEGER NOT NULL DEFAULT 0,
  media_status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  camera_id TEXT,
  sort_time TEXT,
  seq INTEGER NOT NULL
);
CREATE INDEX asset_sort ON asset (sort_time, seq);
CREATE INDEX asset_camera ON asset (camera_id);

CREATE TABLE metadata (
  file_id TEXT PRIMARY KEY REFERENCES file(id),
  camera_id TEXT,
  make TEXT,
  model TEXT,
  serial TEXT,
  captured_local TEXT,
  explicit_offset_minutes INTEGER,
  time_source TEXT NOT NULL,
  orientation INTEGER,
  error TEXT,
  read_hash TEXT NOT NULL
);

CREATE TABLE preview (
  file_id TEXT PRIMARY KEY REFERENCES file(id),
  cache_id TEXT NOT NULL,
  thumb_cache_id TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  origin TEXT NOT NULL,
  source_tag TEXT NOT NULL,
  orientation_applied INTEGER,
  insufficient INTEGER NOT NULL,
  read_hash TEXT NOT NULL,
  last_used_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE feature (
  asset_id TEXT PRIMARY KEY REFERENCES asset(id),
  algorithm_version TEXT NOT NULL,
  json TEXT NOT NULL
);

CREATE TABLE camera (
  camera_id TEXT PRIMARY KEY,
  offset_seconds INTEGER NOT NULL DEFAULT 0,
  label TEXT
);

CREATE TABLE camera_override (
  asset_id TEXT PRIMARY KEY REFERENCES asset(id),
  camera_id TEXT NOT NULL
);

CREATE TABLE decision (
  asset_id TEXT PRIMARY KEY REFERENCES asset(id),
  state TEXT NOT NULL DEFAULT 'unreviewed',
  rating INTEGER NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
  consent TEXT NOT NULL DEFAULT 'unknown',
  target_ids TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE target (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  required INTEGER NOT NULL,
  requires_consent INTEGER NOT NULL,
  min_count INTEGER NOT NULL,
  position INTEGER NOT NULL
);

CREATE TABLE pack_rule (
  pack_id TEXT PRIMARY KEY CHECK (pack_id IN ('quick', 'edit')),
  limit_count INTEGER,
  target_ids TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE pack_member (
  pack_id TEXT NOT NULL CHECK (pack_id IN ('quick', 'edit')),
  asset_id TEXT NOT NULL REFERENCES asset(id),
  pinned INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pack_id, asset_id)
);

CREATE TABLE grp (
  id TEXT PRIMARY KEY,
  confidence TEXT NOT NULL,
  manual INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  asset_ids TEXT NOT NULL
);

CREATE TABLE delivery (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  asset_ids TEXT NOT NULL,
  file_fingerprints TEXT NOT NULL,
  corrects_event_id TEXT REFERENCES delivery(id),
  seq INTEGER NOT NULL
);
CREATE TRIGGER delivery_no_update BEFORE UPDATE ON delivery BEGIN SELECT RAISE(ABORT, 'delivery events are immutable'); END;
CREATE TRIGGER delivery_no_delete BEFORE DELETE ON delivery BEGIN SELECT RAISE(ABORT, 'delivery events are immutable'); END;

CREATE TABLE job (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  params TEXT NOT NULL
);

CREATE TABLE job_file (
  job_id TEXT NOT NULL REFERENCES job(id),
  file_id TEXT NOT NULL REFERENCES file(id),
  done INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, file_id)
);

CREATE TABLE undo (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  command TEXT NOT NULL,
  before TEXT NOT NULL
);

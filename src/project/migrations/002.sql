-- Schema v2 (EventStory Cull v0.2): face analysis, AutoCull runs and recommendations,
-- full content hashes for exact duplicates. Additive only: no v1 table or row is changed.

CREATE TABLE face_analysis (
  asset_id TEXT PRIMARY KEY REFERENCES asset(id),
  -- Identity of the analysed input: source file + its content sample + source kind + preprocessing version.
  input_key TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_file_id TEXT NOT NULL REFERENCES file(id),
  prep_version TEXT NOT NULL,
  provider TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
  image_width INTEGER,
  image_height INTEGER,
  upload_bytes INTEGER,
  result_json TEXT,
  error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE cull_run (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT NOT NULL,
  config_version TEXT NOT NULL,
  grouping_version TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  finished_at TEXT
);

CREATE TABLE cull_recommendation (
  run_id TEXT NOT NULL REFERENCES cull_run(id),
  asset_id TEXT NOT NULL REFERENCES asset(id),
  group_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  label TEXT NOT NULL CHECK (label IN ('keep', 'better-option', 'review')),
  best_asset_id TEXT,
  reasons TEXT NOT NULL,
  quality TEXT NOT NULL,
  revision TEXT NOT NULL,
  PRIMARY KEY (run_id, asset_id)
);
CREATE INDEX cull_recommendation_label ON cull_recommendation (run_id, label);

CREATE TABLE content_hash (
  file_id TEXT PRIMARY KEY REFERENCES file(id),
  sampled_hash TEXT NOT NULL,
  sha256 TEXT NOT NULL
);
CREATE INDEX content_hash_sha ON content_hash (sha256);

-- Projects created before v0.2 keep the 2-second grouping preset until the user re-runs grouping.
INSERT OR IGNORE INTO meta (key, value) VALUES ('grouping_preset', 'group-v1');

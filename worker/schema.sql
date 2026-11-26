-- Per-user synced Disk Crate state + hourly write rate-limit tracking
CREATE TABLE IF NOT EXISTS user_state (
  github_id    TEXT PRIMARY KEY,
  github_login TEXT NOT NULL,
  state_json   TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  hour_window  INTEGER NOT NULL DEFAULT 0,
  hour_writes  INTEGER NOT NULL DEFAULT 0
);

-- Global UTC daily counters for the self-pausing free-tier circuit breaker
CREATE TABLE IF NOT EXISTS daily_usage (
  utc_date    TEXT PRIMARY KEY,
  req_count   INTEGER NOT NULL DEFAULT 0,
  write_count INTEGER NOT NULL DEFAULT 0
);

-- Per-user monotonic sync sequence counter & collection hourly write rate-limit tracking
CREATE TABLE IF NOT EXISTS user_sync_state (
  github_id   TEXT PRIMARY KEY,
  next_seq    INTEGER NOT NULL DEFAULT 0,
  hour_window INTEGER NOT NULL DEFAULT 0,
  hour_writes INTEGER NOT NULL DEFAULT 0
);

-- Incremental, tombstone-aware owned release store (~1,000+ releases per user)
CREATE TABLE IF NOT EXISTS owned_releases (
  github_id         TEXT NOT NULL,
  release_id        TEXT NOT NULL,
  data_json         TEXT NOT NULL,
  client_updated_at INTEGER NOT NULL,
  deleted_at        INTEGER,
  sync_seq          INTEGER NOT NULL,
  PRIMARY KEY (github_id, release_id)
);

CREATE INDEX IF NOT EXISTS idx_owned_releases_sync
  ON owned_releases (github_id, sync_seq);

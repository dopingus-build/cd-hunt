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

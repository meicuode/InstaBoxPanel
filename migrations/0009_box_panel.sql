CREATE TABLE IF NOT EXISTS insb_box_account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  label TEXT NOT NULL DEFAULT '',
  key_ciphertext TEXT NOT NULL,
  key_iv TEXT NOT NULL,
  key_suffix TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS insb_box_keepalive (
  box_id TEXT PRIMARY KEY,
  box_name TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'off',
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  windows_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  last_checked_at INTEGER,
  last_state TEXT NOT NULL DEFAULT '',
  last_result TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS insb_box_keepalive_mode ON insb_box_keepalive(mode);

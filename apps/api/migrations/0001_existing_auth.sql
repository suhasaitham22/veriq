-- Bootstrap fresh environments without changing existing account/receipt data.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  salt TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  ip TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (ip, day)
);
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), input_hash TEXT,
  input_text TEXT, receipts_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

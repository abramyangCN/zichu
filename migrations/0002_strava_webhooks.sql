CREATE TABLE IF NOT EXISTS webhook_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  subscription_id INTEGER,
  callback_token TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  last_event_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_key TEXT PRIMARY KEY,
  subscription_id INTEGER NOT NULL,
  object_type TEXT NOT NULL,
  object_id INTEGER NOT NULL,
  aspect_type TEXT NOT NULL,
  event_time INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_created_at
ON webhook_events(created_at DESC);

-- OWNER: platform. Anonymous interaction history (public demo only). Applied with:
--   wrangler d1 migrations apply auradash-events --remote --env demo
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  session TEXT,
  type TEXT NOT NULL,
  dataset TEXT,
  question TEXT,
  data TEXT, -- JSON
  source TEXT,
  model TEXT,
  latency_ms INTEGER,
  country TEXT,
  colo TEXT
);

CREATE INDEX idx_events_ts ON events (ts);
CREATE INDEX idx_events_type ON events (type);
CREATE INDEX idx_events_dataset ON events (dataset);

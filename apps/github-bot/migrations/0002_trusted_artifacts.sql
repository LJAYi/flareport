CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  template TEXT NOT NULL,
  version TEXT NOT NULL,
  upstream_commit TEXT NOT NULL CHECK (length(upstream_commit) = 40),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  artifact_json TEXT NOT NULL CHECK (json_valid(artifact_json)),
  created_at TEXT NOT NULL,
  UNIQUE (template, version, upstream_commit, content_hash)
);

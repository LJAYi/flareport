CREATE TABLE IF NOT EXISTS dispatches (
  repository_key TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  head_sha TEXT NOT NULL CHECK (length(head_sha) = 40),
  pull_request_number INTEGER NOT NULL,
  pull_request_node_id TEXT NOT NULL,
  pull_request_url TEXT NOT NULL,
  dispatch_json TEXT NOT NULL CHECK (json_valid(dispatch_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (repository_key, artifact_id),
  FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id)
);

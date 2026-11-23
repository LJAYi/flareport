ALTER TABLE repositories ADD COLUMN deployment_check TEXT;
ALTER TABLE rollouts ADD COLUMN evidence_revision INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS dispatches_pr_idx ON dispatches(repository_key, pull_request_number);

CREATE TABLE IF NOT EXISTS verified_deployments (
  repository_key TEXT NOT NULL,
  check_run_id INTEGER NOT NULL,
  template TEXT NOT NULL,
  version TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  observation_json TEXT NOT NULL CHECK (json_valid(observation_json)),
  PRIMARY KEY (repository_key, check_run_id),
  FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id)
);
CREATE INDEX IF NOT EXISTS verified_deployments_rollout_idx ON verified_deployments(template, version);

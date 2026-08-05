CREATE TABLE IF NOT EXISTS installations (
  installation_id INTEGER PRIMARY KEY,
  account TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repositories (
  owner_key TEXT NOT NULL,
  repo_key TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  template TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('manual', 'auto', 'staged-auto')),
  channel TEXT NOT NULL CHECK (channel IN ('canary', 'early', 'stable')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_key, repo_key),
  FOREIGN KEY (installation_id) REFERENCES installations(installation_id)
);

CREATE INDEX IF NOT EXISTS repositories_template_idx ON repositories(template);

CREATE TABLE IF NOT EXISTS rollouts (
  template TEXT NOT NULL,
  version TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (template, version)
);

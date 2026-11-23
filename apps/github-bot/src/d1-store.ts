import type { StateStore } from "./store.ts";
import type { DispatchRecord, InstallationRecord, RepositoryRegistration, RolloutState, TrustedArtifact, VerifiedDeployment } from "./types.ts";

export interface D1Result<T = Record<string, unknown>> {
  results?: T[];
  success: boolean;
  meta?: { changes?: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch?(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

interface InstallationRow {
  installation_id: number;
  account: string;
  active: number;
  updated_at: string;
}

interface RepositoryRow {
  installation_id: number;
  owner: string;
  repo: string;
  template: string;
  mode: RepositoryRegistration["mode"];
  channel: RepositoryRegistration["channel"];
  enabled: number;
  deployment_check: string | null;
  created_at: string;
  updated_at: string;
}

interface RolloutRow { state_json: string; evidence_revision: number }
interface ArtifactRow { artifact_json: string }
interface DispatchRow { dispatch_json: string }

export class D1StateStore implements StateStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async putInstallation(record: InstallationRecord): Promise<void> {
    await this.db.prepare(`INSERT INTO installations (installation_id, account, active, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(installation_id) DO UPDATE SET account=excluded.account, active=excluded.active, updated_at=excluded.updated_at`)
      .bind(record.installationId, record.account, record.active ? 1 : 0, record.updatedAt).run();
  }

  async getInstallation(id: number): Promise<InstallationRecord | undefined> {
    const row = await this.db.prepare("SELECT installation_id, account, active, updated_at FROM installations WHERE installation_id = ?")
      .bind(id).first<InstallationRow>();
    return row ? { installationId: row.installation_id, account: row.account, active: Boolean(row.active), updatedAt: row.updated_at } : undefined;
  }

  async putRepository(record: RepositoryRegistration): Promise<void> {
    await this.db.prepare(`INSERT INTO repositories
      (owner_key, repo_key, installation_id, owner, repo, template, mode, channel, enabled, created_at, updated_at, deployment_check)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_key, repo_key) DO UPDATE SET installation_id=excluded.installation_id,
      owner=excluded.owner, repo=excluded.repo, template=excluded.template, mode=excluded.mode,
      channel=excluded.channel, enabled=excluded.enabled, updated_at=excluded.updated_at, deployment_check=excluded.deployment_check`)
      .bind(record.owner.toLowerCase(), record.repo.toLowerCase(), record.installationId, record.owner, record.repo,
        record.template, record.mode, record.channel, record.enabled ? 1 : 0, record.createdAt, record.updatedAt, record.deploymentCheck ?? null).run();
  }

  async getRepository(owner: string, repo: string): Promise<RepositoryRegistration | undefined> {
    const row = await this.db.prepare(`SELECT installation_id, owner, repo, template, mode, channel, enabled, created_at, updated_at, deployment_check
      FROM repositories WHERE owner_key = ? AND repo_key = ?`)
      .bind(owner.toLowerCase(), repo.toLowerCase()).first<RepositoryRow>();
    return row ? repositoryFromRow(row) : undefined;
  }

  async listRepositories(template?: string): Promise<RepositoryRegistration[]> {
    const statement = template
      ? this.db.prepare(`SELECT installation_id, owner, repo, template, mode, channel, enabled, created_at, updated_at, deployment_check
          FROM repositories WHERE template = ? ORDER BY owner_key, repo_key`).bind(template)
      : this.db.prepare(`SELECT installation_id, owner, repo, template, mode, channel, enabled, created_at, updated_at, deployment_check
          FROM repositories ORDER BY owner_key, repo_key`);
    const result = await statement.all<RepositoryRow>();
    return (result.results ?? []).map(repositoryFromRow);
  }

  async putRollout(rollout: RolloutState, onlyIfAbsent = false): Promise<void> {
    await this.db.prepare(`INSERT INTO rollouts (template, version, state_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(template, version) ${onlyIfAbsent ? "DO NOTHING" : "DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at"}`)
      .bind(rollout.template, rollout.version, rolloutJson(rollout), new Date().toISOString()).run();
  }

  async getRollout(template: string, version: string): Promise<RolloutState | undefined> {
    const row = await this.db.prepare("SELECT state_json, evidence_revision FROM rollouts WHERE template = ? AND version = ?")
      .bind(template, version).first<RolloutRow>();
    return row ? rolloutFromRow(row) : undefined;
  }

  async putArtifact(artifact: TrustedArtifact): Promise<void> {
    await this.db.prepare(`INSERT INTO artifacts (artifact_id, template, version, upstream_commit, content_hash, artifact_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(artifact.id, artifact.template, artifact.version, artifact.upstreamCommit, artifact.contentHash,
        JSON.stringify(artifact), artifact.createdAt).run();
  }

  async getArtifact(id: string): Promise<TrustedArtifact | undefined> {
    const row = await this.db.prepare("SELECT artifact_json FROM artifacts WHERE artifact_id = ?")
      .bind(id).first<ArtifactRow>();
    return row ? JSON.parse(row.artifact_json) as TrustedArtifact : undefined;
  }

  async putDispatch(record: DispatchRecord): Promise<void> {
    await this.db.prepare(`INSERT INTO dispatches
      (repository_key, artifact_id, branch, head_sha, pull_request_number, pull_request_node_id, pull_request_url, dispatch_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(record.repositoryKey.toLowerCase(), record.artifactId, record.branch, record.headSha,
        record.pullRequestNumber, record.pullRequestNodeId, record.pullRequestUrl, JSON.stringify(record), record.createdAt).run();
  }

  async getDispatch(repositoryKey: string, artifactId: string): Promise<DispatchRecord | undefined> {
    const row = await this.db.prepare("SELECT dispatch_json FROM dispatches WHERE repository_key = ? AND artifact_id = ?")
      .bind(repositoryKey.toLowerCase(), artifactId).first<DispatchRow>();
    return row ? JSON.parse(row.dispatch_json) as DispatchRecord : undefined;
  }

  async getDispatchByPull(key: string, number: number): Promise<DispatchRecord | undefined> {
    const row = await this.db.prepare("SELECT dispatch_json FROM dispatches WHERE repository_key = ? AND pull_request_number = ?")
      .bind(key.toLowerCase(), number).first<DispatchRow>();
    return row ? JSON.parse(row.dispatch_json) as DispatchRecord : undefined;
  }

  async listDispatches(key: string): Promise<DispatchRecord[]> {
    // ponytail: reconcile the latest 50 updates per repository; paginate before fleet-scale history.
    const result = await this.db.prepare("SELECT dispatch_json FROM dispatches WHERE repository_key = ? ORDER BY created_at DESC LIMIT 50")
      .bind(key.toLowerCase()).all<DispatchRow>();
    return (result.results ?? []).map(row => JSON.parse(row.dispatch_json) as DispatchRecord);
  }

  async listRollouts(): Promise<RolloutState[]> {
    const result = await this.db.prepare("SELECT state_json, evidence_revision FROM rollouts ORDER BY updated_at DESC LIMIT 101").all<RolloutRow>();
    if ((result.results?.length ?? 0) > 100) throw new Error("Rollout reconciliation requires pagination above 100 releases");
    return (result.results ?? []).map(rolloutFromRow);
  }

  async compareAndSetRollout(previous: RolloutState, next: RolloutState): Promise<boolean> {
    const result = await this.db.prepare("UPDATE rollouts SET state_json = ?, updated_at = ? WHERE template = ? AND version = ? AND state_json = ? AND evidence_revision = ?")
      .bind(rolloutJson(next), new Date().toISOString(), previous.template, previous.version, rolloutJson(previous), previous.evidenceRevision ?? 0).run();
    return result.meta?.changes === 1;
  }

  async putVerifiedDeployment(template: string, observation: VerifiedDeployment): Promise<void> {
    if (!this.db.batch) throw new Error("Verified observations require atomic D1 batches");
    const insert = this.db.prepare(`INSERT INTO verified_deployments
      (repository_key, check_run_id, template, version, artifact_id, completed_at, observation_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repository_key, check_run_id) DO UPDATE SET completed_at=excluded.completed_at, observation_json=excluded.observation_json
      WHERE excluded.completed_at > verified_deployments.completed_at`)
      .bind(observation.repositoryKey.toLowerCase(), observation.checkRunId, template, observation.version,
        observation.artifactId, observation.occurredAt, JSON.stringify(observation));
    const invalidate = this.db.prepare("UPDATE rollouts SET evidence_revision = evidence_revision + 1 WHERE template = ? AND version = ?")
      .bind(template, observation.version);
    await this.db.batch([insert, invalidate]);
  }

  async listVerifiedDeployments(template: string, version: string): Promise<VerifiedDeployment[]> {
    const result = await this.db.prepare("SELECT observation_json FROM verified_deployments WHERE template = ? AND version = ? LIMIT 1001")
      .bind(template, version).all<{ observation_json: string }>();
    if ((result.results?.length ?? 0) > 1000) throw new Error("Observation retention requires pagination above 1000 check runs");
    return (result.results ?? []).map(row => JSON.parse(row.observation_json) as VerifiedDeployment);
  }
}

function rolloutJson(state: RolloutState): string {
  const { evidenceRevision: _revision, ...persisted } = state;
  return JSON.stringify(persisted);
}

function rolloutFromRow(row: RolloutRow): RolloutState {
  return { ...JSON.parse(row.state_json), evidenceRevision: row.evidence_revision } as RolloutState;
}

function repositoryFromRow(row: RepositoryRow): RepositoryRegistration {
  return {
    installationId: row.installation_id,
    owner: row.owner,
    repo: row.repo,
    template: row.template,
    mode: row.mode,
    channel: row.channel,
    enabled: Boolean(row.enabled),
    ...(row.deployment_check ? { deploymentCheck: row.deployment_check } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

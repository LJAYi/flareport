import type { StateStore } from "./store.ts";
import type { DispatchRecord, InstallationRecord, RepositoryRegistration, RolloutState, TrustedArtifact } from "./types.ts";

export interface D1Result<T = Record<string, unknown>> {
  results?: T[];
  success: boolean;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
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
  created_at: string;
  updated_at: string;
}

interface RolloutRow { state_json: string }
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
      (owner_key, repo_key, installation_id, owner, repo, template, mode, channel, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_key, repo_key) DO UPDATE SET installation_id=excluded.installation_id,
      owner=excluded.owner, repo=excluded.repo, template=excluded.template, mode=excluded.mode,
      channel=excluded.channel, enabled=excluded.enabled, updated_at=excluded.updated_at`)
      .bind(record.owner.toLowerCase(), record.repo.toLowerCase(), record.installationId, record.owner, record.repo,
        record.template, record.mode, record.channel, record.enabled ? 1 : 0, record.createdAt, record.updatedAt).run();
  }

  async getRepository(owner: string, repo: string): Promise<RepositoryRegistration | undefined> {
    const row = await this.db.prepare(`SELECT installation_id, owner, repo, template, mode, channel, enabled, created_at, updated_at
      FROM repositories WHERE owner_key = ? AND repo_key = ?`)
      .bind(owner.toLowerCase(), repo.toLowerCase()).first<RepositoryRow>();
    return row ? repositoryFromRow(row) : undefined;
  }

  async listRepositories(template?: string): Promise<RepositoryRegistration[]> {
    const statement = template
      ? this.db.prepare(`SELECT installation_id, owner, repo, template, mode, channel, enabled, created_at, updated_at
          FROM repositories WHERE template = ? ORDER BY owner_key, repo_key`).bind(template)
      : this.db.prepare(`SELECT installation_id, owner, repo, template, mode, channel, enabled, created_at, updated_at
          FROM repositories ORDER BY owner_key, repo_key`);
    const result = await statement.all<RepositoryRow>();
    return (result.results ?? []).map(repositoryFromRow);
  }

  async putRollout(rollout: RolloutState): Promise<void> {
    await this.db.prepare(`INSERT INTO rollouts (template, version, state_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(template, version) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at`)
      .bind(rollout.template, rollout.version, JSON.stringify(rollout), new Date().toISOString()).run();
  }

  async getRollout(template: string, version: string): Promise<RolloutState | undefined> {
    const row = await this.db.prepare("SELECT state_json FROM rollouts WHERE template = ? AND version = ?")
      .bind(template, version).first<RolloutRow>();
    return row ? JSON.parse(row.state_json) as RolloutState : undefined;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

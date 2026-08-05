import type { DispatchRecord, InstallationRecord, RepositoryRegistration, RolloutState, TrustedArtifact } from "./types.ts";

export interface StateStore {
  putInstallation(record: InstallationRecord): Promise<void>;
  getInstallation(id: number): Promise<InstallationRecord | undefined>;
  putRepository(record: RepositoryRegistration): Promise<void>;
  getRepository(owner: string, repo: string): Promise<RepositoryRegistration | undefined>;
  listRepositories(template?: string): Promise<RepositoryRegistration[]>;
  putRollout(rollout: RolloutState): Promise<void>;
  getRollout(template: string, version: string): Promise<RolloutState | undefined>;
  putArtifact(artifact: TrustedArtifact): Promise<void>;
  getArtifact(id: string): Promise<TrustedArtifact | undefined>;
  putDispatch(record: DispatchRecord): Promise<void>;
  getDispatch(repositoryKey: string, artifactId: string): Promise<DispatchRecord | undefined>;
}

const repositoryKey = (owner: string, repo: string) => `${owner.toLowerCase()}/${repo.toLowerCase()}`;
const rolloutKey = (template: string, version: string) => `${template}@${version}`;

export class MemoryStateStore implements StateStore {
  readonly installations = new Map<number, InstallationRecord>();
  readonly repositories = new Map<string, RepositoryRegistration>();
  readonly rollouts = new Map<string, RolloutState>();
  readonly artifacts = new Map<string, TrustedArtifact>();
  readonly dispatches = new Map<string, DispatchRecord>();

  async putInstallation(record: InstallationRecord): Promise<void> {
    this.installations.set(record.installationId, structuredClone(record));
  }

  async getInstallation(id: number): Promise<InstallationRecord | undefined> {
    const value = this.installations.get(id);
    return value && structuredClone(value);
  }

  async putRepository(record: RepositoryRegistration): Promise<void> {
    this.repositories.set(repositoryKey(record.owner, record.repo), structuredClone(record));
  }

  async getRepository(owner: string, repo: string): Promise<RepositoryRegistration | undefined> {
    const value = this.repositories.get(repositoryKey(owner, repo));
    return value && structuredClone(value);
  }

  async listRepositories(template?: string): Promise<RepositoryRegistration[]> {
    return [...this.repositories.values()]
      .filter((repository) => !template || repository.template === template)
      .map((repository) => structuredClone(repository));
  }

  async putRollout(rollout: RolloutState): Promise<void> {
    this.rollouts.set(rolloutKey(rollout.template, rollout.version), structuredClone(rollout));
  }

  async getRollout(template: string, version: string): Promise<RolloutState | undefined> {
    const value = this.rollouts.get(rolloutKey(template, version));
    return value && structuredClone(value);
  }

  async putArtifact(artifact: TrustedArtifact): Promise<void> {
    this.artifacts.set(artifact.id, structuredClone(artifact));
  }

  async getArtifact(id: string): Promise<TrustedArtifact | undefined> {
    const value = this.artifacts.get(id);
    return value && structuredClone(value);
  }

  async putDispatch(record: DispatchRecord): Promise<void> {
    this.dispatches.set(`${record.repositoryKey.toLowerCase()}@${record.artifactId}`, structuredClone(record));
  }

  async getDispatch(repositoryKey: string, artifactId: string): Promise<DispatchRecord | undefined> {
    const value = this.dispatches.get(`${repositoryKey.toLowerCase()}@${artifactId}`);
    return value && structuredClone(value);
  }
}

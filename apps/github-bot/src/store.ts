import type { DispatchRecord, InstallationRecord, RepositoryRegistration, RolloutState, TrustedArtifact, VerifiedDeployment } from "./types.ts";

export interface StateStore {
  putInstallation(record: InstallationRecord): Promise<void>;
  getInstallation(id: number): Promise<InstallationRecord | undefined>;
  putRepository(record: RepositoryRegistration): Promise<void>;
  getRepository(owner: string, repo: string): Promise<RepositoryRegistration | undefined>;
  listRepositories(template?: string): Promise<RepositoryRegistration[]>;
  putRollout(rollout: RolloutState, onlyIfAbsent?: boolean): Promise<void>;
  getRollout(template: string, version: string): Promise<RolloutState | undefined>;
  putArtifact(artifact: TrustedArtifact): Promise<void>;
  getArtifact(id: string): Promise<TrustedArtifact | undefined>;
  putDispatch(record: DispatchRecord): Promise<void>;
  getDispatch(repositoryKey: string, artifactId: string): Promise<DispatchRecord | undefined>;
  getDispatchByPull(repositoryKey: string, pullNumber: number): Promise<DispatchRecord | undefined>;
  listDispatches(repositoryKey: string): Promise<DispatchRecord[]>;
  listRollouts(): Promise<RolloutState[]>;
  compareAndSetRollout(previous: RolloutState, next: RolloutState): Promise<boolean>;
  putVerifiedDeployment(template: string, observation: VerifiedDeployment): Promise<void>;
  listVerifiedDeployments(template: string, version: string): Promise<VerifiedDeployment[]>;
}

const repositoryKey = (owner: string, repo: string) => `${owner.toLowerCase()}/${repo.toLowerCase()}`;
const rolloutKey = (template: string, version: string) => `${template}@${version}`;

export class MemoryStateStore implements StateStore {
  readonly installations = new Map<number, InstallationRecord>();
  readonly repositories = new Map<string, RepositoryRegistration>();
  readonly rollouts = new Map<string, RolloutState>();
  readonly artifacts = new Map<string, TrustedArtifact>();
  readonly dispatches = new Map<string, DispatchRecord>();
  readonly verifiedDeployments = new Map<string, { template: string; observation: VerifiedDeployment }>();

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

  async putRollout(rollout: RolloutState, onlyIfAbsent = false): Promise<void> {
    if (onlyIfAbsent && this.rollouts.has(rolloutKey(rollout.template, rollout.version))) return;
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

  async listDispatches(key: string): Promise<DispatchRecord[]> {
    return [...this.dispatches.values()].filter(record => record.repositoryKey.toLowerCase() === key.toLowerCase())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50).map(record => structuredClone(record));
  }

  async getDispatchByPull(key: string, number: number): Promise<DispatchRecord | undefined> {
    return (await this.listDispatches(key)).find(record => record.pullRequestNumber === number);
  }

  async listRollouts(): Promise<RolloutState[]> {
    return [...this.rollouts.values()].map(state => structuredClone(state));
  }

  async compareAndSetRollout(previous: RolloutState, next: RolloutState): Promise<boolean> {
    const key = rolloutKey(previous.template, previous.version);
    if (JSON.stringify(this.rollouts.get(key)) !== JSON.stringify(previous)) return false;
    this.rollouts.set(key, structuredClone(next));
    return true;
  }

  async putVerifiedDeployment(template: string, observation: VerifiedDeployment): Promise<void> {
    const key = `${observation.repositoryKey.toLowerCase()}@${observation.checkRunId}`;
    const previous = this.verifiedDeployments.get(key)?.observation;
    if (!previous || Date.parse(observation.occurredAt) > Date.parse(previous.occurredAt)) {
      this.verifiedDeployments.set(key, { template, observation: structuredClone(observation) });
    }
    const state = this.rollouts.get(rolloutKey(template, observation.version));
    if (state) state.evidenceRevision = (state.evidenceRevision ?? 0) + 1;
  }

  async listVerifiedDeployments(template: string, version: string): Promise<VerifiedDeployment[]> {
    return [...this.verifiedDeployments.values()].filter(value => value.template === template && value.observation.version === version)
      .map(value => structuredClone(value.observation));
  }
}

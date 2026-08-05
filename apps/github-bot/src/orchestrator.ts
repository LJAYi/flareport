import type { GitHubClient, UpdateFile } from "./github.ts";
import { updateDecision } from "./rollout.ts";
import type { StateStore } from "./store.ts";
import type { RepositoryRegistration, RolloutState } from "./types.ts";

export interface UpdateArtifact {
  artifactId: string;
  template: string;
  version: string;
  baseBranch: string;
  files: UpdateFile[];
  releaseNotes: string;
}

export interface GitHubClientFactory {
  forInstallation(installationId: number): Promise<GitHubClient>;
}

export interface DispatchResult {
  repository: string;
  outcome: "skipped" | "pull-request-created";
  reason: string;
  pullRequestUrl?: string;
}

export class UpdateOrchestrator {
  private readonly store: StateStore;
  private readonly clients: GitHubClientFactory;

  constructor(store: StateStore, clients: GitHubClientFactory) {
    this.store = store;
    this.clients = clients;
  }

  async dispatch(artifact: UpdateArtifact): Promise<DispatchResult[]> {
    const rollout = await this.store.getRollout(artifact.template, artifact.version);
    if (!rollout) throw new Error(`Missing rollout ${artifact.template}@${artifact.version}`);
    const repositories = await this.store.listRepositories(artifact.template);
    const results: DispatchResult[] = [];

    for (const repository of repositories) {
      results.push(await this.dispatchRepository(repository, rollout, artifact));
    }
    return results;
  }

  async dispatchRepository(
    repository: RepositoryRegistration,
    rollout: RolloutState,
    artifact: UpdateArtifact,
  ): Promise<DispatchResult> {
    if (repository.template !== artifact.template || rollout.template !== artifact.template || rollout.version !== artifact.version) {
      throw new Error("Repository, rollout, and artifact do not describe the same update");
    }
    const repositoryName = `${repository.owner}/${repository.repo}`;
    if (rollout.artifactId !== artifact.artifactId) throw new Error("Rollout and artifact ID do not match");
    const existing = await this.store.getDispatch(repositoryName, artifact.artifactId);
    if (existing) {
      return {
        repository: repositoryName,
        outcome: "pull-request-created",
        reason: "already-dispatched",
        pullRequestUrl: existing.pullRequestUrl,
      };
    }
    const decision = updateDecision(repository, rollout);
    if (!decision.createPullRequest) {
      return { repository: repositoryName, outcome: "skipped", reason: decision.reason };
    }
    const client = await this.clients.forInstallation(repository.installationId);
    const branch = updateBranch(artifact.template, artifact.version);
    const pull = await client.createUpdatePullRequest({
      owner: repository.owner,
      repo: repository.repo,
      base: artifact.baseBranch,
      branch,
      title: `flareport: update ${artifact.template} to ${artifact.version}`,
      body: artifact.releaseNotes,
      files: artifact.files,
    });
    await this.store.putDispatch({
      repositoryKey: repositoryName,
      artifactId: artifact.artifactId,
      branch,
      headSha: pull.headSha,
      pullRequestNumber: pull.number,
      pullRequestNodeId: pull.node_id,
      pullRequestUrl: pull.html_url,
      createdAt: new Date().toISOString(),
    });
    return {
      repository: repositoryName,
      outcome: "pull-request-created",
      reason: decision.reason,
      pullRequestUrl: pull.html_url,
    };
  }
}

export function updateBranch(template: string, version: string): string {
  const safe = `${template}-${version}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `flareport/update-${safe}`;
}

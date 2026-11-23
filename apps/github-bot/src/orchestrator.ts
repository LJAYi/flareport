import type { GitHubClient, UpdateFile } from "./github.ts";
import { updateDecision } from "./rollout.ts";
import type { StateStore } from "./store.ts";
import type { RepositoryRegistration, RolloutState } from "./types.ts";
import { latestAutomaticReleases, versionFilesForRepository } from "./release.ts";

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

  async dispatchReleases(): Promise<DispatchResult[]> {
    const repositories = await this.store.listRepositories();
    if (repositories.length > 100) throw new Error("Automatic dispatch requires pagination above 100 repositories");
    const results: DispatchResult[] = [];
    for (const repository of repositories) {
      try {
        const rollout = latestAutomaticReleases(await this.store.listRollouts()).get(repository.template);
        if (!rollout || rollout.phase === "paused") continue;
        const artifact = await this.store.getArtifact(rollout.artifactId);
        if (!artifact) throw new Error("Published release artifact is missing");
        results.push(await this.dispatchRepository(repository, rollout, { ...artifact, artifactId: artifact.id }));
      } catch (error) {
        // Failure in one repository must not prevent the remaining repositories from progressing.
        results.push({ repository: `${repository.owner}/${repository.repo}`, outcome: "skipped", reason: (error as Error).message });
      }
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
    const skipped = (reason: string): DispatchResult => ({ repository: repositoryName, outcome: "skipped", reason });
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
    const current = await this.store.getRepository(repository.owner, repository.repo);
    if (!current?.enabled || current.installationId !== repository.installationId || current.template !== artifact.template
      || !(await this.store.getInstallation(current.installationId))?.active) return skipped("repository-or-installation-inactive");
    const client = await this.clients.forInstallation(repository.installationId);
    let files = artifact.files;
    let expectedBaseSha: string | undefined;
    if (rollout.automaticDispatch) {
      const trusted = await this.store.getArtifact(artifact.artifactId);
      if (!trusted || trusted.upstreamCommit !== rollout.upstreamCommit) throw new Error("Release artifact mismatch");
      const settings = await client.getRepository(repository.owner, repository.repo);
      if (settings.default_branch !== artifact.baseBranch) return skipped("default-branch-mismatch");
      expectedBaseSha = (await client.getBranch(repository.owner, repository.repo, artifact.baseBranch)).commit.sha;
      const metadata = await client.readJsonFile(repository.owner, repository.repo, "flareport.json", expectedBaseSha);
      const pkg = await client.readJsonFile(repository.owner, repository.repo, "package.json", expectedBaseSha);
      const prepared = versionFilesForRepository(trusted, metadata, pkg);
      if (!prepared) return skipped("already-current-or-ahead");
      files = prepared;
    }
    const fresh = await this.store.getRepository(repository.owner, repository.repo);
    const state = await this.store.getRollout(rollout.template, rollout.version);
    if (!fresh || fresh.installationId !== current.installationId || fresh.template !== artifact.template
      || !(await this.store.getInstallation(fresh.installationId))?.active
      || !state || state.artifactId !== artifact.artifactId || state.evidenceRevision !== rollout.evidenceRevision
      || state.phase === "paused" || !updateDecision(fresh, state).createPullRequest) return skipped("dispatch-policy-changed");
    if (state.automaticDispatch && latestAutomaticReleases(await this.store.listRollouts()).get(state.template)?.artifactId !== artifact.artifactId) {
      return skipped("superseded-release");
    }
    const branch = updateBranch(artifact.template, artifact.version);
    const pull = await client.createUpdatePullRequest({
      owner: repository.owner,
      repo: repository.repo,
      base: artifact.baseBranch,
      branch,
      title: `flareport: update ${artifact.template} to ${artifact.version}`,
      body: artifact.releaseNotes,
      files,
      ...(expectedBaseSha ? { expectedBaseSha } : {}),
    });
    await client.publishArtifactCheck(repository.owner, repository.repo, pull.headSha, artifact.artifactId);
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

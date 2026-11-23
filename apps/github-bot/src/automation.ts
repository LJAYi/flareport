import type { CheckRun, GitHubClient, UpdatePull } from "./github.ts";
import type { GitHubClientFactory } from "./orchestrator.ts";
import { evaluateRollout, isRepositoryInCurrentPhase, updateDecision } from "./rollout.ts";
import type { StateStore } from "./store.ts";
import type { DispatchRecord, RepositoryRegistration, RolloutState, VerifiedDeployment } from "./types.ts";
import { latestAutomaticReleases } from "./release.ts";

export const GITHUB_ACTIONS_APP_ID = 15368;
export const CLOUDFLARE_APP_ID = 85455;
export const VALIDATION_CHECK = "Validate deployment";
const shaPattern = /^[a-f0-9]{40}$/;
const key = (repo: RepositoryRegistration) => `${repo.owner}/${repo.repo}`.toLowerCase();

export interface CompletedCheckEvent {
  action?: string;
  installation?: { id?: number };
  repository?: { name?: string; owner?: { login?: string } };
  check_run?: { id?: number };
}

function matchesPull(repo: RepositoryRegistration, record: DispatchRecord, pull: UpdatePull, base: string): boolean {
  return pull.number === record.pullRequestNumber && pull.node_id === record.pullRequestNodeId
    && pull.head.sha === record.headSha && pull.head.ref === record.branch
    && pull.head.repo?.full_name.toLowerCase() === key(repo)
    && pull.base.repo.full_name.toLowerCase() === key(repo) && pull.base.ref === base;
}

function latestCheck(checks: CheckRun[], name: string, appId: number): CheckRun | undefined {
  return checks.filter(check => check.name === name && check.app.id === appId).sort((a, b) => b.id - a.id)[0];
}

function policyChecks(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const policy = value as { schemaVersion?: unknown; autoMerge?: unknown; requiredChecks?: unknown };
  if (policy.schemaVersion !== 1 || policy.autoMerge !== true || !Array.isArray(policy.requiredChecks)
    || policy.requiredChecks.length > 20 || !policy.requiredChecks.includes(VALIDATION_CHECK)
    || !policy.requiredChecks.every(name => typeof name === "string" && name.length > 0 && name.length < 200)
    || Object.keys(value).some(name => !["schemaVersion", "autoMerge", "requiredChecks"].includes(name))) return undefined;
  return [...new Set(policy.requiredChecks)] as string[];
}

/** Only verified provider records drive automatic phase transitions, never admin reports. */
export async function reconcileRollout(store: StateStore, template: string, version: string, now = new Date()): Promise<RolloutState | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await store.getRollout(template, version);
    if (!state) return undefined;
    const observations = await store.listVerifiedDeployments(template, version);
    const latest = new Map<string, VerifiedDeployment>();
    for (const observation of observations.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.checkRunId - b.checkRunId)) {
      if (observation.artifactId !== state.artifactId || observation.upstreamCommit !== state.upstreamCommit) continue;
      const [owner, repo] = observation.repositoryKey.split("/");
      if (!owner || !repo) continue;
      const registered = await store.getRepository(owner, repo);
      if (!registered?.enabled || registered.template !== template || !isRepositoryInCurrentPhase(registered, state)) continue;
      const installation = await store.getInstallation(registered.installationId);
      if (!installation?.active) continue;
      latest.set(observation.repositoryKey.toLowerCase(), observation);
    }
    const evaluated = evaluateRollout({ ...state, events: [...latest.values()] }, now);
    // Retain administrative audit entries separately from the verified gate inputs.
    const next: RolloutState = { ...evaluated, events: state.events,
      ...(evaluated.phase !== state.phase ? { phaseEvidence: "github-checks" } : {}) };
    if (JSON.stringify(next) === JSON.stringify(state)) return state;
    if (await store.compareAndSetRollout(state, next)) return next;
  }
  throw new Error("Concurrent rollout update; reconciliation must retry");
}

export class UpdateAutomation {
  private readonly store: StateStore;
  private readonly clients: GitHubClientFactory;
  private readonly appId: number;

  constructor(store: StateStore, clients: GitHubClientFactory, appId: number) {
    this.store = store;
    this.clients = clients;
    this.appId = appId;
  }

  async handleCompletedCheck(event: CompletedCheckEvent): Promise<void> {
    if (event.action !== "completed") return;
    const owner = event.repository?.owner?.login;
    const repo = event.repository?.name;
    const checkId = event.check_run?.id;
    if (typeof owner !== "string" || typeof repo !== "string" || !Number.isSafeInteger(checkId) || Number(checkId) <= 0) return;
    const registration = await this.store.getRepository(owner, repo);
    if (!registration || registration.installationId !== event.installation?.id || !(await this.active(registration))) return;
    const client = await this.clients.forInstallation(registration.installationId);
    // A signed webhook is a notification, not proof: re-read the authoritative Check.
    const check = await client.getCheck(owner, repo, checkId!);
    if (check.id !== checkId || check.status !== "completed" || !shaPattern.test(check.head_sha)) return;
    const pulls = await client.pullsForCommit(owner, repo, check.head_sha);
    for (const candidate of pulls) {
      const record = await this.store.getDispatchByPull(key(registration), candidate.number);
      if (!record) continue;
      const pull = await client.getPull(owner, repo, record.pullRequestNumber);
      if (pull.merged) await this.observeDeployment(registration, record, pull, check, client);
      else await this.maybeMerge(registration, record, client);
    }
  }

  async reconcile(): Promise<void> {
    const repositories = await this.store.listRepositories();
    if (repositories.length > 100) throw new Error("Reconciliation requires pagination above 100 repositories");
    for (const repository of repositories) {
      if (!(await this.active(repository))) continue;
      try {
        // ponytail: poll only the latest tracked update; older deliveries still use the webhook path.
        const record = (await this.store.listDispatches(key(repository)))[0];
        if (!record) continue;
        const client = await this.clients.forInstallation(repository.installationId);
        const pull = await client.getPull(repository.owner, repository.repo, record.pullRequestNumber);
        if (pull.merged && pull.merge_commit_sha && shaPattern.test(pull.merge_commit_sha)) {
          const checks = await client.checksForCommit(repository.owner, repository.repo, pull.merge_commit_sha);
          for (const check of checks) await this.observeDeployment(repository, record, pull, check, client);
        } else await this.maybeMerge(repository, record, client);
      } catch (error) {
        console.error(`FlarePort reconciliation failed for ${key(repository)}: ${(error as Error).message}`);
      }
    }
    for (const state of await this.store.listRollouts()) await reconcileRollout(this.store, state.template, state.version);
  }

  async maybeMerge(repository: RepositoryRegistration, record: DispatchRecord, client: GitHubClient): Promise<string> {
    const current = await this.store.getRepository(repository.owner, repository.repo);
    if (!current || !(await this.active(current)) || current.mode === "manual") return "manual-or-disabled";
    const artifact = await this.store.getArtifact(record.artifactId);
    if (!artifact || artifact.template !== current.template) return "artifact-mismatch";
    const state = await reconcileRollout(this.store, artifact.template, artifact.version);
    if (!state || state.artifactId !== artifact.id || state.upstreamCommit !== artifact.upstreamCommit
      || state.phase === "paused" || !updateDecision(current, state).createPullRequest) return "rollout-gate-closed";
    if ((await this.store.listDispatches(key(current)))[0]?.artifactId !== artifact.id) return "superseded-update";
    const pull = await client.getPull(current.owner, current.repo, record.pullRequestNumber);
    if (!matchesPull(current, record, pull, artifact.baseBranch) || pull.state !== "open" || pull.draft || pull.merged) return "pull-mismatch";
    const repo = await client.getRepository(current.owner, current.repo);
    if (repo.allow_auto_merge !== true || repo.default_branch !== artifact.baseBranch) return "repository-opt-in-required";
    const branch = await client.getBranch(current.owner, current.repo, artifact.baseBranch);
    const checksRequired = branch.protection?.required_status_checks?.checks;
    if (!branch.protected || branch.commit.sha !== pull.base.sha || !checksRequired?.length
      || !checksRequired.some(check => check.context === VALIDATION_CHECK && check.app_id === GITHUB_ACTIONS_APP_ID)
      || checksRequired.some(check => !Number.isSafeInteger(check.app_id) || Number(check.app_id) <= 0)) return "required-check-protection-missing";
    const requested = policyChecks(await client.readJsonFile(current.owner, current.repo, "flareport.user.json", branch.commit.sha));
    if (!requested || requested.some(name => !checksRequired.some(check => check.context === name))) return "local-opt-in-required";
    for (const sha of [branch.commit.sha, record.headSha]) {
      const metadata = await client.readJsonFile(current.owner, current.repo, "flareport.json", sha) as { adapter?: { id?: string }; management?: { autoMergeAllowed?: boolean } } | undefined;
      if (metadata?.adapter?.id !== current.template || metadata.management?.autoMergeAllowed !== true) return "template-disallows-auto-merge";
    }
    const checks = await client.checksForCommit(current.owner, current.repo, record.headSha);
    const integrity = latestCheck(checks, "FlarePort artifact integrity", this.appId);
    if (integrity?.head_sha !== record.headSha || integrity.status !== "completed" || integrity.conclusion !== "success"
      || integrity.external_id !== artifact.id) return "artifact-integrity-missing";
    for (const required of checksRequired) {
      const check = latestCheck(checks, required.context, required.app_id!);
      if (check?.head_sha !== record.headSha || check.status !== "completed" || check.conclusion !== "success") return "required-checks-pending";
    }
    const fresh = await client.getPull(current.owner, current.repo, record.pullRequestNumber);
    if (!matchesPull(current, record, fresh, artifact.baseBranch) || fresh.base.sha !== branch.commit.sha
      || fresh.state !== "open" || fresh.draft || fresh.merged || fresh.mergeable_state !== "clean") return "pull-not-ready";
    // Re-read local authorization after the last GitHub lookup, not before it.
    const latestRegistration = await this.store.getRepository(current.owner, current.repo);
    const latestDispatch = (await this.store.listDispatches(key(current)))[0];
    if (!latestRegistration || !(await this.active(latestRegistration)) || latestRegistration.mode === "manual"
      || latestRegistration.template !== current.template || latestRegistration.installationId !== current.installationId
      || latestDispatch?.artifactId !== record.artifactId) return "policy-revoked";
    const latestState = await this.store.getRollout(artifact.template, artifact.version);
    if (!latestState || latestState.artifactId !== artifact.id || latestState.upstreamCommit !== artifact.upstreamCommit
      || latestState.evidenceRevision !== state.evidenceRevision
      || latestState.phase === "paused" || !updateDecision(latestRegistration, latestState).createPullRequest) return "policy-revoked";
    if (latestState.automaticDispatch && latestAutomaticReleases(await this.store.listRollouts()).get(artifact.template)?.artifactId !== artifact.id) return "superseded-release";
    return await client.mergeExactPull(current.owner, current.repo, record.pullRequestNumber, record.headSha) ? "merged" : "merge-refused";
  }

  async observeDeployment(repository: RepositoryRegistration, record: DispatchRecord, pull: UpdatePull, check: CheckRun, client: GitHubClient): Promise<boolean> {
    const current = await this.store.getRepository(repository.owner, repository.repo);
    if (!current || !(await this.active(current)) || current.installationId !== repository.installationId
      || current.deploymentCheck !== repository.deploymentCheck) return false;
    if (!repository.deploymentCheck || check.name !== repository.deploymentCheck || check.app.id !== CLOUDFLARE_APP_ID
      || check.app.slug !== "cloudflare-workers-and-pages" || check.status !== "completed" || !pull.merged
      || pull.merge_commit_sha !== check.head_sha || !shaPattern.test(check.head_sha)) return false;
    const artifact = await this.store.getArtifact(record.artifactId);
    if (!artifact || artifact.template !== repository.template || !matchesPull(repository, record, pull, artifact.baseBranch)) return false;
    const repo = await client.getRepository(repository.owner, repository.repo);
    if (repo.default_branch !== artifact.baseBranch) return false;
    const state = await this.store.getRollout(artifact.template, artifact.version);
    if (!state || state.artifactId !== artifact.id || state.upstreamCommit !== artifact.upstreamCommit) return false;
    const start = Date.parse(check.started_at);
    const completed = Date.parse(check.completed_at ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(completed) || completed < start || start < Date.parse(record.createdAt)
      || completed > Date.now() + 300_000 || !Number.isSafeInteger(check.id) || check.id <= 0) return false;
    const success = check.conclusion === "success";
    if (!success && !["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(check.conclusion ?? "")) return false;
    const versionId = check.output?.summary?.match(/Version ID:\s*([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})/i)?.[1];
    if (success && !versionId) return false;
    await this.store.putVerifiedDeployment(artifact.template, {
      repositoryKey: key(repository), artifactId: artifact.id, version: artifact.version, upstreamCommit: artifact.upstreamCommit,
      result: success ? "success" : "failure", occurredAt: new Date(completed).toISOString(), startedAt: new Date(start).toISOString(),
      checkRunId: check.id, mergeSha: check.head_sha, ...(versionId ? { versionId } : {}),
    });
    await reconcileRollout(this.store, artifact.template, artifact.version);
    return true;
  }

  private async active(repository: RepositoryRegistration): Promise<boolean> {
    return repository.enabled && (await this.store.getInstallation(repository.installationId))?.active === true;
  }
}

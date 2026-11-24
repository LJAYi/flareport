import { D1StateStore, type D1Database } from "./d1-store.ts";
import { artifactDigest, isManagedArtifactPath, type ArtifactPayload } from "./artifact.ts";
import { installationClient, type Fetcher } from "./github-auth.ts";
import type { GitHubClient } from "./github.ts";
import { UpdateOrchestrator, type GitHubClientFactory, type UpdateArtifact } from "./orchestrator.ts";
import { cohortFor, DEFAULT_ROLLOUT_CONFIG, isRepositoryInCurrentPhase, updateDecision } from "./rollout.ts";
import { reconcileRollout, UpdateAutomation } from "./automation.ts";
import { activateRelease } from "./release.ts";
import { MemoryStateStore, type StateStore } from "./store.ts";
import type { RepositoryRegistration, RolloutConfig, RolloutEvent, RolloutState, TrustedArtifact, UpdateMode } from "./types.ts";
import { handleGitHubWebhook } from "./webhook.ts";

export interface Env {
  WEBHOOK_SECRET: string;
  ADMIN_TOKEN: string;
  ARTIFACT_TOKEN?: string;
  SCHEDULER_TOKEN?: string;
  SCHEDULER_MODE?: string;
  APP_ID?: string;
  PRIVATE_KEY?: string;
  DB?: D1Database;
  AUTO_DISPATCH_ENABLED?: string;
}

const memoryStore = new MemoryStateStore();

export interface WorkerDependencies {
  fetcher?: Fetcher;
  githubClientFactory?: GitHubClientFactory;
}

export function createWorker(configuredStore?: StateStore, dependencies: WorkerDependencies = {}) {
  return {
    async scheduled(_controller: unknown, env: Env): Promise<void> {
      const mode = schedulerMode(env);
      if (!mode) throw new Error("Invalid SCHEDULER_MODE");
      if (mode !== "cloudflare") {
        console.log(JSON.stringify({ event: "scheduler-skipped", source: "cloudflare", mode }));
        return;
      }
      const store = configuredStore ?? (env.DB ? new D1StateStore(env.DB) : memoryStore);
      const clients = dependencies.githubClientFactory ?? defaultClientFactory(env, dependencies.fetcher);
      if (!clients) throw new Error("GitHub App not configured");
      if (!configuredStore && !env.DB) throw new Error("Database not configured");
      const result = await reconcile(store, clients, env);
      console.log(JSON.stringify({ event: "scheduler-reconcile", source: "cloudflare", mode, ...result }));
      if (!result.ok) throw new Error("Reconciliation completed with repository failures");
    },
    async fetch(request: Request, env: Env, context?: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
      const store = configuredStore ?? (env.DB ? new D1StateStore(env.DB) : memoryStore);
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return json({ ok: true });
      if (url.pathname === "/webhooks/github" && request.method === "POST") {
        const clients = dependencies.githubClientFactory ?? defaultClientFactory(env, dependencies.fetcher);
        const automation = clients && new UpdateAutomation(store, clients, Number(env.APP_ID));
        return handleGitHubWebhook(request, env.WEBHOOK_SECRET, store, {
          ...(automation ? { onCompletedCheck: event => automation.handleCompletedCheck(event) } : {}),
          ...(context ? { waitUntil: promise => context.waitUntil(promise) } : {}),
        });
      }
      if (url.pathname === "/api/scheduler/reconcile") {
        if (!(await isAuthorized(request, env.SCHEDULER_TOKEN ?? ""))) return json({ error: "unauthorized" }, 401);
        if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
        const mode = schedulerMode(env);
        if (!mode) return json({ error: "invalid-scheduler-mode" }, 503);
        // Routing metadata from the authenticated caller, not proof of GitHub identity.
        // The caller cannot change the server-owned mode or update policy.
        const source = request.headers.get("x-flareport-trigger");
        if (source !== "github-schedule" && source !== "manual") return json({ error: "invalid-scheduler-source" }, 400);
        if (mode === "cloudflare" || (source === "github-schedule" && mode !== "github")) {
          return json({ error: "scheduler-mode-mismatch" }, 409);
        }
        const clients = dependencies.githubClientFactory ?? defaultClientFactory(env, dependencies.fetcher);
        if (!clients) return json({ error: "github-app-not-configured" }, 503);
        if (!configuredStore && !env.DB) return json({ error: "database-not-configured" }, 503);
        try {
          // Await completion: Actions must not report success for work merely queued with waitUntil.
          const result = await reconcile(store, clients, env);
          console.log(JSON.stringify({ event: "scheduler-reconcile", source, mode, ...result }));
          return json(result, result.ok ? 200 : 502);
        } catch {
          // Never expose provider response bodies or credentials to the scheduler caller.
          return json({ error: "reconciliation-failed" }, 502);
        }
      }

      const artifactMatch = url.pathname.match(/^\/api\/artifacts\/([a-f0-9]{64})$/);
      if (artifactMatch && request.method === "PUT") {
        if (!(await isAuthorized(request, env.ARTIFACT_TOKEN ?? ""))) return json({ error: "unauthorized" }, 401);
        const id = artifactMatch[1]!;
        const input = await request.json() as Partial<ArtifactPayload> & { contentHash?: string };
        const claimedHash = input.contentHash;
        if (!isArtifactPayload(input) || claimedHash !== id) return json({ error: "invalid-artifact" }, 400);
        const computed = await artifactDigest(input);
        if (computed !== id) return json({ error: "artifact-hash-mismatch" }, 400);
        const existing = await store.getArtifact(id);
        if (existing) return json(existing);
        const artifact: TrustedArtifact = { ...input, id, contentHash: id, createdAt: new Date().toISOString() };
        await store.putArtifact(artifact);
        return json(artifact, 201);
      }
      const releaseMatch = url.pathname.match(/^\/api\/releases\/([^/]+)\/([^/]+)$/);
      if (releaseMatch && request.method === "PUT") {
        if (!(await isAuthorized(request, env.ARTIFACT_TOKEN ?? ""))) return json({ error: "unauthorized" }, 401);
        const input = await request.json() as { artifactId?: unknown };
        if (typeof input.artifactId !== "string" || !/^[a-f0-9]{64}$/.test(input.artifactId)) return json({ error: "invalid-artifact-id" }, 400);
        const artifact = await store.getArtifact(input.artifactId);
        if (!artifact || artifact.template !== releaseMatch[1] || artifact.version !== releaseMatch[2]) return json({ error: "artifact-not-found" }, 404);
        try { return json(await activateRelease(store, artifact.id)); }
        catch { return json({ error: "invalid-or-conflicting-release" }, 409); }
      }
      if (!(await isAuthorized(request, env.ADMIN_TOKEN))) return json({ error: "unauthorized" }, 401);

      const installationMatch = url.pathname.match(/^\/api\/installations\/(\d+)$/);
      if (installationMatch && request.method === "GET") {
        return jsonOrNotFound(await store.getInstallation(Number(installationMatch[1])));
      }

      const dispatchMatch = url.pathname.match(/^\/api\/repositories\/([^/]+)\/([^/]+)\/dispatch$/);
      if (dispatchMatch && request.method === "POST") {
        const owner = decodePathSegment(dispatchMatch[1]!);
        const repo = decodePathSegment(dispatchMatch[2]!);
        if (!owner || !repo || !isRepositoryCoordinate(owner, repo)) return json({ error: "invalid-repository" }, 400);
        const repository = await store.getRepository(owner, repo);
        if (!repository) return json({ error: "repository-not-found" }, 404);
        const installation = await store.getInstallation(repository.installationId);
        if (installation && !installation.active) return json({ error: "installation-inactive" }, 409);
        const input = await request.json() as { artifactId?: unknown };
        if (typeof input.artifactId !== "string" || !/^[a-f0-9]{64}$/.test(input.artifactId)) {
          return json({ error: "invalid-artifact-id" }, 400);
        }
        const trusted = await store.getArtifact(input.artifactId);
        if (!trusted || trusted.template !== repository.template) return json({ error: "artifact-not-found" }, 404);
        const rollout = await store.getRollout(repository.template, trusted.version);
        if (!rollout) return json({ error: "rollout-not-found" }, 404);
        if (rollout.artifactId !== trusted.id || rollout.upstreamCommit !== trusted.upstreamCommit) {
          return json({ error: "artifact-rollout-mismatch" }, 409);
        }
        const artifact: UpdateArtifact = {
          artifactId: trusted.id,
          template: trusted.template,
          version: trusted.version,
          baseBranch: trusted.baseBranch,
          files: trusted.files,
          releaseNotes: trusted.releaseNotes,
        };
        const clients = dependencies.githubClientFactory ?? defaultClientFactory(env, dependencies.fetcher);
        if (!clients) return json({ error: "github-app-not-configured" }, 503);
        const result = await new UpdateOrchestrator(store, clients).dispatchRepository(repository, rollout, artifact);
        return json(result, result.outcome === "skipped" ? 202 : 201);
      }

      const repositoryMatch = url.pathname.match(/^\/api\/repositories\/([^/]+)\/([^/]+)$/);
      if (repositoryMatch) {
        const owner = decodePathSegment(repositoryMatch[1]!);
        const repo = decodePathSegment(repositoryMatch[2]!);
        if (!owner || !repo || !isRepositoryCoordinate(owner, repo)) return json({ error: "invalid-repository" }, 400);
        if (request.method === "GET") return jsonOrNotFound(await store.getRepository(owner, repo));
        if (request.method === "PUT") {
          const input = await request.json() as Partial<RepositoryRegistration>;
          if (!Number.isSafeInteger(input.installationId) || Number(input.installationId) <= 0
            || !isSlug(input.template) || !isMode(input.mode) || !isChannel(input.channel)
            || (input.enabled !== undefined && typeof input.enabled !== "boolean")
            || (input.deploymentCheck !== undefined && (typeof input.deploymentCheck !== "string"
              || !/^Workers Builds: [a-z0-9][a-z0-9-]{0,62}$/.test(input.deploymentCheck)))) {
            return json({ error: "invalid-repository" }, 400);
          }
          const now = new Date().toISOString();
          const existing = await store.getRepository(owner, repo);
          const record: RepositoryRegistration = {
            installationId: Number(input.installationId),
            owner,
            repo,
            template: input.template,
            mode: input.mode,
            channel: input.channel ?? cohortFor(`${owner}/${repo}`, input.template),
            enabled: input.enabled ?? true,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            ...(input.deploymentCheck !== undefined ? { deploymentCheck: input.deploymentCheck }
              : existing?.deploymentCheck ? { deploymentCheck: existing.deploymentCheck } : {}),
          };
          await store.putRepository(record);
          return json(record, existing ? 200 : 201);
        }
      }

      const rolloutMatch = url.pathname.match(/^\/api\/rollouts\/([^/]+)\/([^/]+)(?:\/(events|advance|decisions|observations))?$/);
      if (rolloutMatch) {
        const template = decodeURIComponent(rolloutMatch[1]!);
        const version = decodeURIComponent(rolloutMatch[2]!);
        const operation = rolloutMatch[3];
        if (request.method === "GET" && !operation) return jsonOrNotFound(await store.getRollout(template, version));
        if (request.method === "PUT" && !operation) {
          const input = await request.json() as { artifactId?: unknown; config?: Partial<RolloutConfig> };
          const existing = await store.getRollout(template, version);
          if (existing && input.artifactId && input.artifactId !== existing.artifactId) {
            return json({ error: "rollout-artifact-immutable" }, 409);
          }
          if (existing) return json(existing);
          if (!existing && (typeof input.artifactId !== "string" || !/^[a-f0-9]{64}$/.test(input.artifactId))) {
            return json({ error: "artifact-required" }, 400);
          }
          const artifact = existing ? undefined : await store.getArtifact(input.artifactId as string);
          if (!existing && (!artifact || artifact.template !== template || artifact.version !== version)) {
            return json({ error: "artifact-not-found" }, 404);
          }
          const config = mergeConfig(input.config);
          if (!validRolloutConfig(config)) return json({ error: "invalid-rollout-config" }, 400);
          const state: RolloutState = {
            template,
            version,
            artifactId: artifact!.id,
            upstreamCommit: artifact!.upstreamCommit,
            phase: "canary",
            phaseStartedAt: new Date().toISOString(),
            config,
            events: [],
          };
          await store.putRollout(state, true);
          const stored = await store.getRollout(template, version);
          if (stored?.artifactId !== state.artifactId) return json({ error: "rollout-artifact-immutable" }, 409);
          return json(stored, 201);
        }
        if (request.method === "POST" && operation === "events") {
          const state = await store.getRollout(template, version);
          if (!state) return json({ error: "not-found" }, 404);
          const event = await request.json() as Partial<RolloutEvent>;
          if (!event.repositoryKey || !event.artifactId || !event.version || !event.upstreamCommit
            || !["success", "failure", "rollback"].includes(event.result as string)) {
            return json({ error: "invalid-event" }, 400);
          }
          const coordinates = parseRepositoryKey(event.repositoryKey);
          if (!coordinates) return json({ error: "invalid-repository" }, 400);
          const repository = await store.getRepository(coordinates.owner, coordinates.repo);
          if (!repository || !repository.enabled || repository.template !== template) {
            return json({ error: "unregistered-repository" }, 403);
          }
          if (!isRepositoryInCurrentPhase(repository, state)) return json({ error: "repository-not-in-rollout-phase" }, 409);
          if (event.artifactId !== state.artifactId || event.version !== state.version
            || event.upstreamCommit.toLowerCase() !== state.upstreamCommit.toLowerCase()) {
            return json({ error: "event-rollout-mismatch" }, 409);
          }
          const occurredAt = event.occurredAt ?? new Date().toISOString();
          const occurredAtMs = Date.parse(occurredAt);
          if (!Number.isFinite(occurredAtMs) || occurredAtMs < Date.parse(state.phaseStartedAt)
            || occurredAtMs > Date.now() + 5 * 60 * 1000) {
            return json({ error: "invalid-event-time" }, 400);
          }
          const previous = structuredClone(state);
          state.events.push({
            repositoryKey: `${repository.owner.toLowerCase()}/${repository.repo.toLowerCase()}`,
            artifactId: event.artifactId,
            version: event.version,
            upstreamCommit: event.upstreamCommit.toLowerCase(),
            result: event.result as RolloutEvent["result"],
            occurredAt,
          });
          if (!(await store.compareAndSetRollout(previous, state))) {
            return json({ error: "concurrent-update-retry" }, 409);
          }
          return json(state, 202);
        }
        if (request.method === "POST" && operation === "advance") {
          const state = await store.getRollout(template, version);
          if (!state) return json({ error: "not-found" }, 404);
          return json(await reconcileRollout(store, template, version));
        }
        if (request.method === "GET" && operation === "observations") return json(await store.listVerifiedDeployments(template, version));
        if (request.method === "GET" && operation === "decisions") {
          const state = await store.getRollout(template, version);
          if (!state) return json({ error: "not-found" }, 404);
          const repositories = await store.listRepositories(template);
          return json(repositories.map((repository) => ({
            repository: `${repository.owner}/${repository.repo}`,
            ...updateDecision(repository, state),
          })));
        }
      }

      return json({ error: "not-found" }, 404);
    },
  };
}

function schedulerMode(env: Env): "cloudflare" | "github" | "manual" | undefined {
  // Preserve the existing native default; explicit invalid values fail closed.
  const mode = env.SCHEDULER_MODE ?? "cloudflare";
  return mode === "cloudflare" || mode === "github" || mode === "manual" ? mode : undefined;
}

async function reconcile(store: StateStore, clients: GitHubClientFactory, env: Env) {
  const reconciliationFailures = await new UpdateAutomation(store, clients, Number(env.APP_ID)).reconcile();
  const automaticDispatchEnabled = env.AUTO_DISPATCH_ENABLED === "true";
  // Incomplete provider observations must not be followed by new automatic dispatches.
  const results = automaticDispatchEnabled && reconciliationFailures === 0
    ? await new UpdateOrchestrator(store, clients).dispatchReleases() : [];
  for (const result of results) console.log(JSON.stringify({ event: "release-dispatch", ...result }));
  const dispatchFailures = results.filter(result => result.outcome === "failed").length;
  return { ok: reconciliationFailures === 0 && dispatchFailures === 0, reconciliationFailures, dispatchFailures, automaticDispatchEnabled };
}

function mergeConfig(input?: Partial<RolloutConfig>): RolloutConfig {
  return {
    ...DEFAULT_ROLLOUT_CONFIG,
    ...input,
    canary: { ...DEFAULT_ROLLOUT_CONFIG.canary, ...input?.canary },
    early: { ...DEFAULT_ROLLOUT_CONFIG.early, ...input?.early },
  };
}

function validRolloutConfig(config: RolloutConfig): boolean {
  return Number.isInteger(config.canaryBasisPoints) && Number.isInteger(config.earlyBasisPoints)
    && config.canaryBasisPoints >= 0 && config.earlyBasisPoints >= config.canaryBasisPoints && config.earlyBasisPoints <= 10_000
    && [config.canary, config.early].every(gate => Number.isSafeInteger(gate.minimumSuccesses) && gate.minimumSuccesses > 0
      && Number.isSafeInteger(gate.minimumEvents) && gate.minimumEvents > 0
      && Number.isSafeInteger(gate.observationMs) && gate.observationMs >= 0
      && Number.isFinite(gate.maximumFailureRate) && gate.maximumFailureRate >= 0 && gate.maximumFailureRate <= 1);
}

async function isAuthorized(request: Request, token: string): Promise<boolean> {
  const supplied = request.headers.get("authorization");
  if (!token || !supplied) return false;
  const expectedBytes = new TextEncoder().encode(`Bearer ${token}`);
  const suppliedBytes = new TextEncoder().encode(supplied);
  if (expectedBytes.length !== suppliedBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    difference |= expectedBytes[index]! ^ suppliedBytes[index]!;
  }
  return difference === 0;
}

function isMode(mode: unknown): mode is UpdateMode {
  return mode === "manual" || mode === "auto" || mode === "staged-auto";
}

function isChannel(channel: unknown): channel is RepositoryRegistration["channel"] | undefined {
  return channel === undefined || channel === "canary" || channel === "early" || channel === "stable";
}

function isUpdateFiles(files: unknown): files is UpdateArtifact["files"] {
  return Array.isArray(files) && files.length > 0 && files.every((file: unknown) => {
    if (!file || typeof file !== "object") return false;
    const candidate = file as { path?: unknown; content?: unknown };
    return typeof candidate.path === "string" && isManagedArtifactPath(candidate.path) && typeof candidate.content === "string"
      && candidate.content.length <= 1_000_000;
  });
}

function isArtifactPayload(input: Partial<ArtifactPayload>): input is ArtifactPayload {
  return isSlug(input.template) && isSlug(input.version)
    && typeof input.upstreamCommit === "string" && /^[a-f0-9]{40}$/i.test(input.upstreamCommit)
    && typeof input.baseBranch === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,198}[A-Za-z0-9])?$/.test(input.baseBranch)
    && typeof input.releaseNotes === "string" && input.releaseNotes.length <= 100_000
    && isUpdateFiles(input.files) && input.files.length <= 10_000;
}

function isSlug(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(value);
}

function isRepositoryCoordinate(owner: string, repo: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)
    && /^[A-Za-z0-9._-]{1,100}$/.test(repo)
    && repo !== "." && repo !== "..";
}

function decodePathSegment(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0") ? undefined : decoded;
  } catch {
    return undefined;
  }
}

function parseRepositoryKey(key: string): { owner: string; repo: string } | undefined {
  const parts = key.split("/");
  if (parts.length !== 2 || !isRepositoryCoordinate(parts[0]!, parts[1]!)) return undefined;
  return { owner: parts[0]!, repo: parts[1]! };
}

function defaultClientFactory(env: Env, fetcher?: Fetcher): GitHubClientFactory | undefined {
  if (!env.APP_ID || !env.PRIVATE_KEY) return undefined;
  const credentials = { appId: env.APP_ID, privateKey: env.PRIVATE_KEY };
  return {
    async forInstallation(installationId: number): Promise<GitHubClient> {
      return fetcher
        ? installationClient(credentials, installationId, fetcher)
        : installationClient(credentials, installationId);
    },
  };
}

function jsonOrNotFound(value: unknown): Response {
  return value === undefined ? json({ error: "not-found" }, 404) : json(value);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

export default createWorker();

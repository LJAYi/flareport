import { D1StateStore, type D1Database } from "./d1-store.ts";
import { artifactDigest, isManagedArtifactPath, type ArtifactPayload } from "./artifact.ts";
import { installationClient, type Fetcher } from "./github-auth.ts";
import type { GitHubClient } from "./github.ts";
import { UpdateOrchestrator, type GitHubClientFactory, type UpdateArtifact } from "./orchestrator.ts";
import { cohortFor, DEFAULT_ROLLOUT_CONFIG, evaluateRollout, isRepositoryInCurrentPhase, updateDecision } from "./rollout.ts";
import { MemoryStateStore, type StateStore } from "./store.ts";
import type { RepositoryRegistration, RolloutConfig, RolloutEvent, RolloutState, TrustedArtifact, UpdateMode } from "./types.ts";
import { handleGitHubWebhook } from "./webhook.ts";

export interface Env {
  WEBHOOK_SECRET: string;
  ADMIN_TOKEN: string;
  ARTIFACT_TOKEN?: string;
  APP_ID?: string;
  PRIVATE_KEY?: string;
  DB?: D1Database;
}

const memoryStore = new MemoryStateStore();

export interface WorkerDependencies {
  fetcher?: Fetcher;
  githubClientFactory?: GitHubClientFactory;
}

export function createWorker(configuredStore?: StateStore, dependencies: WorkerDependencies = {}) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const store = configuredStore ?? (env.DB ? new D1StateStore(env.DB) : memoryStore);
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return json({ ok: true });
      if (url.pathname === "/webhooks/github" && request.method === "POST") {
        return handleGitHubWebhook(request, env.WEBHOOK_SECRET, store);
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
            || !isSlug(input.template) || !isMode(input.mode) || !isChannel(input.channel)) {
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
          };
          await store.putRepository(record);
          return json(record, existing ? 200 : 201);
        }
      }

      const rolloutMatch = url.pathname.match(/^\/api\/rollouts\/([^/]+)\/([^/]+)(?:\/(events|advance|decisions))?$/);
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
          if (!existing && (typeof input.artifactId !== "string" || !/^[a-f0-9]{64}$/.test(input.artifactId))) {
            return json({ error: "artifact-required" }, 400);
          }
          const artifact = existing ? undefined : await store.getArtifact(input.artifactId as string);
          if (!existing && (!artifact || artifact.template !== template || artifact.version !== version)) {
            return json({ error: "artifact-not-found" }, 404);
          }
          const state: RolloutState = existing ?? {
            template,
            version,
            artifactId: artifact!.id,
            upstreamCommit: artifact!.upstreamCommit,
            phase: "canary",
            phaseStartedAt: new Date().toISOString(),
            config: mergeConfig(input.config),
            events: [],
          };
          await store.putRollout(state);
          return json(state, existing ? 200 : 201);
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
          state.events.push({
            repositoryKey: `${repository.owner.toLowerCase()}/${repository.repo.toLowerCase()}`,
            artifactId: event.artifactId,
            version: event.version,
            upstreamCommit: event.upstreamCommit.toLowerCase(),
            result: event.result as RolloutEvent["result"],
            occurredAt,
          });
          const evaluated = evaluateRollout(state);
          await store.putRollout(evaluated);
          return json(evaluated, 202);
        }
        if (request.method === "POST" && operation === "advance") {
          const state = await store.getRollout(template, version);
          if (!state) return json({ error: "not-found" }, 404);
          const evaluated = evaluateRollout(state);
          await store.putRollout(evaluated);
          return json(evaluated);
        }
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

function mergeConfig(input?: Partial<RolloutConfig>): RolloutConfig {
  return {
    ...DEFAULT_ROLLOUT_CONFIG,
    ...input,
    canary: { ...DEFAULT_ROLLOUT_CONFIG.canary, ...input?.canary },
    early: { ...DEFAULT_ROLLOUT_CONFIG.early, ...input?.early },
  };
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

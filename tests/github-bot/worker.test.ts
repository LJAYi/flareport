import assert from "node:assert/strict";
import test from "node:test";
import { hmacSha256 } from "../../apps/github-bot/src/crypto.ts";
import { artifactDigest, type ArtifactPayload } from "../../apps/github-bot/src/artifact.ts";
import { MemoryStateStore } from "../../apps/github-bot/src/store.ts";
import type { GitHubClient } from "../../apps/github-bot/src/github.ts";
import { createWorker } from "../../apps/github-bot/src/worker.ts";
import type { TrustedArtifact } from "../../apps/github-bot/src/types.ts";

const artifactId = "a".repeat(64);
const upstreamCommit = "b".repeat(40);
const env = { WEBHOOK_SECRET: "webhook-secret", ADMIN_TOKEN: "admin-secret", ARTIFACT_TOKEN: "artifact-secret" };
const auth = { authorization: "Bearer admin-secret", "content-type": "application/json" };
const artifactAuth = { authorization: "Bearer artifact-secret", "content-type": "application/json" };

function trustedArtifact(overrides: Partial<TrustedArtifact> = {}): TrustedArtifact {
  return {
    id: artifactId, contentHash: artifactId, template: "nodewarden", version: "1.0.0", upstreamCommit,
    baseBranch: "main", releaseNotes: "Trusted release", files: [{ path: "flareport.lock", content: "1.0.0" }],
    createdAt: "2026-08-05T00:00:00.000Z", ...overrides,
  };
}

test("worker registers repositories, starts rollouts, and exposes decisions", async () => {
  const store = new MemoryStateStore();
  await store.putArtifact(trustedArtifact());
  const worker = createWorker(store);
  const repositoryResponse = await worker.fetch(new Request("https://bot.test/api/repositories/octo/app", {
    method: "PUT", headers: auth,
    body: JSON.stringify({ installationId: 42, template: "nodewarden", mode: "staged-auto", channel: "canary" }),
  }), env);
  assert.equal(repositoryResponse.status, 201);

  const rolloutResponse = await worker.fetch(new Request("https://bot.test/api/rollouts/nodewarden/1.0.0", {
    method: "PUT", headers: auth, body: JSON.stringify({ artifactId }),
  }), env);
  assert.equal(rolloutResponse.status, 201);

  const decisions = await worker.fetch(new Request(
    "https://bot.test/api/rollouts/nodewarden/1.0.0/decisions", { headers: auth },
  ), env);
  assert.deepEqual(await decisions.json(), [{
    repository: "octo/app", createPullRequest: true, autoMerge: false, reason: "eligible-canary-pending-checks",
  }]);
});

test("admin API is protected", async () => {
  const response = await createWorker(new MemoryStateStore()).fetch(
    new Request("https://bot.test/api/repositories/octo/app"), env,
  );
  assert.equal(response.status, 401);
});

test("repository registration rejects unsafe coordinates and invalid policy identifiers", async () => {
  const worker = createWorker(new MemoryStateStore());
  const cases = [
    ["https://bot.test/api/repositories/octo%2Fother/app", { installationId: 42, template: "nodewarden", mode: "manual" }],
    ["https://bot.test/api/repositories/octo/app", { installationId: 0, template: "nodewarden", mode: "manual" }],
    ["https://bot.test/api/repositories/octo/app", { installationId: 42, template: "../nodewarden", mode: "manual" }],
  ] as const;
  for (const [url, body] of cases) {
    const response = await worker.fetch(new Request(url, {
      method: "PUT", headers: auth, body: JSON.stringify(body),
    }), env);
    assert.equal(response.status, 400);
  }
});

test("webhook verifies signatures and tracks installations", async () => {
  const store = new MemoryStateStore();
  const worker = createWorker(store);
  const body = JSON.stringify({ action: "created", installation: { id: 99, account: { login: "octo" } } });
  const signature = `sha256=${await hmacSha256(env.WEBHOOK_SECRET, body)}`;
  const response = await worker.fetch(new Request("https://bot.test/webhooks/github", {
    method: "POST",
    headers: { "x-hub-signature-256": signature, "x-github-event": "installation" },
    body,
  }), env);
  assert.equal(response.status, 202);
  assert.equal((await store.getInstallation(99))?.account, "octo");
});

test("dispatch endpoint uses the registered installation and rollout policy", async () => {
  const store = new MemoryStateStore();
  const now = "2026-08-05T00:00:00.000Z";
  await store.putInstallation({ installationId: 42, account: "octo", active: true, updatedAt: now });
  await store.putRepository({
    installationId: 42, owner: "octo", repo: "app", template: "nodewarden", mode: "auto",
    channel: "stable", enabled: true, createdAt: now, updatedAt: now,
  });
  await store.putArtifact(trustedArtifact());
  await store.putRollout({
    template: "nodewarden", version: "1.0.0", artifactId, upstreamCommit,
    phase: "canary", phaseStartedAt: now, events: [],
    config: {
      canaryBasisPoints: 100, earlyBasisPoints: 2500,
      canary: { minimumSuccesses: 10, minimumEvents: 10, observationMs: 1, maximumFailureRate: 0.05 },
      early: { minimumSuccesses: 100, minimumEvents: 100, observationMs: 1, maximumFailureRate: 0.05 },
    },
  });
  let received: unknown;
  let clientCalls = 0;
  const githubClient = {
    async createUpdatePullRequest(input: unknown) {
      clientCalls += 1;
      received = input;
      return { number: 3, node_id: "PR_3", html_url: "https://github.test/pr/3", headSha: "d".repeat(40) };
    },
  } as unknown as GitHubClient;
  const worker = createWorker(store, {
    githubClientFactory: {
      async forInstallation(installationId) {
        assert.equal(installationId, 42);
        return githubClient;
      },
    },
  });
  const response = await worker.fetch(new Request("https://bot.test/api/repositories/octo/app/dispatch", {
    method: "POST", headers: auth,
    body: JSON.stringify({ artifactId }),
  }), env);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    repository: "octo/app", outcome: "pull-request-created", reason: "repository-auto-pending-checks",
    pullRequestUrl: "https://github.test/pr/3",
  });
  assert.equal(Object.hasOwn(received as object, "autoMerge"), false);

  const retry = await worker.fetch(new Request("https://bot.test/api/repositories/octo/app/dispatch", {
    method: "POST", headers: auth, body: JSON.stringify({ artifactId }),
  }), env);
  assert.equal(retry.status, 201);
  assert.deepEqual(await retry.json(), {
    repository: "octo/app", outcome: "pull-request-created", reason: "already-dispatched",
    pullRequestUrl: "https://github.test/pr/3",
  });
  assert.equal(clientCalls, 1);
});

test("trusted artifact publication rejects protected and escaping paths", async () => {
  const store = new MemoryStateStore();
  for (const path of ["../owned", "/absolute", "dir/../../owned", "dir\\owned", "dir//owned", "./owned", ".github/workflows/pwn.yml"]) {
    const response = await createWorker(store).fetch(new Request(`https://bot.test/api/artifacts/${artifactId}`, {
      method: "PUT", headers: artifactAuth,
      body: JSON.stringify({
        ...trustedArtifact(), id: undefined, createdAt: undefined,
        files: [{ path, content: "nope" }],
      }),
    }), env);
    assert.equal(response.status, 400, path);
  }
});

test("trusted artifact publication verifies its canonical digest and is immutable", async () => {
  const store = new MemoryStateStore();
  const payload: ArtifactPayload = {
    template: "nodewarden", version: "1.0.0", upstreamCommit, baseBranch: "main",
    releaseNotes: "Validated", files: [{ path: "flareport.lock", content: "v1" }],
  };
  const digest = await artifactDigest(payload);
  const worker = createWorker(store);
  const response = await worker.fetch(new Request(`https://bot.test/api/artifacts/${digest}`, {
    method: "PUT", headers: artifactAuth, body: JSON.stringify({ ...payload, contentHash: digest }),
  }), env);
  assert.equal(response.status, 201);
  assert.equal((await store.getArtifact(digest))?.upstreamCommit, upstreamCommit);

  const mismatch = await worker.fetch(new Request(`https://bot.test/api/artifacts/${digest}`, {
    method: "PUT", headers: artifactAuth,
    body: JSON.stringify({ ...payload, releaseNotes: "tampered", contentHash: digest }),
  }), env);
  assert.equal(mismatch.status, 400);
});

test("rollout events require a registered in-phase repository and exact artifact binding", async () => {
  const store = new MemoryStateStore();
  const now = new Date().toISOString();
  await store.putRepository({
    installationId: 42, owner: "octo", repo: "app", template: "nodewarden", mode: "staged-auto",
    channel: "canary", enabled: true, createdAt: now, updatedAt: now,
  });
  await store.putRollout({
    template: "nodewarden", version: "1.0.0", artifactId, upstreamCommit,
    phase: "canary", phaseStartedAt: now, events: [],
    config: {
      canaryBasisPoints: 100, earlyBasisPoints: 2500,
      canary: { minimumSuccesses: 10, minimumEvents: 10, observationMs: 1, maximumFailureRate: 0.05 },
      early: { minimumSuccesses: 100, minimumEvents: 100, observationMs: 1, maximumFailureRate: 0.05 },
    },
  });
  const worker = createWorker(store);
  const send = (body: unknown) => worker.fetch(new Request("https://bot.test/api/rollouts/nodewarden/1.0.0/events", {
    method: "POST", headers: auth, body: JSON.stringify(body),
  }), env);
  const baseEvent = { artifactId, version: "1.0.0", upstreamCommit, result: "success" };
  assert.equal((await send({ ...baseEvent, repositoryKey: "fake/repo" })).status, 403);
  assert.equal((await send({ ...baseEvent, repositoryKey: "octo/app", upstreamCommit: "c".repeat(40) })).status, 409);
  assert.equal((await send({ ...baseEvent, repositoryKey: "octo/app" })).status, 202);
  assert.equal((await store.getRollout("nodewarden", "1.0.0"))?.events.length, 1);
});

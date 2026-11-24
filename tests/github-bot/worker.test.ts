import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
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

test("scheduler token is narrow, optional, POST-only, and fails closed without configuration", async () => {
  const store = new MemoryStateStore();
  const worker = createWorker(store);
  const schedulerEnv = { ...env, SCHEDULER_TOKEN: "scheduler-secret", SCHEDULER_MODE: "manual" };
  const url = "https://bot.test/api/scheduler/reconcile";
  const request = (token = "scheduler-secret", method = "POST") => new Request(url, {
    method, headers: { authorization: `Bearer ${token}`, "x-flareport-trigger": "manual" },
  });
  assert.equal((await worker.fetch(request(), env)).status, 401);
  for (const token of ["", "wrong", env.ADMIN_TOKEN, env.ARTIFACT_TOKEN]) {
    assert.equal((await worker.fetch(request(token), schedulerEnv)).status, 401);
  }
  const wrongMethod = await worker.fetch(request("scheduler-secret", "GET"), schedulerEnv);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");
  assert.equal((await worker.fetch(request(), schedulerEnv)).status, 503);
  const dependencies = { githubClientFactory: { async forInstallation(): Promise<GitHubClient> { throw new Error("unused"); } } };
  assert.equal((await createWorker(undefined, dependencies).fetch(request(), schedulerEnv)).status, 503);
  const configured = createWorker(store, dependencies);
  assert.deepEqual(await (await configured.fetch(request(), schedulerEnv)).json(), {
    ok: true, reconciliationFailures: 0, dispatchFailures: 0, automaticDispatchEnabled: false,
  });
  for (const [path, method] of [["/api/repositories/octo/app", "PUT"], [`/api/artifacts/${artifactId}`, "PUT"], ["/api/releases/nodewarden/1.0.0", "PUT"]] as const) {
    assert.equal((await configured.fetch(new Request(`https://bot.test${path}`, { method,
      headers: { authorization: "Bearer scheduler-secret" } }), schedulerEnv)).status, 401);
  }
  store.listRepositories = async () => { throw new Error("sensitive provider response"); };
  const failure = await configured.fetch(request(), schedulerEnv);
  assert.equal(failure.status, 502);
  assert.deepEqual(await failure.json(), { error: "reconciliation-failed" });
});

test("scheduler modes admit only the selected sources before reading state or creating GitHub clients", async () => {
  for (const mode of [undefined, "cloudflare", "github", "manual", "", "Cloudflare", "unknown"]) {
    const store = new MemoryStateStore();
    let reads = 0;
    store.listRepositories = async () => { reads++; return []; };
    const worker = createWorker(store, {
      githubClientFactory: { async forInstallation(): Promise<GitHubClient> { throw new Error("Unexpected client creation"); } },
    });
    const runEnv = { ...env, SCHEDULER_TOKEN: "scheduler-secret", ...(mode === undefined ? {} : { SCHEDULER_MODE: mode }) };
    const valid = mode === undefined || ["cloudflare", "github", "manual"].includes(mode);
    if (valid) await worker.scheduled({}, runEnv);
    else await assert.rejects(worker.scheduled({}, runEnv), /Invalid SCHEDULER_MODE/);
    assert.equal(reads, mode === undefined || mode === "cloudflare" ? 1 : 0);

    for (const source of [undefined, "cloudflare", "github-schedule", "manual", "unknown"]) {
      const before: number = reads;
      const allowed = (mode === "github" && (source === "github-schedule" || source === "manual"))
        || (mode === "manual" && source === "manual");
      const response = await worker.fetch(new Request("https://bot.test/api/scheduler/reconcile?mode=github", {
        method: "POST",
        headers: { authorization: "Bearer scheduler-secret", ...(source === undefined ? {} : { "x-flareport-trigger": source }) },
        body: JSON.stringify({ SCHEDULER_MODE: "github", AUTO_DISPATCH_ENABLED: "true", autoMerge: true }),
      }), runEnv);
      const expected = !valid ? 503 : source !== "github-schedule" && source !== "manual" ? 400 : allowed ? 200 : 409;
      assert.equal(response.status, expected, `mode=${mode}, source=${source}`);
      assert.equal(reads - before, allowed ? 1 : 0, "rejected sources must not start reconciliation");
      if (allowed) assert.equal((await response.json() as { automaticDispatchEnabled: boolean }).automaticDispatchEnabled, false);
    }
  }
});

test("native scheduler fails visibly when App or durable state is missing", async () => {
  await assert.rejects(createWorker(new MemoryStateStore()).scheduled({}, env), /GitHub App not configured/);
  const dependencies = { githubClientFactory: { async forInstallation(): Promise<GitHubClient> { throw new Error("unused"); } } };
  await assert.rejects(createWorker(undefined, dependencies).scheduled({}, env), /Database not configured/);
});

test("selectable scheduler workflow gates events, serializes calls and detects HTTP/partial failures", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/bot-reconcile.yml", import.meta.url), "utf8");
  const config = await readFile(new URL("../../apps/github-bot/wrangler.jsonc", import.meta.url), "utf8");
  assert.match(config, /"name": "flareport"/);
  assert.match(config, /"crons": \["\*\/5 \* \* \* \*"\]/);
  assert.match(config, /"AUTO_DISPATCH_ENABLED": "false"/);
  assert.match(config, /"SCHEDULER_MODE": "cloudflare"/);
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.match(workflow, /^  schedule:/m);
  assert.match(workflow, /cron: '3-58\/5 \* \* \* \*'/);
  assert.match(workflow, /permissions: \{\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /group: flareport-bot-reconcile/);
  assert.match(workflow, /environment: flareport-scheduler/);
  assert.match(workflow, /github\.event\.repository\.default_branch/);
  assert.match(workflow, /FLAREPORT_BOT_SCHEDULER_MODE/);
  assert.doesNotMatch(workflow, /FLAREPORT_BOT_SCHEDULER_ENABLED/);
  assert.doesNotMatch(workflow, /uses:|pull_request:|pull_request_target:|ADMIN_TOKEN|ARTIFACT_TOKEN|PRIVATE_KEY|contents: write/);
  const condition = workflow.match(/    if: >-\n([\s\S]*?)\n    runs-on:/)![1]!;
  for (const mode of ["", "cloudflare", "github", "manual", "invalid"]) {
    for (const event of ["schedule", "workflow_dispatch", "push", "pull_request"]) {
      for (const branch of ["main", "untrusted"]) {
        const allowed = runInNewContext(condition, {
          vars: { FLAREPORT_BOT_SCHEDULER_MODE: mode, FLAREPORT_BOT_SCHEDULER_ENABLED: "true" },
          github: { event_name: event, ref: `refs/heads/${branch}`, event: { repository: { default_branch: "main" } } },
          format: (pattern: string, value: string) => pattern.replace("{0}", value),
        });
        assert.equal(allowed, branch === "main" && ((mode === "github" && ["schedule", "workflow_dispatch"].includes(event))
          || (mode === "manual" && event === "workflow_dispatch")), `mode=${mode}, event=${event}, branch=${branch}`);
      }
    }
  }
  const sourceExpression = workflow.match(/FLAREPORT_TRIGGER: \$\{\{ (.*?) \}\}/)![1]!;
  for (const event of ["schedule", "workflow_dispatch"]) {
    assert.equal(runInNewContext(sourceExpression, { github: { event_name: event } }), event === "schedule" ? "github-schedule" : "manual");
  }
  const script = workflow.split("<<'NODE'\n")[1]!.split("\n          NODE")[0]!;
  let calls = 0;
  const execute = (origin = "https://bot.test", token = "scheduler-secret", status = 200, ok = true, source = "manual") => runInNewContext(`(async () => {${script}\n})()`, {
    URL, AbortSignal, process: { env: { FLAREPORT_BOT_URL: origin, FLAREPORT_SCHEDULER_TOKEN: token, FLAREPORT_TRIGGER: source } }, console: { log() {} },
    async fetch(url: URL, init: RequestInit) {
      calls++;
      assert.equal(url.href, "https://bot.test/api/scheduler/reconcile");
      assert.equal(init.method, "POST"); assert.equal(init.redirect, "error");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer scheduler-secret");
      assert.equal(new Headers(init.headers).get("x-flareport-trigger"), source);
      assert.ok(init.signal);
      return new Response(JSON.stringify({ ok, reconciliationFailures: 0, dispatchFailures: 0 }), { status });
    },
  }) as Promise<void>;
  for (const origin of ["http://bot.test", "https://user@bot.test", "https://bot.test/path", "https://bot.test?query", "https://bot.test#hash"]) {
    await assert.rejects(execute(origin), /HTTPS origin/);
  }
  await assert.rejects(execute("https://bot.test", ""), /Missing scheduler token/);
  await assert.rejects(execute("https://bot.test", "scheduler-secret", 200, true, "cloudflare"), /Invalid scheduler source/);
  assert.equal(calls, 0);
  await execute();
  await execute("https://bot.test", "scheduler-secret", 200, true, "github-schedule");
  for (const status of [202, 302, 401, 409, 502, 503]) await assert.rejects(execute("https://bot.test", "scheduler-secret", status), /HTTP/);
  await assert.rejects(execute("https://bot.test", "scheduler-secret", 200, false), /did not complete/);
  assert.equal(calls, 9, "no automatic HTTP retries after ambiguous failures");
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
  let checked: unknown;
  let clientCalls = 0;
  const githubClient = {
    async createUpdatePullRequest(input: unknown) {
      clientCalls += 1;
      received = input;
      return { number: 3, node_id: "PR_3", html_url: "https://github.test/pr/3", headSha: "d".repeat(40) };
    },
    async publishArtifactCheck(owner: string, repo: string, headSha: string, id: string) {
      checked = { owner, repo, headSha, id };
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
  assert.deepEqual(checked, { owner: "octo", repo: "app", headSha: "d".repeat(40), id: artifactId });

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
  for (const path of ["../owned", "/absolute", "dir/../../owned", "dir\\owned", "dir//owned", "./owned", ".github/workflows/pwn.yml", "flareport.user.json", ".flareport/user.json", ".env", "config/.env.production", ".dev.vars"]) {
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

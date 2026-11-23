import assert from "node:assert/strict";
import test from "node:test";
import { UpdateAutomation, reconcileRollout } from "../../apps/github-bot/src/automation.ts";
import { GitHubClient, type CheckRun, type UpdatePull } from "../../apps/github-bot/src/github.ts";
import { MemoryStateStore } from "../../apps/github-bot/src/store.ts";
import { createWorker } from "../../apps/github-bot/src/worker.ts";
import { hmacSha256 } from "../../apps/github-bot/src/crypto.ts";
import type { RepositoryRegistration, RolloutState, VerifiedDeployment } from "../../apps/github-bot/src/types.ts";

const artifactId = "a".repeat(64), head = "b".repeat(40), merge = "c".repeat(40), base = "d".repeat(40), upstream = "e".repeat(40);
const start = "2026-08-01T00:00:00.000Z", finished = "2026-08-01T00:00:10.000Z";
const appId = 1234;

async function fixture() {
  const store = new MemoryStateStore();
  const repository: RepositoryRegistration = { owner: "octo", repo: "app", template: "nodewarden", installationId: 42,
    mode: "auto", channel: "canary", enabled: true, deploymentCheck: "Workers Builds: app", createdAt: start, updatedAt: start };
  const artifact = { id: artifactId, contentHash: artifactId, template: "nodewarden", version: "1.0.0", upstreamCommit: upstream,
    baseBranch: "main", releaseNotes: "tested", files: [{ path: "upstream.lock.json", content: "{}" }], createdAt: start };
  const record = { repositoryKey: "octo/app", artifactId, headSha: head, branch: "flareport/update-test", pullRequestNumber: 1,
    pullRequestNodeId: "PR_1", pullRequestUrl: "https://github.com/octo/app/pull/1", createdAt: start };
  const rollout: RolloutState = { template: "nodewarden", version: "1.0.0", artifactId, upstreamCommit: upstream, phase: "canary", phaseStartedAt: start,
    config: { canaryBasisPoints: 100, earlyBasisPoints: 2500,
      canary: { minimumSuccesses: 2, minimumEvents: 2, observationMs: 1000, maximumFailureRate: 0.2 },
      early: { minimumSuccesses: 100, minimumEvents: 100, observationMs: 1000, maximumFailureRate: 0.2 } }, events: [] };
  await store.putInstallation({ installationId: 42, account: "octo", active: true, updatedAt: start });
  await store.putRepository(repository); await store.putArtifact(artifact); await store.putRollout(rollout); await store.putDispatch(record);
  const pull: UpdatePull = { number: 1, node_id: "PR_1", html_url: record.pullRequestUrl, state: "open", draft: false, merged: false,
    merge_commit_sha: null, mergeable_state: "clean", head: { sha: head, ref: record.branch, repo: { full_name: "octo/app" } },
    base: { sha: base, ref: "main", repo: { full_name: "octo/app" } } };
  const check: CheckRun = { id: 101, name: "Validate deployment", head_sha: head, app: { id: 15368, slug: "github-actions" },
    status: "completed", conclusion: "success", started_at: start, completed_at: finished };
  const deployment: CheckRun = { ...check, id: 201, name: repository.deploymentCheck!, head_sha: merge,
    app: { id: 85455, slug: "cloudflare-workers-and-pages" }, output: { summary: "Version ID: 11111111-2222-4333-8444-555555555555" } };
  const settings = { default_branch: "main", allow_auto_merge: true };
  const branch = { protected: true, commit: { sha: base }, protection: { required_status_checks: { checks: [{ context: check.name, app_id: 15368 }] } } };
  const policy = { schemaVersion: 1, autoMerge: true, requiredChecks: [check.name] };
  const metadata = { adapter: { id: "nodewarden" }, management: { autoMergeAllowed: true } };
  const checks = [check, { ...check, id: 102, name: "FlarePort artifact integrity", app: { id: appId, slug: "flareport" }, external_id: artifactId }];
  const merges: unknown[] = [];
  let apiReads = 0;
  const client = {
    async getRepository() { apiReads++; return structuredClone(settings); },
    async getBranch() { apiReads++; return structuredClone(branch); },
    async getPull() { apiReads++; return structuredClone(pull); },
    async readJsonFile(_owner: string, _repo: string, path: string) { apiReads++; return structuredClone(path === "flareport.user.json" ? policy : metadata); },
    async checksForCommit(_owner: string, _repo: string, sha: string) { apiReads++; return structuredClone(sha === merge ? [deployment] : checks); },
    async getCheck() { apiReads++; return structuredClone(deployment); },
    async pullsForCommit() { apiReads++; return [{ number: 1 }]; },
    async mergeExactPull(...args: unknown[]) { merges.push(args); return true; },
  } as unknown as GitHubClient;
  const clients = { async forInstallation(id: number) { assert.equal(id, 42); return client; } };
  const automation = new UpdateAutomation(store, clients, appId);
  const event = { action: "completed", installation: { id: 42 }, repository: { name: "app", owner: { login: "octo" } }, check_run: { id: 201 } };
  return { store, repository, artifact, record, rollout, pull, check, deployment, settings, branch, policy, metadata, checks, merges,
    client, clients, automation, event, reads: () => apiReads };
}

test("automatic merge requires all opt-ins and commits to the exact validated SHA", async () => {
  const f = await fixture();
  assert.equal(await f.automation.maybeMerge(f.repository, f.record, f.client), "merged");
  assert.deepEqual(f.merges, [["octo", "app", 1, head]]);
});

test("manual policy, missing protection, failed/stale/spoofed checks and edited heads never merge", async () => {
  const mutations: Array<(f: Awaited<ReturnType<typeof fixture>>) => Promise<void> | void> = [
    async f => { await f.store.putRepository({ ...f.repository, mode: "manual" }); },
    async f => { await f.store.putRepository({ ...f.repository, enabled: false }); },
    f => { f.settings.allow_auto_merge = false; }, f => { f.branch.protected = false; },
    f => { f.branch.protection.required_status_checks.checks = []; },
    f => { f.branch.protection.required_status_checks.checks[0]!.app_id = 999; },
    f => { f.policy.autoMerge = false; }, f => { f.policy.requiredChecks = []; },
    f => { f.metadata.management.autoMergeAllowed = false; },
    f => { f.check.conclusion = "failure"; }, f => { f.check.status = "in_progress"; },
    f => { f.check.app.id = 999; }, f => { f.check.head_sha = base; },
    f => { f.checks[1]!.external_id = "f".repeat(64); },
    f => { f.checks.push({ ...f.check, id: 999, conclusion: "failure" }); },
    f => { f.pull.head.sha = base; }, f => { f.pull.draft = true; }, f => { f.pull.mergeable_state = "blocked"; },
    async f => { await f.store.putRollout({ ...f.rollout, phase: "paused" }); },
    async f => { await f.store.putRepository({ ...f.repository, mode: "staged-auto", channel: "stable" }); },
    async f => { await f.store.putDispatch({ ...f.record, artifactId: "f".repeat(64), createdAt: finished }); },
  ];
  for (const mutate of mutations) {
    const f = await fixture(); await mutate(f);
    assert.notEqual(await f.automation.maybeMerge(f.repository, f.record, f.client), "merged");
    assert.deepEqual(f.merges, []);
  }
});

test("head changes after check collection are rejected before requesting a merge", async () => {
  const f = await fixture(); const read = f.client.checksForCommit.bind(f.client);
  f.client.checksForCommit = async (...args) => { const result = await read(...args); f.pull.head.sha = base; return result; };
  assert.equal(await f.automation.maybeMerge(f.repository, f.record, f.client), "pull-not-ready");
  assert.deepEqual(f.merges, []);
});

test("revocation or a superseding update during the final PR read prevents merging", async () => {
  const mutations: Array<(f: Awaited<ReturnType<typeof fixture>>) => Promise<void>> = [
    async f => { await f.store.putRepository({ ...f.repository, mode: "manual" }); },
    async f => { await f.store.putRepository({ ...f.repository, template: "another-template" }); },
    async f => { await f.store.putInstallation({ installationId: 42, account: "octo", active: false, updatedAt: finished }); },
    async f => { await f.store.putRollout({ ...f.rollout, phase: "paused" }); },
    async f => { await f.store.putVerifiedDeployment("nodewarden", observation("octo/app", 901, "failure")); },
    async f => { await f.store.putDispatch({ ...f.record, artifactId: "f".repeat(64), createdAt: finished }); },
  ];
  for (const mutate of mutations) {
    const f = await fixture(); const read = f.client.getPull.bind(f.client); let reads = 0;
    f.client.getPull = async (...args) => {
      const pull = await read(...args);
      if (++reads === 2) await mutate(f);
      return pull;
    };
    assert.equal(await f.automation.maybeMerge(f.repository, f.record, f.client), "policy-revoked");
    assert.deepEqual(f.merges, []);
  }
});

test("native merge API includes the expected SHA and never requests a bypass", async () => {
  const calls: unknown[] = [];
  const client = new GitHubClient({ async rest<T>(method: string, path: string, body?: unknown) {
    calls.push({ method, path, body }); return { merged: true } as T;
  }, async graphql<T>() { throw new Error("Unexpected GraphQL merge queue"); } });
  assert.equal(await client.mergeExactPull("octo", "app", 1, head), true);
  assert.deepEqual(calls, [{ method: "PUT", path: "/repos/octo/app/pulls/1/merge", body: { sha: head, merge_method: "squash" } }]);
});

test("a newly activated release blocks merging an older automatic release", async () => {
  const f = await fixture();
  await f.store.putRollout({ ...f.rollout, automaticDispatch: true });
  const read = f.client.getPull.bind(f.client); let reads = 0;
  f.client.getPull = async (...args) => {
    const pull = await read(...args);
    if (++reads === 2) await f.store.putRollout({ ...f.rollout, automaticDispatch: true, version: "2.0.0", artifactId: "f".repeat(64) });
    return pull;
  };
  assert.equal(await f.automation.maybeMerge(f.repository, f.record, f.client), "superseded-release");
  assert.deepEqual(f.merges, []);
});

test("a provider check maps to the recorded PR merge, deduplicates deliveries and does not merge manual repositories", async () => {
  const f = await fixture(); f.pull.merged = true; f.pull.state = "closed"; f.pull.merge_commit_sha = merge;
  await f.store.putRepository({ ...f.repository, mode: "manual" });
  await f.automation.handleCompletedCheck(f.event); await f.automation.handleCompletedCheck(f.event);
  const observations = await f.store.listVerifiedDeployments("nodewarden", "1.0.0");
  assert.equal(observations.length, 1); assert.equal(observations[0]!.mergeSha, merge);
  assert.equal(observations[0]!.artifactId, artifactId); assert.equal(observations[0]!.result, "success");
  assert.deepEqual(f.merges, []);
});

test("wrong installation, provider, Worker, merge SHA, edited PR and build-only success cannot create deployment evidence", async () => {
  const mutations: Array<(f: Awaited<ReturnType<typeof fixture>>) => void> = [
    f => { f.event.installation.id = 99; }, f => { f.deployment.app.id = 999; },
    f => { f.deployment.app.slug = "another-app"; }, f => { f.deployment.name = "Workers Builds: unrelated"; },
    f => { f.deployment.head_sha = head; }, f => { f.deployment.output = { summary: "Build passed; no deployed version" }; },
    f => { f.pull.head.sha = base; }, f => { f.pull.base.ref = "preview"; },
    f => { f.deployment.completed_at = null; }, f => { f.deployment.conclusion = "neutral"; },
  ];
  for (const mutate of mutations) {
    const f = await fixture(); f.pull.merged = true; f.pull.merge_commit_sha = merge; mutate(f);
    await f.automation.handleCompletedCheck(f.event);
    assert.deepEqual(await f.store.listVerifiedDeployments("nodewarden", "1.0.0"), []);
    assert.deepEqual(f.merges, []);
  }
});

test("webhook signature is checked before any API lookup; payload success cannot override API failure", async () => {
  const f = await fixture(); f.pull.merged = true; f.pull.merge_commit_sha = merge; f.deployment.conclusion = "failure";
  const worker = createWorker(f.store, { githubClientFactory: f.clients });
  const env = { APP_ID: String(appId), WEBHOOK_SECRET: "test-secret", ADMIN_TOKEN: "admin" };
  const body = JSON.stringify({ ...f.event, check_run: { id: 201, conclusion: "success" } });
  const send = (signature: string) => worker.fetch(new Request("https://bot.test/webhooks/github", {
    method: "POST", headers: { "x-github-event": "check_run", "x-hub-signature-256": signature }, body,
  }), env);
  assert.equal((await send("sha256=wrong")).status, 401); assert.equal(f.reads(), 0);
  assert.equal((await send(`sha256=${await hmacSha256("test-secret", body)}`)).status, 202);
  assert.equal((await f.store.listVerifiedDeployments("nodewarden", "1.0.0"))[0]!.result, "failure");
});

function observation(repositoryKey: string, id: number, result: "success" | "failure" = "success"): VerifiedDeployment {
  return { repositoryKey, checkRunId: id, artifactId, version: "1.0.0", upstreamCommit: upstream, result,
    occurredAt: finished, startedAt: start, mergeSha: merge };
}

test("manual success reports cannot advance automatic rollout; verified unique samples and observation time can", async () => {
  const f = await fixture();
  await f.store.putRepository({ ...f.repository, repo: "second" });
  await f.store.putRollout({ ...f.rollout, events: Array.from({ length: 100 }, (_, i) => observation(`fake/${i}`, i)) });
  assert.equal((await reconcileRollout(f.store, "nodewarden", "1.0.0"))!.phase, "canary");
  await f.store.putVerifiedDeployment("nodewarden", observation("octo/app", 1));
  await f.store.putVerifiedDeployment("nodewarden", observation("octo/second", 2));
  assert.equal((await reconcileRollout(f.store, "nodewarden", "1.0.0", new Date(finished)))!.phase, "canary");
  assert.equal((await reconcileRollout(f.store, "nodewarden", "1.0.0", new Date("2026-08-01T00:00:12Z")))!.phase, "early");
});

test("a late old success cannot hide a newer failed attempt", async () => {
  const f = await fixture(); await f.store.putRepository({ ...f.repository, repo: "second" });
  await f.store.putVerifiedDeployment("nodewarden", observation("octo/second", 2));
  await f.store.putVerifiedDeployment("nodewarden", { ...observation("octo/app", 4, "failure"), startedAt: "2026-08-01T00:00:05Z" });
  await f.store.putVerifiedDeployment("nodewarden", { ...observation("octo/app", 3), occurredAt: "2026-08-01T00:00:11Z" });
  assert.equal((await reconcileRollout(f.store, "nodewarden", "1.0.0", new Date("2026-08-01T00:00:12Z")))!.phase, "paused");
});

test("concurrent deployment failures invalidate a successful rollout snapshot", async () => {
  const f = await fixture(); await f.store.putRepository({ ...f.repository, repo: "second" });
  await f.store.putVerifiedDeployment("nodewarden", observation("octo/app", 1));
  await f.store.putVerifiedDeployment("nodewarden", observation("octo/second", 2));
  const compare = f.store.compareAndSetRollout.bind(f.store); let raced = false;
  f.store.compareAndSetRollout = async (previous, next) => {
    if (!raced) { raced = true; await f.store.putVerifiedDeployment("nodewarden", { ...observation("octo/app", 3, "failure"), startedAt: "2026-08-01T00:00:05Z" }); }
    return compare(previous, next);
  };
  assert.equal((await reconcileRollout(f.store, "nodewarden", "1.0.0", new Date("2026-08-01T00:00:12Z")))!.phase, "paused");
});

test("late failures from the previous phase still pause early and stable rollouts", async () => {
  for (const phase of ["early", "stable"] as const) {
    const f = await fixture(); await f.store.putRepository({ ...f.repository, repo: "second" });
    await f.store.putVerifiedDeployment("nodewarden", observation("octo/app", 1));
    await f.store.putVerifiedDeployment("nodewarden", observation("octo/second", 2));
    const advanced = (await reconcileRollout(f.store, "nodewarden", "1.0.0", new Date("2026-08-01T00:00:12Z")))!;
    assert.equal(advanced.phase, "early");
    if (phase === "stable") await f.store.putRollout({ ...advanced, phase });
    // The newer failed attempt completed before the phase switch, but its callback arrived afterwards.
    await f.store.putVerifiedDeployment("nodewarden", { ...observation("octo/app", 3, "failure"),
      startedAt: "2026-08-01T00:00:05Z", occurredAt: "2026-08-01T00:00:11Z" });
    assert.equal((await reconcileRollout(f.store, "nodewarden", "1.0.0", new Date("2026-08-01T00:00:13Z")))!.phase, "paused");
  }
});

test("scheduled recovery discovers a missed deployment webhook", async () => {
  const f = await fixture(); f.pull.merged = true; f.pull.merge_commit_sha = merge;
  await f.automation.reconcile(); await f.automation.reconcile();
  assert.equal((await f.store.listVerifiedDeployments("nodewarden", "1.0.0")).length, 1);
  assert.deepEqual(f.merges, []);
});

test("stable opens only after 100 distinct eligible successes and the observation window", async () => {
  const f = await fixture(); await f.store.putRollout({ ...f.rollout, phase: "early" });
  for (let i = 0; i < 100; i++) {
    await f.store.putRepository({ ...f.repository, repo: `app-${i}`, channel: "early" });
    if (i < 99) await f.store.putVerifiedDeployment("nodewarden", observation(`octo/app-${i}`, i + 1));
  }
  assert.equal((await reconcileRollout(f.store, "nodewarden", "1.0.0", new Date("2026-08-01T00:00:12Z")))!.phase, "early");
  await f.store.putVerifiedDeployment("nodewarden", observation("octo/app-99", 100));
  assert.equal((await reconcileRollout(f.store, "nodewarden", "1.0.0", new Date(finished)))!.phase, "early");
  assert.equal((await reconcileRollout(f.store, "nodewarden", "1.0.0", new Date("2026-08-01T00:00:12Z")))!.phase, "stable");
});

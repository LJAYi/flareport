import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { prepareTemplateRelease, publishTemplateRelease } from "../src/template-release.ts";
import { artifactDigest, VERSION_FILES } from "../apps/github-bot/src/index.ts";
import { activateRelease, latestAutomaticReleases, versionFilesForRepository } from "../apps/github-bot/src/release.ts";
import { UpdateOrchestrator } from "../apps/github-bot/src/orchestrator.ts";
import { GitHubClient, type UpdatePullRequestInput, type CheckRun, type UpdatePull } from "../apps/github-bot/src/github.ts";
import { MemoryStateStore } from "../apps/github-bot/src/store.ts";
import { createWorker } from "../apps/github-bot/src/worker.ts";
import { hmacSha256 } from "../apps/github-bot/src/crypto.ts";

const root = resolve(import.meta.dirname, "..");
const env = { ADMIN_TOKEN: "test-admin", ARTIFACT_TOKEN: "test-publisher", WEBHOOK_SECRET: "test-hook", APP_ID: "1234" };
const base = "b".repeat(40), head = "c".repeat(40), merged = "d".repeat(40);

async function fixture() {
  const artifact = await prepareTemplateRelease(root, "nodewarden");
  const metadata = JSON.parse(artifact.files.find(file => file.path === "flareport.json")!.content);
  const pkg = JSON.parse(artifact.files.find(file => file.path === "package.json")!.content);
  metadata.adapter.version = pkg.version = "0.1.0";
  metadata.management.autoMergeAllowed = false;
  metadata.management.sourceRef = "user-selected-ref";
  pkg.description = "personal setting";
  const store = new MemoryStateStore();
  const calls: UpdatePullRequestInput[] = [];
  const checks: CheckRun[] = [];
  const pulls = new Map<string, UpdatePull>();
  const client = {
    async getRepository() { return { default_branch: "main", allow_auto_merge: false }; },
    async getBranch() { return { protected: false, commit: { sha: base } }; },
    async readJsonFile(_owner: string, _repo: string, path: string, sha: string) {
      assert.equal(sha, base);
      return structuredClone(path === "flareport.json" ? metadata : pkg);
    },
    async createUpdatePullRequest(input: UpdatePullRequestInput) {
      calls.push(input);
      const pull: UpdatePull = { number: calls.length, node_id: `PR_${calls.length}`, html_url: `https://github.test/${input.repo}/pull/${calls.length}`,
        state: "open", draft: false, merged: false, merge_commit_sha: null, mergeable_state: "clean",
        head: { sha: head, ref: input.branch, repo: { full_name: `${input.owner}/${input.repo}` } },
        base: { sha: base, ref: "main", repo: { full_name: `${input.owner}/${input.repo}` } } };
      pulls.set(input.repo, pull);
      return { ...pull, headSha: head };
    },
    async publishArtifactCheck() {},
    async getPull(_owner: string, repo: string) { return structuredClone(pulls.get(repo)!); },
    async getCheck(_owner: string, _repo: string, id: number) { return structuredClone(checks.find(check => check.id === id)!); },
    async pullsForCommit(_owner: string, repo: string) { return [{ number: pulls.get(repo)!.number }]; },
    async checksForCommit() { return []; },
    async mergeExactPull() { throw new Error("A test must never merge without opt-in"); },
  } as unknown as GitHubClient;
  const clients = { async forInstallation(id: number) { assert.equal(id, 42); return client; } };
  const worker = createWorker(store, { githubClientFactory: clients });
  const fetcher: typeof fetch = async (url, init) => worker.fetch(new Request(url, init), env);
  await store.putInstallation({ installationId: 42, account: "octo", active: true, updatedAt: new Date().toISOString() });
  async function register(repo: string, channel: "canary" | "early" | "stable", mode: "manual" | "staged-auto" = "staged-auto") {
    await store.putRepository({ owner: "octo", repo, template: artifact.template, installationId: 42, channel, mode, enabled: true,
      deploymentCheck: `Workers Builds: ${repo}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  return { artifact, metadata, pkg, store, calls, checks, pulls, client, clients, worker, fetcher, register };
}

test("both public templates produce deterministic version-only release artifacts", async () => {
  for (const id of ["nodewarden", "open-connector"]) {
    const artifact = await prepareTemplateRelease(root, id);
    assert.deepEqual(artifact.files.map(file => file.path), [...VERSION_FILES]);
    assert.equal(await artifactDigest(artifact), await artifactDigest(await prepareTemplateRelease(root, id)));
    assert.ok(!artifact.files.some(file => /wrangler|\.github|\.env|\.dev.vars|flareport.user/.test(file.path)));
  }
  await assert.rejects(prepareTemplateRelease(root, "../nodewarden"));
});

test("version patch preserves local policy and package settings; mismatches and downgrades fail closed", async () => {
  const f = await fixture();
  const files = versionFilesForRepository(f.artifact, f.metadata, f.pkg)!;
  const metadata = JSON.parse(files.find(file => file.path === "flareport.json")!.content);
  assert.equal(metadata.management.autoMergeAllowed, false);
  assert.equal(metadata.management.sourceRef, "user-selected-ref");
  assert.equal(JSON.parse(files.find(file => file.path === "package.json")!.content).description, "personal setting");
  assert.equal(metadata.adapter.version, f.artifact.version);
  assert.equal(versionFilesForRepository(f.artifact, metadata, f.pkg), undefined);
  assert.equal(versionFilesForRepository(f.artifact, { ...f.metadata, adapter: { id: "nodewarden", version: "99.0.0" } }, f.pkg), undefined);
  assert.throws(() => versionFilesForRepository(f.artifact, f.metadata, { ...f.pkg, scripts: { build: "changed" } }), /manual migration/);
  assert.throws(() => versionFilesForRepository(f.artifact, { ...f.metadata, adapter: { id: "wrong", version: "0.1.0" } }, f.pkg));
});

test("publisher authentication is separate, retries preserve a pause, and unsafe/stale releases cannot activate", async () => {
  const f = await fixture();
  await assert.rejects(publishTemplateRelease(f.artifact, "https://bot.test", env.ADMIN_TOKEN, f.fetcher), /401/);
  const id = await publishTemplateRelease(f.artifact, "https://bot.test", env.ARTIFACT_TOKEN, f.fetcher);
  assert.equal((await f.worker.fetch(new Request(`https://bot.test/api/releases/nodewarden/${f.artifact.version}`, {
    method: "PUT", headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` }, body: JSON.stringify({ artifactId: id }),
  }), env)).status, 401);
  const release = (await f.store.getRollout("nodewarden", f.artifact.version))!;
  assert.equal(release.automaticDispatch, true);
  await f.store.putRollout({ ...release, phase: "paused", pausedReason: "test" });
  assert.equal(await publishTemplateRelease(f.artifact, "https://bot.test", env.ARTIFACT_TOKEN, f.fetcher), id);
  assert.equal((await f.store.getRollout("nodewarden", f.artifact.version))!.phase, "paused");
  await assert.rejects(publishTemplateRelease({ ...f.artifact, releaseNotes: "Different bytes, same adapter version" },
    "https://bot.test", env.ARTIFACT_TOKEN, f.fetcher), /409/);
  assert.equal((await f.store.getRollout("nodewarden", f.artifact.version))!.artifactId, id);
  const unsafe = { ...f.artifact, files: [...f.artifact.files, { path: "wrangler.jsonc", content: "{}" }] };
  await f.store.putArtifact({ ...unsafe, id: "f".repeat(64), contentHash: "f".repeat(64), createdAt: new Date().toISOString() });
  await assert.rejects(activateRelease(f.store, "f".repeat(64)), /four version files/);
  await f.store.putRollout({ ...release, version: "99.0.0", phase: "paused", artifactId: "e".repeat(64) });
  await assert.rejects(activateRelease(f.store, id), /stale/);
  assert.equal(latestAutomaticReleases(await f.store.listRollouts()).get("nodewarden")!.version, "99.0.0");
  for (const origin of ["http://bot.test", "https://token@bot.test", "https://bot.test/path"]) {
    await assert.rejects(publishTemplateRelease(f.artifact, origin, env.ARTIFACT_TOKEN, f.fetcher), /HTTPS origin/);
  }
});

test("scheduled dispatch is opt-in, obeys cohorts, is idempotent and isolates repository failures", async () => {
  const f = await fixture();
  await publishTemplateRelease(f.artifact, "https://bot.test", env.ARTIFACT_TOKEN, f.fetcher);
  await f.register("broken", "canary"); await f.register("canary", "canary"); await f.register("stable", "stable"); await f.register("manual", "stable", "manual");
  const read = f.client.readJsonFile.bind(f.client);
  f.client.readJsonFile = async (...args) => { if (args[1] === "broken") throw new Error("Repository unavailable"); return read(...args); };
  await f.worker.scheduled({}, env);
  assert.equal(f.calls.length, 0);
  await f.worker.scheduled({}, { ...env, AUTO_DISPATCH_ENABLED: "true" });
  assert.deepEqual(f.calls.map(call => call.repo), ["canary", "manual"]);
  for (const call of f.calls) { assert.equal(call.expectedBaseSha, base); assert.deepEqual(call.files.map(file => file.path), [...VERSION_FILES]); }
  await f.worker.scheduled({}, { ...env, AUTO_DISPATCH_ENABLED: "true" });
  assert.equal(f.calls.length, 2);
  const latest = (await f.store.getRollout("nodewarden", f.artifact.version))!;
  await f.store.putRollout({ ...latest, phase: "paused" });
  await f.register("later", "canary");
  await f.worker.scheduled({}, { ...env, AUTO_DISPATCH_ENABLED: "true" });
  assert.equal(f.calls.length, 2);
});

test("publication -> canary PR -> verified deployment -> next cohort PR works without enabling merges", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await fixture();
  await publishTemplateRelease(f.artifact, "https://bot.test", env.ARTIFACT_TOKEN, f.fetcher);
  await f.register("canary", "canary"); await f.register("early", "early"); await f.register("stable", "stable");
  const release = (await f.store.getRollout("nodewarden", f.artifact.version))!;
  const gate = { minimumSuccesses: 1, minimumEvents: 1, observationMs: 0, maximumFailureRate: 0 };
  await f.store.putRollout({ ...release, config: { ...release.config, canary: gate, early: gate } }); // Test-only thresholds.
  const enabled = { ...env, AUTO_DISPATCH_ENABLED: "true" };
  await f.worker.scheduled({}, enabled);
  assert.deepEqual(f.calls.map(call => call.repo), ["canary"]);
  for (const [index, repo] of ["canary", "early"].entries()) {
    t.mock.timers.tick(1000);
    Object.assign(f.pulls.get(repo)!, { merged: true, state: "closed", merge_commit_sha: merged });
    f.checks.push({ id: index + 1, name: `Workers Builds: ${repo}`, head_sha: merged,
      app: { id: 85455, slug: "cloudflare-workers-and-pages" }, status: "completed", conclusion: "success",
      started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
      output: { summary: "Version ID: 11111111-2222-4333-8444-555555555555" } });
    t.mock.timers.tick(1000);
    const body = JSON.stringify({ action: "completed", installation: { id: 42 }, repository: { name: repo, owner: { login: "octo" } }, check_run: { id: index + 1 } });
    assert.equal((await f.worker.fetch(new Request("https://bot.test/webhooks/github", { method: "POST", body,
      headers: { "x-github-event": "check_run", "x-hub-signature-256": `sha256=${await hmacSha256(env.WEBHOOK_SECRET, body)}` } }), env)).status, 202);
    t.mock.timers.tick(1000);
    await f.worker.scheduled({}, enabled);
  }
  assert.equal((await f.store.getRollout("nodewarden", f.artifact.version))!.phase, "stable");
  assert.deepEqual(f.calls.map(call => call.repo), ["canary", "early", "stable"]);
  assert.equal((await f.store.listVerifiedDeployments("nodewarden", f.artifact.version)).length, 2);
});

test("base movement, disabled installations and late policy changes cannot write update branches", async () => {
  const client = new GitHubClient({ async rest<T>(method: string) { assert.equal(method, "GET"); return { object: { sha: "f".repeat(40) } } as T; },
    async graphql<T>(): Promise<T> { throw new Error("Unexpected call"); } });
  await assert.rejects(client.createUpdatePullRequest({ owner: "octo", repo: "app", base: "main", expectedBaseSha: base,
    branch: "flareport/test", title: "test", body: "", files: [] }), /Base changed/);
  const f = await fixture(); await f.register("canary", "canary");
  await publishTemplateRelease(f.artifact, "https://bot.test", env.ARTIFACT_TOKEN, f.fetcher);
  const read = f.client.readJsonFile.bind(f.client);
  f.client.readJsonFile = async (...args) => {
    await f.store.putInstallation({ installationId: 42, account: "octo", active: false, updatedAt: new Date().toISOString() });
    return read(...args);
  };
  const result = await new UpdateOrchestrator(f.store, f.clients).dispatchReleases();
  assert.equal(result[0]!.reason, "dispatch-policy-changed");
  assert.equal(f.calls.length, 0);
});

test("publication workflow validates first and publishes from a separate pinned checkout without upstream execution", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");
  const publisher = workflow.slice(workflow.indexOf("  publish-bot-release:"));
  assert.match(publisher, /needs: \[repository, changed-templates, template-fixtures\]/);
  assert.match(publisher, /github.ref == 'refs\/heads\/main'/);
  assert.match(publisher, /FLAREPORT_BOT_PUBLISH_ENABLED == 'true'/);
  assert.match(publisher, /ref: \$\{\{ github.sha \}\}/);
  assert.match(publisher, /environment: flareport-publishing/);
  assert.match(publisher, /persist-credentials: false/);
  assert.match(publisher, /src\/template-release.ts publish/);
  assert.doesNotMatch(publisher, /npm (?:ci|install|run)|contents: write|ADMIN_TOKEN|pull_request_target/);
  assert.doesNotMatch(workflow.slice(0, workflow.indexOf("  publish-bot-release:")), /ARTIFACT_TOKEN/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { RolloutState, VerifiedDeployment } from "../../apps/github-bot/src/types.ts";
import { D1StateStore, type D1Database, type D1PreparedStatement } from "../../apps/github-bot/src/d1-store.ts";

test("D1 store maps installation rows and emits an upsert", async () => {
  const calls: Array<{ query: string; values: unknown[] }> = [];
  let current: { query: string; values: unknown[] } | undefined;
  const statement: D1PreparedStatement = {
    bind(...values) { current!.values = values; return this; },
    async run() { calls.push(current!); return { success: true }; },
    async first<T>() {
      return { installation_id: 5, account: "octo", active: 1, updated_at: "now" } as T;
    },
    async all<T>() { return { success: true, results: [] as T[] }; },
  };
  const db: D1Database = { prepare(query) { current = { query, values: [] }; return statement; } };
  const store = new D1StateStore(db);
  await store.putInstallation({ installationId: 5, account: "octo", active: true, updatedAt: "now" });
  assert.match(calls[0]!.query, /ON CONFLICT\(installation_id\)/);
  assert.deepEqual(calls[0]!.values, [5, "octo", 1, "now"]);
  assert.deepEqual(await store.getInstallation(5), {
    installationId: 5, account: "octo", active: true, updatedAt: "now",
  });
});

test("real SQLite migrations persist idempotent evidence and atomically invalidate stale rollout decisions", async t => {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  for (const migration of ["0001_initial.sql", "0002_trusted_artifacts.sql", "0003_dispatch_records.sql", "0004_verified_deployments.sql"]) {
    sqlite.exec(await readFile(new URL(`../../apps/github-bot/migrations/${migration}`, import.meta.url), "utf8"));
  }
  const db: D1Database = {
    prepare(query) {
      const statement = sqlite.prepare(query); let values: SQLInputValue[] = [];
      return {
        bind(...input) { values = input as SQLInputValue[]; return this; },
        async run() { const result = statement.run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
        async first<T>() { return (statement.get(...values) as T | undefined) ?? null; },
        async all<T>() { return { success: true, results: statement.all(...values) as T[] }; },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec("COMMIT"); return results; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  const store = new D1StateStore(db);
  const artifactId = "a".repeat(64), upstreamCommit = "b".repeat(40), now = "2026-08-01T00:00:00.000Z";
  await store.putInstallation({ installationId: 1, account: "octo", active: true, updatedAt: now });
  await store.putRepository({ owner: "octo", repo: "app", template: "nodewarden", installationId: 1, mode: "manual", channel: "canary", enabled: true,
    deploymentCheck: "Workers Builds: app", createdAt: now, updatedAt: now });
  assert.equal((await store.getRepository("OCTO", "APP"))!.deploymentCheck, "Workers Builds: app");
  await store.putArtifact({ id: artifactId, contentHash: artifactId, template: "nodewarden", version: "1.0.0", upstreamCommit,
    baseBranch: "main", releaseNotes: "test", files: [], createdAt: now });
  const gate = { minimumSuccesses: 1, minimumEvents: 1, observationMs: 1000, maximumFailureRate: 0.2 };
  const state: RolloutState = { template: "nodewarden", version: "1.0.0", artifactId, upstreamCommit, phase: "canary", phaseStartedAt: now,
    config: { canaryBasisPoints: 100, earlyBasisPoints: 2500, canary: gate, early: gate }, events: [] };
  await store.putRollout(state, true);
  await store.putRollout({ ...state, artifactId: "f".repeat(64) }, true);
  const before = (await store.getRollout("nodewarden", "1.0.0"))!;
  assert.equal(before.artifactId, artifactId);
  const observation: VerifiedDeployment = { repositoryKey: "octo/app", checkRunId: 123, artifactId, version: "1.0.0", upstreamCommit,
    result: "success", mergeSha: "c".repeat(40), startedAt: now, occurredAt: now };
  await store.putVerifiedDeployment("nodewarden", observation); await store.putVerifiedDeployment("nodewarden", observation);
  assert.equal((await store.listVerifiedDeployments("nodewarden", "1.0.0")).length, 1);
  assert.equal(await store.compareAndSetRollout(before, { ...before, phase: "early" }), false);
  const current = (await store.getRollout("nodewarden", "1.0.0"))!;
  assert.equal(current.evidenceRevision, 2);
  assert.equal(await store.compareAndSetRollout(current, { ...current, phase: "early" }), true);
  assert.equal((await store.getRollout("nodewarden", "1.0.0"))!.phase, "early");
  // A failed batch must roll back both the observation and its revision change.
  const revision = (await store.getRollout("nodewarden", "1.0.0"))!.evidenceRevision;
  sqlite.exec("CREATE TRIGGER reject_revision BEFORE UPDATE OF evidence_revision ON rollouts BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
  await assert.rejects(store.putVerifiedDeployment("nodewarden", { ...observation, checkRunId: 124, result: "failure" }), /test rollback/);
  sqlite.exec("DROP TRIGGER reject_revision");
  const reopened = new D1StateStore(db);
  assert.equal((await reopened.listVerifiedDeployments("nodewarden", "1.0.0")).length, 1);
  assert.equal((await reopened.getRollout("nodewarden", "1.0.0"))!.evidenceRevision, revision);
});

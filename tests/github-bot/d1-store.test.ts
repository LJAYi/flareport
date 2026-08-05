import assert from "node:assert/strict";
import test from "node:test";
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

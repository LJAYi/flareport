import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

const originalDirectory = process.cwd();
process.chdir(resolve(import.meta.dirname, ".."));
const { assertOwnedUpdateBranch, mergeWranglerResourceIdentity } = await import("../.github/scripts/flareport-update.mjs");
process.chdir(originalDirectory);

const repository = "owner/deployment";
const branch = "flareport/update-0123456789ab";
const base = "main";
const marker = "<!-- flareport-update:fixture -->";
const existingRef = {
  ref: `refs/heads/${branch}`,
  object: { type: "commit", sha: "b".repeat(40) },
};
const pull = {
  number: 7,
  body: marker,
  user: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
  head: { ref: branch, sha: "b".repeat(40), repo: { full_name: repository } },
  base: { ref: base, sha: "a".repeat(40) },
};
const existingCommit = {
  message: "flareport: update fixture to v2",
  parents: [{ sha: "a".repeat(40) }],
  author: { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" },
  committer: { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" },
};
const files = [{ filename: "flareport.json" }];
const allowedFiles = new Set(["flareport.json"]);

const verify = (overrides = {}) => assertOwnedUpdateBranch({
  existingRef,
  pulls: [pull],
  existingCommit,
  files,
  repository,
  branch,
  base,
  marker,
  allowedFiles,
  ...overrides,
});

test("accepts only the updater-owned branch lineage", () => {
  assert.equal(verify(), pull);
});

test("fails closed on branch squatting or collaborator commits", () => {
  assert.throws(() => verify({ pulls: [] }), /exactly one open updater PR/);
  assert.throws(() => verify({ pulls: [{ ...pull, body: "user branch" }] }), /ownership marker/);
  assert.throws(() => verify({ pulls: [{ ...pull, user: { id: 1, login: "collaborator", type: "User" } }] }), /not created by github-actions/);
  assert.throws(
    () => verify({ existingCommit: { ...existingCommit, parents: [{ sha: "c".repeat(40) }] } }),
    /directly based on the PR base/,
  );
  assert.throws(() => verify({ files: [{ filename: "user-owned.txt" }] }), /outside the managed template set/);
  assert.throws(() => verify({ existingCommit: { ...existingCommit, author: { name: "collaborator" } } }), /not authored by/);
});

test("preserves user-owned Cloudflare resource identities across template updates", () => {
  const current = {
    d1_databases: [{ binding: "DB", database_name: "user-db", database_id: "user-d1-id" }],
    r2_buckets: [{ binding: "TRANSIT_FILES", bucket_name: "user-bucket" }],
  };
  const candidate = {
    d1_databases: [{ binding: "DB", database_name: "catalog-db", migrations_dir: "migrations" }],
    r2_buckets: [{ binding: "TRANSIT_FILES", bucket_name: "catalog-bucket" }],
  };
  assert.deepEqual(mergeWranglerResourceIdentity(current, candidate), {
    d1_databases: [{ binding: "DB", database_name: "user-db", database_id: "user-d1-id", migrations_dir: "migrations" }],
    r2_buckets: [{ binding: "TRANSIT_FILES", bucket_name: "user-bucket" }],
  });
  assert.equal(candidate.d1_databases[0].database_id, undefined, "candidate input must not be mutated");
});

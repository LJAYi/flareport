import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  AdapterValidationError,
  createSyncPlan,
  createUpstreamLock,
  readLock,
  readManifest,
  validateLock,
  validateManifest,
} from "../../packages/adapter-core/src/index.ts";
import { runAdapterCommand } from "../../packages/adapter-core/src/cli.ts";

const commit = "0123456789abcdef0123456789abcdef01234567";
const digest = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "sample-app",
    name: "Sample App",
    description: "A test adapter.",
    adapterVersion: "1.2.3",
    upstream: {
      repository: "example/sample-app",
      release: "v2.0.0",
      commit,
      license: "MIT",
    },
    cloudflare: {
      compatibilityDate: "2026-08-05",
      services: ["workers", "d1"],
      bindings: [{ name: "DB", type: "d1", resourceName: "sample-db", required: true }],
    },
    inputs: [{ name: "TOKEN", type: "secret", scope: "runtime", required: true, description: "Signing token." }],
    updates: { mode: "staged-auto", channel: "stable", source: "github-release", allowPrerelease: false },
    generation: { overlayDirectory: "overlay", preserve: [".flareport/user.json"] },
    ...overrides,
  };
}

function lock(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    adapter: { id: "sample-app", version: "1.2.3" },
    upstream: {
      repository: "example/sample-app",
      release: "v2.0.0",
      commit,
      archiveUrl: `https://github.com/example/sample-app/archive/${commit}.tar.gz`,
      archiveSha256: digest,
    },
    generatedAt: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}

test("validates a complete manifest and matching lock", () => {
  const validManifest = validateManifest(manifest());
  const validLock = validateLock(lock(), validManifest);
  assert.equal(validManifest.id, "sample-app");
  assert.equal(validLock.upstream.commit, commit);
});

test("generates a pinned lock from a validated manifest and verified digest", () => {
  const generated = createUpstreamLock(manifest(), {
    archiveSha256: digest,
    generatedAt: "2026-08-05T01:02:03.000Z",
  });
  assert.equal(generated.upstream.archiveUrl, `https://github.com/example/sample-app/archive/${commit}.tar.gz`);
  assert.equal(generated.adapter.version, "1.2.3");
  assert.equal(generated.generatedAt, "2026-08-05T01:02:03.000Z");
});

test("rejects floating refs, secret defaults, and unknown keys", () => {
  const candidate = manifest({
    unexpected: true,
    upstream: { repository: "example/sample-app", release: "main", commit: "abc", license: "MIT" },
    inputs: [{ name: "TOKEN", type: "secret", scope: "runtime", required: true, description: "Secret", default: "leak" }],
  });
  assert.throws(
    () => validateManifest(candidate),
    (error: unknown) => error instanceof AdapterValidationError
      && error.issues.some((issue) => issue.includes("floating ref"))
      && error.issues.some((issue) => issue.includes("forbidden for secrets"))
      && error.issues.some((issue) => issue.includes("unexpected")),
  );
});

test("accepts a schema hint but rejects a non-string schema hint", () => {
  assert.equal(validateManifest({ ...manifest(), $schema: "../../schemas/adapter-manifest.schema.json" }).id, "sample-app");
  assert.throws(() => validateManifest({ ...manifest(), $schema: 1 }), /\$\.\$schema must be a string/);
  assert.throws(() => validateLock({ ...lock(), $schema: false }), /\$\.\$schema must be a string/);
});

test("rejects traversal in adapter-controlled paths", () => {
  const candidate = manifest({ generation: { overlayDirectory: "../outside", preserve: ["safe"] } });
  assert.throws(() => validateManifest(candidate), /unsafe path segment/);
});

test("rejects archive URLs not pinned to the locked repository and commit", () => {
  const validManifest = validateManifest(manifest());
  const candidate = lock({
    upstream: {
      ...(lock().upstream as object),
      archiveUrl: "https://attacker.invalid/source.tar.gz",
    },
  });
  assert.throws(() => validateLock(candidate, validManifest), /pinned GitHub commit archive URL/);
});

test("rejects a lock that does not match its manifest", () => {
  const validManifest = validateManifest(manifest());
  const candidate = lock({ adapter: { id: "other-app", version: "1.2.3" } });
  assert.throws(() => validateLock(candidate, validManifest), /does not match manifest id/);
});

test("creates a deterministic, checksum-enforced sync plan", () => {
  const adapterDirectory = resolve("/tmp/adapters/sample-app");
  const outputDirectory = resolve("/tmp/templates/sample-app");
  const plan = createSyncPlan(manifest(), lock(), { adapterDirectory, outputDirectory });
  assert.equal(plan.upstreamCommit, commit);
  assert.deepEqual(plan.preserve, [".flareport/user.json"]);
  assert.deepEqual(plan.steps[0], {
    type: "fetch",
    url: `https://github.com/example/sample-app/archive/${commit}.tar.gz`,
    expectedSha256: digest,
    destination: join(outputDirectory, ".flareport-work", `sample-app-${commit}.tar.gz`),
  });
  assert.equal(plan.steps.at(-1)?.type, "write-metadata");
});

test("reads files and exposes CLI-level validate and plan commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flareport-adapter-"));
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest()));
  await writeFile(join(directory, "upstream.lock.json"), JSON.stringify(lock()));
  const loadedManifest = await readManifest(join(directory, "manifest.json"));
  const loadedLock = await readLock(join(directory, "upstream.lock.json"), loadedManifest);
  assert.equal(loadedLock.adapter.id, loadedManifest.id);

  const output: string[] = [];
  assert.equal(await runAdapterCommand(["validate", directory], { stdout: (line) => output.push(line) }), 0);
  assert.deepEqual(output, ["valid sample-app@1.2.3"]);

  output.length = 0;
  assert.equal(await runAdapterCommand(["plan", directory, join(directory, "generated")], { stdout: (line) => output.push(line) }), 0);
  assert.equal(JSON.parse(output[0]!).upstreamCommit, commit);
});

test("the two MVP example adapters validate", async () => {
  for (const id of ["open-connector", "nodewarden"]) {
    const directory = resolve(import.meta.dirname, `../../adapters/${id}`);
    const loadedManifest = await readManifest(join(directory, "manifest.json"));
    const loadedLock = await readLock(join(directory, "upstream.lock.json"), loadedManifest);
    assert.equal(loadedManifest.id, id);
    assert.equal(loadedLock.adapter.id, id);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { configureExistingResources } from "../scripts/configure-existing-resources.mjs";
import { assertBundleLimits, limits, parseUploadBytes } from "../scripts/validate-cloudflare.mjs";

test("uses uncompressed Worker size and enforces bundle and asset limits", () => {
  assert.equal(parseUploadBytes("Total Upload: 40 MiB / gzip: 4 MiB"), 40 * 1024 * 1024);
  assert.equal(parseUploadBytes("\u001b[32mTotal Upload: 1024.5 KiB\u001b[0m / gzip: 1 KiB"), 1024.5 * 1024);
  assert.throws(() => parseUploadBytes("gzip: 1 MiB"), /uncompressed upload size/);
  assertBundleLimits(limits.workerBytes, [{ path: "max", bytes: limits.assetBytes }]);
  assert.throws(() => assertBundleLimits(limits.workerBytes + 1, []), /Worker uncompressed/);
  assert.throws(() => assertBundleLimits(0, [{ path: "large", bytes: limits.assetBytes + 1 }]), /Asset large/);
  assert.throws(() => assertBundleLimits(0, Array(limits.assetCount + 1).fill({ path: "small", bytes: 1 })), /Asset count/);
});

test("existing resource opt-in is paired, validated, and does not change other settings", () => {
  const config = { name: "my-worker", keep_vars: true, d1_databases: [{ binding: "DB", migrations_dir: "migrations" }], r2_buckets: [{ binding: "TRANSIT_FILES" }] };
  const id = "00000000-0000-0000-0000-000000000001";
  assert.equal(configureExistingResources(config), config);
  const configured = configureExistingResources(config, id, "example-transit");
  assert.equal(configured.name, config.name);
  assert.equal(configured.keep_vars, true);
  assert.deepEqual(configured.d1_databases, [{ binding: "DB", migrations_dir: "migrations", database_id: id }]);
  assert.deepEqual(configured.r2_buckets, [{ binding: "TRANSIT_FILES", bucket_name: "example-transit" }]);
  assert.equal(config.d1_databases[0].database_id, undefined);
  assert.throws(() => configureExistingResources(config, id), /set together/);
  assert.throws(() => configureExistingResources(config, "not-a-uuid", "example-transit"), /UUID/);
  assert.throws(() => configureExistingResources(config, id, "../invalid"), /bucket name/);
  assert.throws(() => configureExistingResources({}, id, "example-transit"), /exactly one/);
});

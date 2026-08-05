import assert from "node:assert/strict";
import test from "node:test";
import { deterministicBucket, hmacSha256, verifyGitHubSignature } from "../../apps/github-bot/src/crypto.ts";

test("verifies GitHub sha256 signatures and rejects malformed values", async () => {
  const signature = `sha256=${await hmacSha256("secret", "payload")}`;
  assert.equal(await verifyGitHubSignature("secret", "payload", signature), true);
  assert.equal(await verifyGitHubSignature("secret", "changed", signature), false);
  assert.equal(await verifyGitHubSignature("secret", "payload", "sha1=bad"), false);
});

test("cohort buckets are deterministic and bounded", () => {
  const first = deterministicBucket("nodewarden:octo/example");
  assert.equal(first, deterministicBucket("nodewarden:octo/example"));
  assert.ok(first >= 0 && first < 10_000);
});

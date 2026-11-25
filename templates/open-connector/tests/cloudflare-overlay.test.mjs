import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { applyCatalogPatch, verifyUpstreamNotices } from "../scripts/apply-cloudflare-overlay.mjs";

test("changed upstream licensing stops an otherwise valid version update", async () => {
  const root = await mkdtemp(join(tmpdir(), "flareport-license-"));
  try {
    for (const directory of ["licenses/open-connector", ".flareport/upstream"]) {
      await mkdir(join(root, directory), { recursive: true });
      for (const name of ["LICENSE.txt", "LICENSE-APACHE-2.0.txt", "NOTICE.md"]) {
        await writeFile(join(root, directory, name), `Reviewed ${name}\n`);
      }
    }
    await verifyUpstreamNotices(root);
    await writeFile(join(root, ".flareport/upstream/LICENSE.txt"), "Different license\n");
    await assert.rejects(verifyUpstreamNotices(root), /LICENSE.txt changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("overlay applies inside a parent repository and fails closed on a conflicting source", async () => {
  const root = await mkdtemp(join(tmpdir(), "flareport-overlay-"));
  try {
    await promisify(execFileCallback)("git", ["init", "--quiet", root]);
    const directory = join(root, ".flareport/upstream");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "source.txt"), "before\n");
    const patch = join(root, "fixture.patch");
    await writeFile(patch, "diff --git a/source.txt b/source.txt\n--- a/source.txt\n+++ b/source.txt\n@@ -1 +1 @@\n-before\n+after\n");
    await applyCatalogPatch(directory, patch);
    assert.equal(await readFile(join(directory, "source.txt"), "utf8"), "after\n");
    await assert.rejects(applyCatalogPatch(directory, patch), /patch does not apply/);
    assert.equal(await readFile(join(directory, "source.txt"), "utf8"), "after\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { assertSafeArchiveEntry, extractVerifiedArchive } from "../scripts/prepare-upstream.mjs";

const execFile = promisify(execFileCallback);

test("rejects archive traversal", () => {
  assert.throws(() => assertSafeArchiveEntry("project/../escape"), /Unsafe archive entry/);
});

test("verifies and safely extracts a local archive fixture", async () => {
  const root = await mkdtemp(join(tmpdir(), "flareport-prepare-"));
  try {
    const source = join(root, "source");
    const destination = join(root, "destination");
    await execFile("mkdir", ["-p", join(source, "project")]);
    await writeFile(join(source, "project", "package.json"), "{\"name\":\"fixture\"}\n");
    const archivePath = join(root, "fixture.tar.gz");
    await execFile("tar", ["--format=ustar", "-czf", archivePath, "-C", source, "project"]);
    const bytes = await readFile(archivePath);
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    await extractVerifiedArchive({ archivePath, destination, expectedSha256 });
    assert.equal(JSON.parse(await readFile(join(destination, "package.json"), "utf8")).name, "fixture");
    await writeFile(join(destination, "package.json"), "tampered\n");
    await extractVerifiedArchive({ archivePath, destination, expectedSha256 });
    assert.equal(JSON.parse(await readFile(join(destination, "package.json"), "utf8")).name, "fixture", "every extraction must rebuild a clean tree");
    await assert.rejects(
      extractVerifiedArchive({ archivePath, destination, expectedSha256: "0".repeat(64) }),
      /SHA-256 mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects links and enforces archive resource limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "flareport-unsafe-archive-"));
  try {
    const source = join(root, "source");
    await execFile("mkdir", ["-p", join(source, "project")]);
    await writeFile(join(source, "project", "package.json"), "{\"name\":\"fixture\"}\n");
    await symlink("../../outside", join(source, "project", "link"));
    const linkedArchive = join(root, "linked.tar.gz");
    await execFile("tar", ["--format=ustar", "-czf", linkedArchive, "-C", source, "project"]);
    const linkedDigest = createHash("sha256").update(await readFile(linkedArchive)).digest("hex");
    await assert.rejects(
      extractVerifiedArchive({ archivePath: linkedArchive, destination: join(root, "linked-output"), expectedSha256: linkedDigest }),
      /links and special files are forbidden/,
    );

    await rm(join(source, "project", "link"));
    const regularArchive = join(root, "regular.tar.gz");
    await execFile("tar", ["--format=ustar", "-czf", regularArchive, "-C", source, "project"]);
    const regularDigest = createHash("sha256").update(await readFile(regularArchive)).digest("hex");
    const baseLimits = { compressedBytes: 1024 * 1024, entries: 100, expandedBytes: 1024 * 1024 };
    await assert.rejects(
      extractVerifiedArchive({ archivePath: regularArchive, destination: join(root, "member-output"), expectedSha256: regularDigest, limits: { ...baseLimits, entries: 1 } }),
      /member limit/,
    );
    await assert.rejects(
      extractVerifiedArchive({ archivePath: regularArchive, destination: join(root, "size-output"), expectedSha256: regularDigest, limits: { ...baseLimits, expandedBytes: 1 } }),
      /expanded size limit/,
    );
    await assert.rejects(
      extractVerifiedArchive({ archivePath: regularArchive, destination: join(root, "compressed-output"), expectedSha256: regularDigest, limits: { ...baseLimits, compressedBytes: 1 } }),
      /compressed size limit/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

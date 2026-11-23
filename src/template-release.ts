import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readLock, readManifest } from "../packages/adapter-core/src/index.ts";
import { artifactDigest, VERSION_FILES, validateVersionRelease, type ArtifactPayload } from "../apps/github-bot/src/index.ts";

/** Reads reviewed template bytes only; never runs upstream code or includes user configuration. */
export async function prepareTemplateRelease(root: string, id: string): Promise<ArtifactPayload> {
  assert.match(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  const template = resolve(root, "templates", id);
  assert.ok((await lstat(template)).isDirectory(), "Template directory cannot be a symlink");
  const manifest = await readManifest(resolve(root, "adapters", id, "manifest.json"));
  const lock = await readLock(resolve(template, "upstream.lock.json"), manifest);
  const adapterLock = await readLock(resolve(root, "adapters", id, "upstream.lock.json"), manifest);
  assert.deepEqual(lock.adapter, adapterLock.adapter);
  assert.deepEqual(lock.upstream, adapterLock.upstream);
  assert.equal(lock.generatedAt, adapterLock.generatedAt);
  const files = [];
  for (const path of VERSION_FILES) {
    const info = await lstat(resolve(template, path));
    assert.ok(info.isFile() && info.size <= 256_000, "Release files must be bounded regular files");
    files.push({ path, content: await readFile(resolve(template, path), "utf8") });
  }
  const artifact: ArtifactPayload = { template: id, version: manifest.adapterVersion, upstreamCommit: manifest.upstream.commit,
    baseBranch: "main", files,
    releaseNotes: `FlarePort adapter ${manifest.adapterVersion}; upstream ${manifest.upstream.release}.\n\nPinned source: https://github.com/${manifest.upstream.repository}/commit/${manifest.upstream.commit}\nArchive SHA-256: ${lock.upstream.archiveSha256}\n\nVersion-only update. User settings and deployment resources are preserved. Review upstream migration notes before merging.` };
  validateVersionRelease(artifact);
  return artifact;
}

export async function publishTemplateRelease(artifact: ArtifactPayload, origin: string, token: string, fetcher = fetch): Promise<string> {
  const url = new URL(origin);
  assert.ok(url.protocol === "https:" && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash,
    "Bot URL must be an HTTPS origin without credentials, path, or query");
  assert.ok(token, "FLAREPORT_ARTIFACT_TOKEN is required");
  validateVersionRelease(artifact);
  const id = await artifactDigest(artifact);
  for (const [path, body] of [
    [`/api/artifacts/${id}`, { ...artifact, contentHash: id }],
    [`/api/releases/${artifact.template}/${artifact.version}`, { artifactId: id }],
  ] as const) {
    const response = await fetcher(url.origin + path, { method: "PUT", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.ok(response.ok, `Release publication failed: HTTP ${response.status}`);
    await response.body?.cancel();
  }
  return id;
}

async function main(): Promise<void> {
  const [command, id] = process.argv.slice(2);
  assert.ok(id && ["prepare", "publish"].includes(command ?? ""), "Usage: template-release.ts <prepare|publish> <adapter>");
  if (command === "publish") {
    assert.equal(process.env.GITHUB_REF, "refs/heads/main", "Only a reviewed main-branch checkout may publish");
    assert.match(process.env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/);
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), process.env.GITHUB_SHA);
  }
  const artifact = await prepareTemplateRelease(process.cwd(), id);
  if (command === "prepare") console.log(JSON.stringify({ artifactId: await artifactDigest(artifact), artifact }, null, 2));
  else console.log(`Published ${artifact.template}@${artifact.version}: ${await publishTemplateRelease(artifact,
    process.env.FLAREPORT_BOT_URL ?? "", process.env.FLAREPORT_ARTIFACT_TOKEN ?? "")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

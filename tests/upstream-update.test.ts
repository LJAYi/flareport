import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { readManifest } from "../packages/adapter-core/src/index.ts";
import { archiveDigest, candidatePaths, digest, generateCandidate, latestRelease, proposeCandidate, verifyCandidate } from "../src/upstream-update.ts";

const root = resolve(import.meta.dirname, "..");
const baseSha = "a".repeat(40);
const newSha = "b".repeat(40);
const publishedAt = "2026-11-21T10:54:25Z";
const manifest = await readManifest(resolve(root, "adapters/nodewarden/manifest.json"));
const release = { release: "v99.0.0", commit: newSha, publishedAt };
const prepared = await generateCandidate(root, "nodewarden", baseSha, release, "c".repeat(64));
const contents = JSON.stringify(prepared, null, 2) + "\n";
const hash = digest(contents);

function releaseApi(overrides: Record<string, unknown> = {}, tagSha = newSha, status = "ahead") {
  const paths: string[] = [];
  return { paths, api: async (path: string) => {
    paths.push(path);
    if (path.endsWith("/releases/latest")) return { tag_name: release.release, draft: false, prerelease: false, published_at: publishedAt, ...overrides };
    if (path.includes("/git/ref/tags/")) return { object: { type: "tag", sha: "d".repeat(40) } };
    if (path.includes("/git/tags/")) return { object: { type: "commit", sha: tagSha } };
    if (path.includes("/compare/")) return { status };
    throw new Error(`Unexpected API call: ${path}`);
  } };
}

test("stable discovery peels annotated tags and checks ancestry with immutable SHAs", async () => {
  const { api, paths } = releaseApi();
  assert.deepEqual(await latestRelease(manifest, api), release);
  assert.ok(paths.includes(`/repos/${manifest.upstream.repository}/compare/${manifest.upstream.commit}...${newSha}`));
  assert.ok(paths.every(path => !path.includes("/commits/main")));
});

test("current releases are no-ops, moved tags, downgrades, divergent releases and prereleases fail closed", async () => {
  assert.equal(await latestRelease(manifest, releaseApi({ tag_name: manifest.upstream.release }, manifest.upstream.commit).api), null);
  await assert.rejects(latestRelease(manifest, releaseApi({ tag_name: manifest.upstream.release }).api), /tag moved/);
  await assert.rejects(latestRelease(manifest, releaseApi({ tag_name: "v0.0.1" }).api), /downgrade/);
  await assert.rejects(latestRelease(manifest, releaseApi({}, newSha, "diverged").api), /descended/);
  await assert.rejects(latestRelease(manifest, releaseApi({ prerelease: true }).api));
  await assert.rejects(latestRelease(manifest, releaseApi({ draft: true }).api));
  await assert.rejects(latestRelease(manifest, releaseApi({ tag_name: "v99.0.0-rc.1" }).api), /stable/);
  await assert.rejects(latestRelease(manifest, releaseApi({ tag_name: "main" }).api), /stable/);
  await assert.rejects(latestRelease(manifest, releaseApi({}, "main").api));
  await assert.rejects(latestRelease(manifest, releaseApi({ published_at: null }).api), /timestamp/);
});

test("archive hashing is bounded and never sends the GitHub credential", async () => {
  const fetcher = (async (_url, options) => {
    assert.equal(options?.headers, undefined);
    return new Response("archive");
  }) as typeof fetch;
  assert.equal(await archiveDigest("https://github.com/example/repo/archive/commit.tar.gz", fetcher), digest("archive"));
  await assert.rejects(archiveDigest("https://github.com/example/repo/archive/commit.tar.gz", fetcher, 2), /size limit/);
  await assert.rejects(archiveDigest("https://github.com/example/repo/archive/commit.tar.gz", (async () => new Response("", { status: 404 })) as typeof fetch), /download failed/);
});

test("generation changes only six version files and preserves template settings, license and scripts", async () => {
  assert.deepEqual(Object.keys(prepared.files), candidatePaths("nodewarden"));
  const nextManifest = JSON.parse(prepared.files["adapters/nodewarden/manifest.json"]!);
  assert.deepEqual(nextManifest.cloudflare, manifest.cloudflare);
  assert.deepEqual(nextManifest.inputs, manifest.inputs);
  assert.deepEqual(nextManifest.updates, manifest.updates);
  assert.equal(nextManifest.upstream.license, manifest.upstream.license);
  const metadata = JSON.parse(prepared.files["templates/nodewarden/flareport.json"]!);
  const oldMetadata = JSON.parse(await readFile(resolve(root, "templates/nodewarden/flareport.json"), "utf8"));
  assert.deepEqual(metadata.management, oldMetadata.management);
  assert.deepEqual(metadata.managedFiles, oldMetadata.managedFiles);
  const nextPackage = JSON.parse(prepared.files["templates/nodewarden/package.json"]!);
  const oldPackage = JSON.parse(await readFile(resolve(root, "templates/nodewarden/package.json"), "utf8"));
  assert.deepEqual({ ...nextPackage, version: oldPackage.version }, oldPackage);
  assert.match(prepared.files["templates/nodewarden/UPSTREAM.md"]!, /LGPL-3.0/);
  assert.deepEqual(await generateCandidate(root, "nodewarden", baseSha, release, "c".repeat(64)), prepared, "Candidate bytes must be repeatable");
});

test("writer rejects changed bytes, mismatched adapter/base and out-of-scope files", () => {
  assert.deepEqual(verifyCandidate(contents, hash, "nodewarden", baseSha), prepared);
  assert.throws(() => verifyCandidate(contents + " ", hash, "nodewarden", baseSha), /hash/);
  assert.throws(() => verifyCandidate(contents, hash, "open-connector", baseSha));
  assert.throws(() => verifyCandidate(contents, hash, "nodewarden", newSha), /base commit/);
  for (const path of [".github/workflows/ci.yml", "../secret", "templates/nodewarden/wrangler.jsonc"]) {
    const changed = JSON.stringify({ ...prepared, files: { ...prepared.files, [path]: "evil" } });
    assert.throws(() => verifyCandidate(changed, digest(changed), "nodewarden", baseSha), /file set/);
  }
  assert.throws(() => candidatePaths("../nodewarden"));
});

function publisher(existing: unknown[] = [], base = baseSha) {
  const calls: Array<{ path: string; body: any }> = [];
  const repo = "/repos/example/flareport";
  return { calls, api: async (path: string, body?: unknown) => {
    calls.push({ path, body });
    if (path === repo) return { default_branch: "main" };
    if (path.includes("/git/ref/heads/")) return { object: { sha: base } };
    if (path === `${repo}/git/commits/${baseSha}`) return { tree: { sha: "e".repeat(40) } };
    if (path.includes("/pulls?")) return existing;
    if (path.endsWith("/git/trees")) return { sha: "f".repeat(40) };
    if (path.endsWith("/git/commits")) return { sha: newSha };
    if (path.endsWith("/git/refs") || path.endsWith("/check-runs")) return {};
    if (path.endsWith("/pulls")) return { html_url: "https://github.com/example/flareport/pull/1" };
    throw new Error(`Unexpected API call: ${path}`);
  } };
}
const runUrl = "https://github.com/example/flareport/actions/runs/123";

test("publisher creates one immutable tree and PR with an exact-head validation Check, never auto-merges", async () => {
  const { api, calls } = publisher();
  assert.equal(await proposeCandidate(prepared, hash, "example/flareport", runUrl, api), "https://github.com/example/flareport/pull/1");
  assert.deepEqual(calls.find(call => call.path.endsWith("/git/trees"))!.body.tree.map((item: any) => item.path), candidatePaths("nodewarden"));
  const check = calls.find(call => call.path.endsWith("/check-runs"))!.body;
  assert.equal(check.head_sha, newSha);
  assert.equal(check.external_id, hash);
  assert.match(check.output.summary, /live deployment and data migration are not claimed/);
  assert.ok(calls.every(call => !call.path.includes("graphql") && !call.body?.force));
});

test("publisher safely reuses an exact PR and rejects stale bases, occupied or edited PRs", async () => {
  const pull = { state: "open", user: { login: "github-actions[bot]", id: 41898282 }, head: { sha: newSha, repo: { full_name: "example/flareport" } }, body: `<!-- flareport-upstream:${hash} -->`, html_url: "https://github.com/example/flareport/pull/1" };
  const reusable = publisher([pull]);
  await proposeCandidate(prepared, hash, "example/flareport", runUrl, reusable.api);
  assert.ok(reusable.calls.every(call => !call.path.endsWith("/git/refs") && !call.path.endsWith("/pulls")));
  const stale = publisher([], newSha);
  await assert.rejects(proposeCandidate(prepared, hash, "example/flareport", runUrl, stale.api), /Default branch moved/);
  assert.ok(stale.calls.every(call => call.body === undefined));
  for (const changed of [{ ...pull, state: "closed" }, { ...pull, body: "not ours" }, { ...pull, head: { ...pull.head, sha: baseSha } }, { ...pull, user: { login: "someone", id: 1 } }]) {
    const occupied = publisher([changed]);
    await assert.rejects(proposeCandidate(prepared, hash, "example/flareport", runUrl, occupied.api));
    assert.ok(occupied.calls.every(call => !call.path.endsWith("/git/refs") && !call.path.endsWith("/check-runs")));
  }
});

test("workflow isolates preparation, untrusted validation and credentialed publication", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/upstream-project.yml"), "utf8");
  const validation = workflow.split("  validate:")[1]!.split("  propose:")[0]!;
  assert.doesNotMatch(validation, /secrets\.|GITHUB_TOKEN|contents: write|pull-requests: write/);
  assert.match(validation, /needs\.prepare\.outputs\.hash/);
  assert.match(workflow, /needs: \[prepare, validate\]/);
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 3);
  const publication = workflow.split("  propose:")[1]!;
  assert.doesNotMatch(publication, /npm |upstream-update\.ts apply/);
  assert.match(publication, /needs\.prepare\.outputs\.artifact/);
  assert.match(publication, /needs\.prepare\.outputs\.hash/);
});

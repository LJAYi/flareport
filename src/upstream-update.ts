import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, lstat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createUpstreamLock, readLock, readManifest, validateLock, validateManifest, type AdapterManifest } from "../packages/adapter-core/src/index.ts";

const shaPattern = /^[0-9a-f]{40}$/;
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
export const digest = (contents: string) => createHash("sha256").update(contents).digest("hex");
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

// Only GitHub's API receives credentials; archive downloads are always anonymous.
export async function github(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(`https://api.github.com${path}`, {
    method, redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: {
      accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
  return response.json();
}

function version(value: string): number[] {
  assert.match(value, /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Only stable x.y.z releases are supported");
  const parts = value.replace(/^v/, "").split(".").map(Number);
  assert.ok(parts.every(Number.isSafeInteger), "Version component exceeds safe integer range");
  return parts;
}

export async function latestRelease(manifest: AdapterManifest, api = github) {
  assert.equal(manifest.updates.source, "github-release", "This updater supports GitHub releases only");
  assert.equal(manifest.updates.allowPrerelease, false, "Prerelease tracking requires a separate reviewed policy");
  const repo = `/repos/${manifest.upstream.repository}`;
  const release = await api(`${repo}/releases/latest`);
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, false);
  const next = version(release.tag_name);
  const current = version(manifest.upstream.release);
  const delta = next.map((part, index) => part - current[index]!).find((part) => part !== 0) ?? 0;
  assert.ok(delta >= 0, "Refusing an upstream downgrade");
  assert.ok(typeof release.published_at === "string" && Number.isFinite(Date.parse(release.published_at)), "Missing release timestamp");
  let object = (await api(`${repo}/git/ref/tags/${encodeURIComponent(release.tag_name)}`)).object;
  for (let depth = 0; object?.type === "tag" && depth < 5; depth++) {
    assert.match(object.sha, shaPattern);
    object = (await api(`${repo}/git/tags/${object.sha}`)).object;
  }
  assert.equal(object?.type, "commit", "Release tag must resolve to a commit");
  assert.match(object.sha, shaPattern);
  if (delta === 0) {
    assert.equal(object.sha, manifest.upstream.commit, "An existing release tag moved; manual investigation required");
    return null;
  }
  const comparison = await api(`${repo}/compare/${manifest.upstream.commit}...${object.sha}`);
  assert.ok(["ahead", "identical"].includes(comparison.status), "Release is not descended from the locked upstream commit");
  return { release: release.tag_name as string, commit: object.sha as string, publishedAt: release.published_at as string };
}

export async function archiveDigest(url: string, fetcher = fetch, limit = 128 * 1024 * 1024): Promise<string> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(120_000) });
  assert.ok(response.ok && response.body, `Archive download failed: HTTP ${response.status}`);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    assert.ok(bytes <= limit, "Archive exceeds compressed size limit");
    hash.update(chunk);
  }
  assert.ok(bytes > 0, "Empty upstream archive");
  return hash.digest("hex");
}

export function candidatePaths(id: string): string[] {
  assert.match(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  return [
    `adapters/${id}/manifest.json`, `adapters/${id}/upstream.lock.json`,
    ...["upstream.lock.json", "flareport.json", "package.json", "UPSTREAM.md"].map((file) => `templates/${id}/${file}`),
  ];
}

export interface Candidate {
  schemaVersion: 1;
  adapter: string;
  baseSha: string;
  files: Record<string, string>;
}

export async function generateCandidate(root: string, id: string, baseSha: string,
  release: { release: string; commit: string; publishedAt: string }, archiveSha256: string): Promise<Candidate> {
  const paths = candidatePaths(id);
  assert.match(baseSha, shaPattern);
  const manifest = await readManifest(resolve(root, paths[0]!));
  const oldLock = await readLock(resolve(root, paths[1]!), manifest);
  const templateLock = await readLock(resolve(root, paths[2]!), manifest);
  assert.deepEqual(templateLock.upstream, oldLock.upstream);
  assert.equal(manifest.id, id);
  const parts = version(manifest.adapterVersion);
  parts[2] = parts[2]! + 1;
  const next = validateManifest({ ...manifest, adapterVersion: parts.join("."), upstream: { ...manifest.upstream, release: release.release, commit: release.commit } });
  const lock = createUpstreamLock(next, { archiveSha256, generatedAt: release.publishedAt });
  const metadata = await readJson(resolve(root, paths[3]!));
  const packageJson = await readJson(resolve(root, paths[4]!));
  const attribution = await readFile(resolve(root, paths[5]!), "utf8");
  const oldReference = `release \`${manifest.upstream.release}\` at commit \`${manifest.upstream.commit}\``;
  assert.equal(attribution.split(oldReference).length, 2, "Attribution must contain exactly one current version reference");
  metadata.adapter = lock.adapter;
  metadata.upstream = { repository: lock.upstream.repository, release: lock.upstream.release, commit: lock.upstream.commit, archiveSha256 };
  packageJson.version = next.adapterVersion;
  return { schemaVersion: 1, adapter: id, baseSha, files: {
    [paths[0]!]: json(next),
    [paths[1]!]: json({ $schema: "../../schemas/upstream-lock.schema.json", ...lock }),
    [paths[2]!]: json(lock), [paths[3]!]: json(metadata), [paths[4]!]: json(packageJson),
    [paths[5]!]: attribution.replace(oldReference, `release \`${release.release}\` at commit \`${release.commit}\``),
  } };
}

export function verifyCandidate(contents: string, expectedHash: string, id: string, baseSha: string): Candidate {
  assert.match(expectedHash, /^[0-9a-f]{64}$/);
  assert.equal(digest(contents), expectedHash, "Candidate hash does not match the trusted preparation job");
  assert.ok(Buffer.byteLength(contents) <= 256 * 1024, "Candidate is too large");
  const candidate: Candidate = JSON.parse(contents);
  assert.equal(candidate.schemaVersion, 1);
  assert.equal(candidate.adapter, id);
  assert.match(baseSha, shaPattern);
  assert.equal(candidate.baseSha, baseSha, "Candidate was prepared from another base commit");
  assert.deepEqual(Object.keys(candidate.files).sort(), candidatePaths(id).sort(), "Unexpected candidate file set");
  assert.ok(Object.values(candidate.files).every((content) => typeof content === "string"));
  const manifest = validateManifest(JSON.parse(candidate.files[`adapters/${id}/manifest.json`]!));
  validateLock(JSON.parse(candidate.files[`adapters/${id}/upstream.lock.json`]!), manifest);
  validateLock(JSON.parse(candidate.files[`templates/${id}/upstream.lock.json`]!), manifest);
  return candidate;
}

export async function applyCandidate(root: string, candidate: Candidate): Promise<void> {
  for (const [path, content] of Object.entries(candidate.files)) {
    // Only existing regular files in this reviewed checkout may be replaced.
    assert.ok((await lstat(resolve(root, path))).isFile(), `Not a regular file: ${path}`);
    await writeFile(resolve(root, path), content);
  }
}

export async function proposeCandidate(candidate: Candidate, hash: string, repository: string, runUrl: string, api = github): Promise<string> {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(runUrl, new RegExp(`^https://github\\.com/${repository.replaceAll(".", "\\.")}/actions/runs/[0-9]+$`));
  const repo = `/repos/${repository}`;
  const base = (await api(repo)).default_branch;
  const ref = await api(`${repo}/git/ref/heads/${encodeURIComponent(base)}`);
  assert.equal(ref.object.sha, candidate.baseSha, "Default branch moved; rerun validation on the new base");
  const parent = await api(`${repo}/git/commits/${candidate.baseSha}`);
  const manifest = validateManifest(JSON.parse(candidate.files[`adapters/${candidate.adapter}/manifest.json`]!));
  const lock = validateLock(JSON.parse(candidate.files[`adapters/${candidate.adapter}/upstream.lock.json`]!), manifest);
  const branch = `codex/upstream-${candidate.adapter}-${manifest.upstream.commit.slice(0, 12)}`;
  const marker = `<!-- flareport-upstream:${hash} -->`;
  const existing = await api(`${repo}/pulls?state=all&head=${encodeURIComponent(`${repository.split("/")[0]}:${branch}`)}&base=${encodeURIComponent(base)}&per_page=100`);
  const tree = await api(`${repo}/git/trees`, {
    base_tree: parent.tree.sha,
    tree: Object.entries(candidate.files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })),
  });
  const title = `flareport: update ${candidate.adapter} to ${manifest.upstream.release}`;
  const author = { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com", date: lock.generatedAt };
  const commit = await api(`${repo}/git/commits`, { message: title, tree: tree.sha, parents: [candidate.baseSha], author, committer: author });
  let pull;
  if (existing.length) {
    assert.equal(existing.length, 1, "Multiple PRs occupy the update branch");
    pull = existing[0];
    assert.equal(pull.state, "open", "Update was already closed; manual review required");
    assert.equal(pull.user?.login, "github-actions[bot]");
    assert.equal(pull.user?.id, 41898282);
    assert.equal(pull.head?.repo?.full_name, repository);
    assert.equal(pull.head?.sha, commit.sha, "Existing update branch changed; refusing to overwrite it");
    assert.ok(pull.body?.includes(marker), "Existing PR does not match this sealed candidate");
  } else {
    // An unknown occupied branch is an error. Never force-push or delete user branches.
    await api(`${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
    pull = await api(`${repo}/pulls`, {
      title, head: branch, base,
      body: `${marker}\nUpstream: https://github.com/${manifest.upstream.repository}/releases/tag/${manifest.upstream.release}\n\nPinned commit: \`${manifest.upstream.commit}\`\nArchive SHA-256: \`${lock.upstream.archiveSha256}\`\nAdapter: \`${manifest.adapterVersion}\`\n\n[Validation run](${runUrl}): repository tests, template tests, pinned upstream build and Cloudflare dry-run. This is not a live deployment test.\n\nOnly six version/attribution files change. Review upstream migrations, runtime bindings and compatibility before merging. Automatic merge is not enabled.`,
    });
  }
  await api(`${repo}/check-runs`, {
    name: "FlarePort upstream validation", head_sha: commit.sha, external_id: hash,
    status: "completed", conclusion: "success", details_url: runUrl,
    output: { title: "Pinned upstream candidate validated", summary: `Candidate SHA-256: ${hash}. Build and dry-run passed in ${runUrl}; live deployment and data migration are not claimed.` },
  });
  return pull.html_url;
}

async function main(): Promise<void> {
  const [command, id, file] = process.argv.slice(2);
  assert.ok(id && file, "Usage: upstream-update.ts <prepare|apply|propose> <adapter> <candidate.json>");
  candidatePaths(id);
  const root = process.cwd();
  const baseSha = process.env.GITHUB_SHA ?? "";
  assert.match(baseSha, shaPattern, "GITHUB_SHA must pin the reviewed checkout");
  if (command === "prepare") {
    const manifest = await readManifest(resolve(root, `adapters/${id}/manifest.json`));
    const release = await latestRelease(manifest);
    if (!release) {
      console.log(`${id} is already current`);
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, "available=false\n");
      return;
    }
    const hash = await archiveDigest(`https://github.com/${manifest.upstream.repository}/archive/${release.commit}.tar.gz`);
    const contents = json(await generateCandidate(root, id, baseSha, release, hash));
    await writeFile(file, contents, { flag: "wx" });
    console.log(`${id}: ${manifest.upstream.release} -> ${release.release}; candidate=${digest(contents)}`);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `available=true\nhash=${digest(contents)}\n`);
    return;
  }
  const hash = process.env.FLAREPORT_CANDIDATE_HASH ?? "";
  const candidate = verifyCandidate(await readFile(file, "utf8"), hash, id, baseSha);
  if (command === "apply") await applyCandidate(root, candidate);
  else if (command === "propose") console.log(await proposeCandidate(candidate, hash, process.env.GITHUB_REPOSITORY ?? "", process.env.FLAREPORT_RUN_URL ?? ""));
  else throw new Error("Unknown upstream update command");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

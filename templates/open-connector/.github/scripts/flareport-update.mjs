import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.cwd());
const command = process.argv[2] ?? "check";
const localMetadata = JSON.parse(await readFile(resolve(root, "flareport.json"), "utf8"));
const sourceRepository = process.env.FLAREPORT_SOURCE_REPOSITORY ?? localMetadata.management.sourceRepository;
const sourceRef = process.env.FLAREPORT_SOURCE_REF ?? localMetadata.management.sourceRef;
const candidateRoot = resolve(root, process.env.FLAREPORT_CANDIDATE_DIRECTORY ?? ".flareport-update/candidate");
const token = process.env.GITHUB_TOKEN;

function safePath(base, path) {
  if (typeof path !== "string" || path === "" || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
    throw new Error(`Unsafe managed path: ${String(path)}`);
  }
  if (/^(?:\.dev\.vars|\.env)(?:$|\.)/.test(path) && !path.endsWith(".example")) {
    throw new Error(`Refusing to manage a secret-bearing path: ${path}`);
  }
  const target = resolve(base, path);
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error(`Managed path escaped its root: ${path}`);
  return target;
}

function validateMetadata(value) {
  if (value?.schemaVersion !== 1 || value?.adapter?.id !== localMetadata.adapter.id) throw new Error("Remote template metadata mismatch");
  if (!Array.isArray(value.managedFiles) || new Set(value.managedFiles).size !== value.managedFiles.length) {
    throw new Error("managedFiles must be a unique array");
  }
  if (value.managedFiles.includes("flareport.user.json")) {
    throw new Error("flareport.user.json is user-owned and cannot be centrally managed");
  }
  for (const path of value.managedFiles) safePath(candidateRoot, path);
  if (typeof value.management?.autoMergeAllowed !== "boolean") throw new Error("management.autoMergeAllowed must be boolean");
  return value;
}

async function api(path, init = {}, authenticated = false) {
  if (authenticated && !token) throw new Error("GITHUB_TOKEN is required for repository writes");
  const response = await fetch(path.startsWith("https://") ? path : `https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "flareport-template-updater",
      ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const error = new Error(`GitHub API ${response.status}: ${await response.text()}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function rawAt(commit, path) {
  const response = await fetch(`https://raw.githubusercontent.com/${sourceRepository}/${commit}/templates/${localMetadata.adapter.id}/${path}`);
  if (!response.ok) throw new Error(`Unable to download ${path} at ${commit}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function candidateHash(metadata, base = candidateRoot) {
  const hash = createHash("sha256");
  for (const path of [...metadata.managedFiles].sort()) {
    const contents = await readFile(safePath(base, path));
    hash.update(String(Buffer.byteLength(path)));
    hash.update(":");
    hash.update(path);
    hash.update(":");
    hash.update(String(contents.byteLength));
    hash.update(":");
    hash.update(contents);
  }
  return hash.digest("hex");
}

async function output(name, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  console.log(`${name}=${value}`);
}

async function check() {
  const commitResult = await api(`/repos/${sourceRepository}/commits/${encodeURIComponent(sourceRef)}`);
  const sourceCommit = commitResult.sha;
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error("FlarePort source did not resolve to a full commit SHA");
  const nextMetadata = validateMetadata(JSON.parse(new TextDecoder().decode(await rawAt(sourceCommit, "flareport.json"))));
  const currentKey = `${localMetadata.adapter.version}:${localMetadata.upstream.commit}`;
  const nextKey = `${nextMetadata.adapter.version}:${nextMetadata.upstream.commit}`;
  const updateAvailable = currentKey !== nextKey;
  await output("update_available", String(updateAvailable));
  if (!updateAvailable) {
    console.log(`Already current at ${nextKey}`);
    return;
  }

  const stagingRoot = resolve(candidateRoot, "..");
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(candidateRoot, { recursive: true });
  for (const path of nextMetadata.managedFiles) {
    const target = safePath(candidateRoot, path);
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, await rawAt(sourceCommit, path));
  }
  const hash = await candidateHash(nextMetadata);
  await writeFile(resolve(stagingRoot, "plan.json"), JSON.stringify({
    schemaVersion: 1,
    sourceRepository,
    sourceCommit,
    currentKey,
    nextKey,
    candidateHash: hash,
  }, null, 2) + "\n");
  await output("candidate_hash", hash);
  await output("source_commit", sourceCommit);
  console.log(`Staged verified template metadata ${currentKey} -> ${nextKey}`);
}

async function localUserPolicy() {
  try {
    const value = JSON.parse(await readFile(resolve(root, "flareport.user.json"), "utf8"));
    const keys = Object.keys(value).sort();
    if (value.schemaVersion !== 1 || typeof value.autoMerge !== "boolean" || !Array.isArray(value.requiredChecks) ||
        !value.requiredChecks.every((item) => typeof item === "string" && item.length > 0) ||
        keys.some((key) => !["autoMerge", "requiredChecks", "schemaVersion"].includes(key))) {
      throw new Error("flareport.user.json has an invalid shape");
    }
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: 1, autoMerge: false, requiredChecks: [] };
    throw error;
  }
}

export function assertOwnedUpdateBranch({ existingRef, pulls, existingCommit, files, repository, branch, base, marker, allowedFiles }) {
  if (existingRef?.ref !== `refs/heads/${branch}` || existingRef?.object?.type !== "commit") {
    throw new Error("Existing update ref is not the expected branch commit");
  }
  if (!Array.isArray(pulls) || pulls.length !== 1) throw new Error("Existing update branch is not owned by exactly one open updater PR");
  const pull = pulls[0];
  if (pull.head?.ref !== branch || pull.head?.sha !== existingRef.object.sha || pull.head?.repo?.full_name !== repository || pull.base?.ref !== base) {
    throw new Error("Existing update PR does not match the expected repository lineage");
  }
  if (!String(pull.body ?? "").includes(marker)) throw new Error("Existing update PR lacks the FlarePort ownership marker");
  if (pull.user?.id !== 41898282 || pull.user?.login !== "github-actions[bot]" || pull.user?.type !== "Bot") {
    throw new Error("Existing update PR was not created by github-actions[bot]");
  }
  if (!String(existingCommit?.message ?? "").startsWith("flareport: update ") || existingCommit?.parents?.length !== 1 || existingCommit.parents[0].sha !== pull.base.sha) {
    throw new Error("Existing update branch tip is not an updater commit directly based on the PR base");
  }
  if (existingCommit?.author?.name !== "github-actions[bot]" || existingCommit?.author?.email !== "41898282+github-actions[bot]@users.noreply.github.com" ||
      existingCommit?.committer?.name !== "github-actions[bot]" || existingCommit?.committer?.email !== "41898282+github-actions[bot]@users.noreply.github.com") {
    throw new Error("Existing update branch tip was not authored by the repository updater");
  }
  if (!Array.isArray(files) || files.length > 100 || (pull.changed_files !== undefined && pull.changed_files !== files.length) || files.some((file) => !allowedFiles.has(file.filename))) {
    throw new Error("Existing update PR changes files outside the managed template set");
  }
  return pull;
}

async function apply() {
  const nextMetadata = validateMetadata(JSON.parse(await readFile(resolve(candidateRoot, "flareport.json"), "utf8")));
  const plan = JSON.parse(await readFile(resolve(candidateRoot, "../plan.json"), "utf8"));
  const expectedHash = process.env.FLAREPORT_EXPECTED_CANDIDATE_HASH;
  const sealedCandidateHash = await candidateHash(nextMetadata);
  if (!expectedHash || expectedHash !== plan.candidateHash || expectedHash !== sealedCandidateHash) {
    throw new Error("Candidate artifact hash does not match the read-only validation job");
  }

  // Central metadata is a ceiling only: an update can revoke permission but cannot
  // restore it. The user's opt-in lives outside managedFiles and is never overwritten.
  nextMetadata.management.autoMergeAllowed =
    localMetadata.management.autoMergeAllowed === true && nextMetadata.management.autoMergeAllowed === true;
  await writeFile(resolve(candidateRoot, "flareport.json"), JSON.stringify(nextMetadata, null, 2) + "\n");
  const appliedCandidateHash = await candidateHash(nextMetadata);
  const userPolicy = await localUserPolicy();

  const repository = process.env.GITHUB_REPOSITORY;
  const base = process.env.GITHUB_REF_NAME || "main";
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");
  const baseRef = await api(`/repos/${repository}/git/ref/heads/${base}`, {}, true);
  const baseCommit = await api(`/repos/${repository}/git/commits/${baseRef.object.sha}`, {}, true);
  const tree = [];
  for (const path of nextMetadata.managedFiles) {
    const contents = await readFile(safePath(candidateRoot, path));
    const blob = await api(`/repos/${repository}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: contents.toString("base64"), encoding: "base64" }),
    }, true);
    tree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  }
  for (const path of localMetadata.managedFiles) {
    if (!nextMetadata.managedFiles.includes(path)) tree.push({ path, mode: "100644", type: "blob", sha: null });
  }
  const nextTree = await api(`/repos/${repository}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree }),
  }, true);
  const commit = await api(`/repos/${repository}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: `flareport: update ${localMetadata.adapter.id} to ${nextMetadata.upstream.release}`,
      tree: nextTree.sha,
      parents: [baseRef.object.sha],
      author: { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" },
      committer: { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" },
    }),
  }, true);
  const branch = `flareport/update-${nextMetadata.upstream.commit.slice(0, 12)}`;
  const marker = `<!-- flareport-update:${localMetadata.adapter.id} -->`;
  const owner = repository.split("/")[0];
  const allowedFiles = new Set([...localMetadata.managedFiles, ...nextMetadata.managedFiles]);
  let pull;
  try {
    await api(`/repos/${repository}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
    }, true);
  } catch (error) {
    if (error.status !== 422) throw error;
    const existingRef = await api(`/repos/${repository}/git/ref/heads/${branch}`, {}, true);
    const pulls = await api(`/repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(base)}`, {}, true);
    const existingCommit = await api(`/repos/${repository}/git/commits/${existingRef.object.sha}`, {}, true);
    const files = pulls.length === 1
      ? await api(`/repos/${repository}/pulls/${pulls[0].number}/files?per_page=100`, {}, true)
      : [];
    pull = assertOwnedUpdateBranch({ existingRef, pulls, existingCommit, files, repository, branch, base, marker, allowedFiles });
    await api(`/repos/${repository}/git/refs/heads/${branch}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: commit.sha, force: true }),
    }, true);
  }

  const pullBody = `${marker}\nValidated without write credentials from FlarePort commit \`${plan.sourceCommit}\`.\n\nUpstream: \`${nextMetadata.upstream.repository}@${nextMetadata.upstream.commit}\`\nAdapter: \`${nextMetadata.adapter.version}\`\nSealed candidate SHA-256: \`${sealedCandidateHash}\`\nApplied managed-tree SHA-256: \`${appliedCandidateHash}\``;
  if (pull) {
    pull = await api(`/repos/${repository}/pulls/${pull.number}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: `flareport: update ${localMetadata.adapter.id} to ${nextMetadata.upstream.release}`,
        body: pullBody,
      }),
    }, true);
  } else try {
    pull = await api(`/repos/${repository}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title: `flareport: update ${localMetadata.adapter.id} to ${nextMetadata.upstream.release}`,
        head: branch,
        base,
        body: pullBody,
      }),
    }, true);
  } catch (error) {
    if (error.status !== 422) throw error;
    throw new Error(`Refusing to reuse an unverified existing pull request: ${error.message}`);
  }
  console.log(`Created or updated ${pull.html_url}`);

  if (userPolicy.autoMerge && nextMetadata.management.autoMergeAllowed) {
    let protection;
    try {
      protection = await api(`/repos/${repository}/branches/${encodeURIComponent(base)}/protection/required_status_checks`, {}, true);
    } catch (error) {
      console.warn(`Auto-merge skipped: required-check protection could not be verified (${error.message})`);
      return;
    }
    const contexts = new Set(protection.contexts ?? []);
    if (userPolicy.requiredChecks.length === 0 || userPolicy.requiredChecks.some((check) => !contexts.has(check))) {
      console.warn("Auto-merge skipped: every locally configured required check must be enforced by branch protection");
      return;
    }
    await api("/graphql", {
      method: "POST",
      body: JSON.stringify({
        query: "mutation($id:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:SQUASH}){pullRequest{number}}}",
        variables: { id: pull.node_id },
      }),
    }, true);
    console.log("Enabled auto-merge under the user's local policy and verified branch protection.");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (command === "check") await check();
  else if (command === "apply") await apply();
  else throw new Error("Usage: flareport-update.mjs <check|apply>");
}

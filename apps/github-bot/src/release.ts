import assert from "node:assert/strict";
import type { ArtifactPayload } from "./artifact.ts";
import { DEFAULT_ROLLOUT_CONFIG } from "./rollout.ts";
import type { StateStore } from "./store.ts";
import type { RolloutState } from "./types.ts";

export const VERSION_FILES = ["UPSTREAM.md", "flareport.json", "package.json", "upstream.lock.json"] as const;

export function releaseVersion(value: unknown): number[] {
  assert.ok(typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value), "Invalid adapter release version");
  const parts = value.split(".").map(Number);
  assert.ok(parts.every(Number.isSafeInteger), "Version exceeds safe integer range");
  return parts;
}

export function compareReleaseVersions(left: string, right: string): number {
  const other = releaseVersion(right);
  return releaseVersion(left).map((part, index) => part - other[index]!).find(delta => delta !== 0) ?? 0;
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Expected a JSON object");
  return value as Record<string, unknown>;
}

export function validateVersionRelease(artifact: ArtifactPayload) {
  releaseVersion(artifact.version);
  assert.deepEqual(artifact.files.map(file => file.path).sort(), [...VERSION_FILES], "Automatic releases must contain exactly four version files");
  const read = (path: string) => object(JSON.parse(artifact.files.find(file => file.path === path)!.content));
  const metadata = read("flareport.json"), lock = read("upstream.lock.json"), pkg = read("package.json");
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(lock.schemaVersion, 1);
  for (const value of [metadata, lock]) {
    assert.equal(object(value.adapter).id, artifact.template);
    assert.equal(object(value.adapter).version, artifact.version);
    assert.equal(object(value.upstream).commit, artifact.upstreamCommit);
  }
  const upstream = object(metadata.upstream), locked = object(lock.upstream);
  for (const field of ["repository", "release", "archiveSha256"]) assert.equal(upstream[field], locked[field]);
  assert.match(String(upstream.repository), /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(String(upstream.archiveSha256), /^[a-f0-9]{64}$/);
  assert.match(artifact.upstreamCommit, /^[a-f0-9]{40}$/);
  assert.equal(locked.archiveUrl, `https://github.com/${upstream.repository}/archive/${artifact.upstreamCommit}.tar.gz`);
  assert.equal(typeof object(metadata.management).autoMergeAllowed, "boolean");
  assert.equal(pkg.version, artifact.version);
  return { metadata, pkg };
}

/** Only version fields are replaced. All local settings, including a prior denial, survive. */
export function versionFilesForRepository(artifact: ArtifactPayload, metadataValue: unknown, packageValue: unknown) {
  const target = validateVersionRelease(artifact);
  const current = object(metadataValue), pkg = object(packageValue);
  assert.equal(current.schemaVersion, 1);
  assert.equal(object(current.adapter).id, artifact.template, "Repository belongs to another template");
  assert.equal(object(current.upstream).repository, object(target.metadata.upstream).repository, "Upstream repository changed");
  assert.equal(typeof object(current.management).autoMergeAllowed, "boolean");
  const delta = compareReleaseVersions(artifact.version, String(object(current.adapter).version));
  if (delta <= 0) {
    if (delta === 0) assert.equal(object(current.upstream).commit, artifact.upstreamCommit, "Same version has a different upstream commit");
    return undefined; // Already current or ahead; never downgrade a deployment repository.
  }
  for (const field of ["scripts", "engines", "type", "dependencies", "devDependencies"]) {
    assert.deepEqual(pkg[field], target.pkg[field], `Adapter wiring changed (${field}); manual migration required`);
  }
  const metadata = { ...current, adapter: target.metadata.adapter, upstream: target.metadata.upstream,
    management: { ...object(current.management), autoMergeAllowed:
      object(current.management).autoMergeAllowed === true && object(target.metadata.management).autoMergeAllowed === true } };
  return artifact.files.map(file => ({ ...file, content: file.path === "flareport.json" ? JSON.stringify(metadata, null, 2) + "\n"
    : file.path === "package.json" ? JSON.stringify({ ...pkg, version: artifact.version }, null, 2) + "\n" : file.content }));
}

export function latestAutomaticReleases(states: RolloutState[]): Map<string, RolloutState> {
  const latest = new Map<string, RolloutState>();
  for (const state of states.filter(state => state.automaticDispatch === true)) {
    releaseVersion(state.version);
    const previous = latest.get(state.template);
    if (!previous || compareReleaseVersions(state.version, previous.version) > 0) latest.set(state.template, state);
  }
  return latest; // A paused latest release must never cause fallback to an older one.
}

export async function activateRelease(store: StateStore, artifactId: string): Promise<RolloutState> {
  const artifact = await store.getArtifact(artifactId);
  assert.ok(artifact, "Artifact not found");
  validateVersionRelease(artifact);
  const latest = latestAutomaticReleases(await store.listRollouts()).get(artifact.template);
  assert.ok(!latest || compareReleaseVersions(artifact.version, latest.version) >= 0, "Refusing stale release activation");
  const state: RolloutState = { template: artifact.template, version: artifact.version, artifactId,
    upstreamCommit: artifact.upstreamCommit, automaticDispatch: true, phase: "canary", phaseStartedAt: new Date().toISOString(),
    config: structuredClone(DEFAULT_ROLLOUT_CONFIG), events: [] };
  await store.putRollout(state, true);
  const stored = (await store.getRollout(state.template, state.version))!;
  assert.ok(stored.artifactId === artifactId && stored.automaticDispatch === true, "Release is occupied by a different artifact or manual rollout");
  return stored; // Retrying publication cannot reset a pause, window, or accumulated evidence.
}

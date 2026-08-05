import { AdapterValidationError } from "./errors.ts";
import {
  BINDING_TYPES,
  CLOUDFLARE_SERVICES,
  type AdapterManifest,
  type UpstreamLock,
} from "./types.ts";
import { assertRelativeSafePath } from "./path-safety.ts";

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string";
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(string);
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const envNamePattern = /^[A-Z][A-Z0-9_]*$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], at: string, issues: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${at}.${key} is not allowed`);
  }
}

function requiredString(value: Record<string, unknown>, key: string, at: string, issues: string[]): string | undefined {
  const candidate = value[key];
  if (!string(candidate) || candidate.trim() === "") {
    issues.push(`${at}.${key} must be a non-empty string`);
    return undefined;
  }
  return candidate;
}

export function validateManifest(value: unknown): AdapterManifest {
  const issues: string[] = [];
  if (!object(value)) throw new AdapterValidationError("manifest", ["root must be an object"]);
  exactKeys(value, ["$schema", "schemaVersion", "id", "name", "description", "adapterVersion", "upstream", "cloudflare", "inputs", "updates", "generation"], "$", issues);
  if (value.$schema !== undefined && !string(value.$schema)) issues.push("$.$schema must be a string");

  if (value.schemaVersion !== 1) issues.push("$.schemaVersion must equal 1");
  const id = requiredString(value, "id", "$", issues);
  if (id && !slugPattern.test(id)) issues.push("$.id must be a lowercase kebab-case slug");
  requiredString(value, "name", "$", issues);
  requiredString(value, "description", "$", issues);
  const adapterVersion = requiredString(value, "adapterVersion", "$", issues);
  if (adapterVersion && !semverPattern.test(adapterVersion)) issues.push("$.adapterVersion must be semantic version x.y.z");

  if (!object(value.upstream)) {
    issues.push("$.upstream must be an object");
  } else {
    exactKeys(value.upstream, ["repository", "release", "commit", "sourceSubdirectory", "license"], "$.upstream", issues);
    const repository = requiredString(value.upstream, "repository", "$.upstream", issues);
    if (repository && !repositoryPattern.test(repository)) issues.push("$.upstream.repository must be owner/repository");
    const release = requiredString(value.upstream, "release", "$.upstream", issues);
    if (release && ["latest", "main", "master", "HEAD"].includes(release)) issues.push("$.upstream.release must be immutable, not a floating ref");
    const commit = requiredString(value.upstream, "commit", "$.upstream", issues);
    if (commit && !shaPattern.test(commit)) issues.push("$.upstream.commit must be a lowercase 40-character Git SHA");
    requiredString(value.upstream, "license", "$.upstream", issues);
    if (value.upstream.sourceSubdirectory !== undefined) {
      if (!string(value.upstream.sourceSubdirectory)) issues.push("$.upstream.sourceSubdirectory must be a string");
      else try { assertRelativeSafePath(value.upstream.sourceSubdirectory, "$.upstream.sourceSubdirectory"); } catch (error) { issues.push((error as Error).message); }
    }
  }

  validateCloudflare(value.cloudflare, issues);
  validateInputs(value.inputs, issues);
  validateUpdates(value.updates, issues);
  validateGeneration(value.generation, issues);

  if (issues.length) throw new AdapterValidationError("manifest", issues);
  return value as unknown as AdapterManifest;
}

function validateCloudflare(value: unknown, issues: string[]): void {
  if (!object(value)) { issues.push("$.cloudflare must be an object"); return; }
  exactKeys(value, ["compatibilityDate", "services", "bindings"], "$.cloudflare", issues);
  const compatibilityDate = requiredString(value, "compatibilityDate", "$.cloudflare", issues);
  if (compatibilityDate && !datePattern.test(compatibilityDate)) issues.push("$.cloudflare.compatibilityDate must be YYYY-MM-DD");
  if (!strings(value.services) || value.services.length === 0) issues.push("$.cloudflare.services must be a non-empty string array");
  else {
    if (new Set(value.services).size !== value.services.length) issues.push("$.cloudflare.services must not contain duplicates");
    for (const service of value.services) if (!(CLOUDFLARE_SERVICES as readonly string[]).includes(service)) issues.push(`$.cloudflare.services contains unsupported service ${service}`);
  }
  if (!Array.isArray(value.bindings)) { issues.push("$.cloudflare.bindings must be an array"); return; }
  const names = new Set<string>();
  value.bindings.forEach((binding, index) => {
    const at = `$.cloudflare.bindings[${index}]`;
    if (!object(binding)) { issues.push(`${at} must be an object`); return; }
    exactKeys(binding, ["name", "type", "resourceName", "className", "required"], at, issues);
    const name = requiredString(binding, "name", at, issues);
    if (name && !envNamePattern.test(name)) issues.push(`${at}.name must be an uppercase binding name`);
    if (name && names.has(name)) issues.push(`${at}.name duplicates ${name}`);
    if (name) names.add(name);
    const type = requiredString(binding, "type", at, issues);
    if (type && !(BINDING_TYPES as readonly string[]).includes(type)) issues.push(`${at}.type is unsupported`);
    if (binding.resourceName !== undefined && (!string(binding.resourceName) || binding.resourceName === "")) issues.push(`${at}.resourceName must be a non-empty string`);
    if (binding.className !== undefined && (!string(binding.className) || binding.className === "")) issues.push(`${at}.className must be a non-empty string`);
    if (type === "durable-object" && !string(binding.className)) issues.push(`${at}.className is required for durable-object`);
    if (binding.required !== undefined && typeof binding.required !== "boolean") issues.push(`${at}.required must be boolean`);
  });
}

function validateInputs(value: unknown, issues: string[]): void {
  if (!Array.isArray(value)) { issues.push("$.inputs must be an array"); return; }
  const names = new Set<string>();
  value.forEach((input, index) => {
    const at = `$.inputs[${index}]`;
    if (!object(input)) { issues.push(`${at} must be an object`); return; }
    exactKeys(input, ["name", "type", "scope", "required", "description", "default"], at, issues);
    const name = requiredString(input, "name", at, issues);
    if (name && !envNamePattern.test(name)) issues.push(`${at}.name must be uppercase snake case`);
    if (name && names.has(name)) issues.push(`${at}.name duplicates ${name}`);
    if (name) names.add(name);
    if (!["secret", "text", "url", "email", "boolean", "number"].includes(String(input.type))) issues.push(`${at}.type is unsupported`);
    if (!["runtime", "build"].includes(String(input.scope))) issues.push(`${at}.scope must be runtime or build`);
    if (typeof input.required !== "boolean") issues.push(`${at}.required must be boolean`);
    requiredString(input, "description", at, issues);
    if (input.type === "secret" && input.default !== undefined) issues.push(`${at}.default is forbidden for secrets`);
    if (input.default !== undefined && !["string", "boolean", "number"].includes(typeof input.default)) issues.push(`${at}.default has an unsupported type`);
  });
}

function validateUpdates(value: unknown, issues: string[]): void {
  if (!object(value)) { issues.push("$.updates must be an object"); return; }
  exactKeys(value, ["mode", "channel", "source", "allowPrerelease"], "$.updates", issues);
  if (!["manual", "auto", "staged-auto"].includes(String(value.mode))) issues.push("$.updates.mode is unsupported");
  if (!["manual", "canary", "early", "stable"].includes(String(value.channel))) issues.push("$.updates.channel is unsupported");
  if (!["github-release", "github-tag"].includes(String(value.source))) issues.push("$.updates.source is unsupported");
  if (typeof value.allowPrerelease !== "boolean") issues.push("$.updates.allowPrerelease must be boolean");
  if (value.mode === "manual" && value.channel !== "manual") issues.push("$.updates.channel must be manual when mode is manual");
  if (value.mode !== "manual" && value.channel === "manual") issues.push("$.updates.channel cannot be manual for automatic modes");
}

function validateGeneration(value: unknown, issues: string[]): void {
  if (value === undefined) return;
  if (!object(value)) { issues.push("$.generation must be an object"); return; }
  exactKeys(value, ["overlayDirectory", "preserve"], "$.generation", issues);
  if (value.overlayDirectory !== undefined) {
    if (!string(value.overlayDirectory)) issues.push("$.generation.overlayDirectory must be a string");
    else try { assertRelativeSafePath(value.overlayDirectory, "$.generation.overlayDirectory"); } catch (error) { issues.push((error as Error).message); }
  }
  if (value.preserve !== undefined) {
    if (!strings(value.preserve)) issues.push("$.generation.preserve must be a string array");
    else for (const item of value.preserve) try { assertRelativeSafePath(item, "$.generation.preserve[]"); } catch (error) { issues.push((error as Error).message); }
  }
}

export function validateLock(value: unknown, manifest?: AdapterManifest): UpstreamLock {
  const issues: string[] = [];
  if (!object(value)) throw new AdapterValidationError("lock", ["root must be an object"]);
  exactKeys(value, ["$schema", "schemaVersion", "adapter", "upstream", "generatedAt"], "$", issues);
  if (value.$schema !== undefined && !string(value.$schema)) issues.push("$.$schema must be a string");
  if (value.schemaVersion !== 1) issues.push("$.schemaVersion must equal 1");
  if (!object(value.adapter)) issues.push("$.adapter must be an object");
  else {
    exactKeys(value.adapter, ["id", "version"], "$.adapter", issues);
    requiredString(value.adapter, "id", "$.adapter", issues);
    const version = requiredString(value.adapter, "version", "$.adapter", issues);
    if (version && !semverPattern.test(version)) issues.push("$.adapter.version must be semantic version x.y.z");
  }
  if (!object(value.upstream)) issues.push("$.upstream must be an object");
  else {
    exactKeys(value.upstream, ["repository", "release", "commit", "archiveUrl", "archiveSha256"], "$.upstream", issues);
    const repository = requiredString(value.upstream, "repository", "$.upstream", issues);
    if (repository && !repositoryPattern.test(repository)) issues.push("$.upstream.repository must be owner/repository");
    const release = requiredString(value.upstream, "release", "$.upstream", issues);
    if (release && ["latest", "main", "master", "HEAD"].includes(release)) issues.push("$.upstream.release must be immutable");
    const commit = requiredString(value.upstream, "commit", "$.upstream", issues);
    if (commit && !shaPattern.test(commit)) issues.push("$.upstream.commit must be a lowercase 40-character Git SHA");
    const archiveUrl = requiredString(value.upstream, "archiveUrl", "$.upstream", issues);
    if (archiveUrl && repository && commit && archiveUrl !== `https://github.com/${repository}/archive/${commit}.tar.gz`) issues.push("$.upstream.archiveUrl must be the pinned GitHub commit archive URL");
    const archiveSha256 = requiredString(value.upstream, "archiveSha256", "$.upstream", issues);
    if (archiveSha256 && !sha256Pattern.test(archiveSha256)) issues.push("$.upstream.archiveSha256 must be a lowercase SHA-256 digest");
  }
  const generatedAt = requiredString(value, "generatedAt", "$", issues);
  if (generatedAt && Number.isNaN(Date.parse(generatedAt))) issues.push("$.generatedAt must be an ISO-8601 timestamp");

  if (manifest && object(value.adapter) && object(value.upstream)) {
    if (value.adapter.id !== manifest.id) issues.push("$.adapter.id does not match manifest id");
    if (value.adapter.version !== manifest.adapterVersion) issues.push("$.adapter.version does not match manifest adapterVersion");
    if (value.upstream.repository !== manifest.upstream.repository) issues.push("$.upstream.repository does not match manifest");
    if (value.upstream.release !== manifest.upstream.release) issues.push("$.upstream.release does not match manifest");
    if (value.upstream.commit !== manifest.upstream.commit) issues.push("$.upstream.commit does not match manifest");
  }
  if (issues.length) throw new AdapterValidationError("lock", issues);
  return value as unknown as UpstreamLock;
}

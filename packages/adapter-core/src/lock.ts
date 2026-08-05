import type { AdapterManifest, UpstreamLock } from "./types.ts";
import { validateManifest, validateLock } from "./validate.ts";

export interface CreateUpstreamLockOptions {
  archiveSha256: string;
  generatedAt?: string;
}

/**
 * Creates lock-file data only after the caller has fetched the pinned commit archive
 * and computed its SHA-256. Network access deliberately stays outside adapter-core.
 */
export function createUpstreamLock(
  manifestValue: unknown,
  options: CreateUpstreamLockOptions,
): UpstreamLock {
  const manifest: AdapterManifest = validateManifest(manifestValue);
  const commit = manifest.upstream.commit;
  return validateLock({
    schemaVersion: 1,
    adapter: { id: manifest.id, version: manifest.adapterVersion },
    upstream: {
      repository: manifest.upstream.repository,
      release: manifest.upstream.release,
      commit,
      archiveUrl: `https://github.com/${manifest.upstream.repository}/archive/${commit}.tar.gz`,
      archiveSha256: options.archiveSha256,
    },
    generatedAt: options.generatedAt ?? new Date().toISOString(),
  }, manifest);
}

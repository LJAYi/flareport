import { resolve } from "node:path";
import { assertRelativeSafePath, resolveInside } from "./path-safety.ts";
import type { AdapterManifest, SyncPlan, UpstreamLock } from "./types.ts";
import { validateLock, validateManifest } from "./validate.ts";

export interface CreateSyncPlanOptions {
  adapterDirectory: string;
  outputDirectory: string;
  workDirectory?: string;
}

export function createSyncPlan(
  manifestValue: unknown,
  lockValue: unknown,
  options: CreateSyncPlanOptions,
): SyncPlan {
  const manifest = validateManifest(manifestValue);
  const lock = validateLock(lockValue, manifest);
  const adapterDirectory = resolve(options.adapterDirectory);
  const outputDirectory = resolve(options.outputDirectory);
  const workDirectory = resolve(options.workDirectory ?? resolve(outputDirectory, ".flareport-work"));
  const archive = resolveInside(workDirectory, `${manifest.id}-${lock.upstream.commit}.tar.gz`, "archive destination");
  const extracted = resolveInside(workDirectory, "upstream", "extraction destination");
  const overlayName = assertRelativeSafePath(manifest.generation?.overlayDirectory ?? "overlay", "overlayDirectory");
  const overlay = resolveInside(adapterDirectory, overlayName, "overlay source");
  const metadata = resolveInside(outputDirectory, ".flareport/source.json", "metadata destination");

  return {
    adapterId: manifest.id,
    adapterVersion: manifest.adapterVersion,
    upstreamCommit: lock.upstream.commit,
    outputDirectory,
    preserve: manifest.generation?.preserve ?? [],
    steps: [
      {
        type: "fetch",
        url: lock.upstream.archiveUrl,
        expectedSha256: lock.upstream.archiveSha256,
        destination: archive,
      },
      {
        type: "extract",
        archive,
        destination: extracted,
        stripComponents: 1,
        ...(manifest.upstream.sourceSubdirectory ? { sourceSubdirectory: manifest.upstream.sourceSubdirectory } : {}),
      },
      { type: "copy-overlay", source: overlay, destination: outputDirectory },
      {
        type: "write-metadata",
        destination: metadata,
        contents: {
          schemaVersion: 1,
          adapter: { id: manifest.id, version: manifest.adapterVersion },
          upstream: {
            repository: manifest.upstream.repository,
            release: manifest.upstream.release,
            commit: manifest.upstream.commit,
            archiveSha256: lock.upstream.archiveSha256,
          },
        },
      },
    ],
  };
}

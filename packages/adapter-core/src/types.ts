export const CLOUDFLARE_SERVICES = [
  "workers",
  "pages",
  "d1",
  "r2",
  "kv",
  "durable-objects",
  "queues",
  "vectorize",
  "hyperdrive",
] as const;

export type CloudflareService = (typeof CLOUDFLARE_SERVICES)[number];

export const BINDING_TYPES = [
  "d1",
  "r2",
  "kv",
  "durable-object",
  "queue-producer",
  "queue-consumer",
  "vectorize",
  "hyperdrive",
  "service",
] as const;

export type BindingType = (typeof BINDING_TYPES)[number];

export interface AdapterManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  adapterVersion: string;
  upstream: {
    repository: string;
    release: string;
    commit: string;
    sourceSubdirectory?: string;
    license: string;
  };
  cloudflare: {
    compatibilityDate: string;
    services: CloudflareService[];
    bindings: Array<{
      name: string;
      type: BindingType;
      resourceName?: string;
      className?: string;
      required?: boolean;
    }>;
  };
  inputs: Array<{
    name: string;
    type: "secret" | "text" | "url" | "email" | "boolean" | "number";
    scope: "runtime" | "build";
    required: boolean;
    description: string;
    default?: string | boolean | number;
  }>;
  updates: {
    mode: "manual" | "auto" | "staged-auto";
    channel: "manual" | "canary" | "early" | "stable";
    source: "github-release" | "github-tag";
    allowPrerelease: boolean;
  };
  generation?: {
    overlayDirectory?: string;
    preserve?: string[];
  };
}

export interface UpstreamLock {
  schemaVersion: 1;
  adapter: {
    id: string;
    version: string;
  };
  upstream: {
    repository: string;
    release: string;
    commit: string;
    archiveUrl: string;
    archiveSha256: string;
  };
  generatedAt: string;
}

export type SyncStep =
  | {
      type: "fetch";
      url: string;
      expectedSha256: string;
      destination: string;
    }
  | {
      type: "extract";
      archive: string;
      destination: string;
      stripComponents: 1;
      sourceSubdirectory?: string;
    }
  | {
      type: "copy-overlay";
      source: string;
      destination: string;
    }
  | {
      type: "write-metadata";
      destination: string;
      contents: Record<string, unknown>;
    };

export interface SyncPlan {
  adapterId: string;
  adapterVersion: string;
  upstreamCommit: string;
  outputDirectory: string;
  preserve: string[];
  steps: SyncStep[];
}

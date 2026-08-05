import type { TrustedArtifact } from "./types.ts";

export type ArtifactPayload = Omit<TrustedArtifact, "id" | "contentHash" | "createdAt">;

export async function artifactDigest(payload: ArtifactPayload): Promise<string> {
  const canonical = JSON.stringify({
    template: payload.template,
    version: payload.version,
    upstreamCommit: payload.upstreamCommit.toLowerCase(),
    baseBranch: payload.baseBranch,
    releaseNotes: payload.releaseNotes,
    files: [...payload.files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({ path: file.path, content: file.content })),
  });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isManagedArtifactPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return false;
  const normalized = path.toLowerCase();
  return normalized !== ".github"
    && !normalized.startsWith(".github/")
    && normalized !== ".git"
    && !normalized.startsWith(".git/")
    && normalized !== "codeowners"
    && normalized !== ".github/codeowners";
}

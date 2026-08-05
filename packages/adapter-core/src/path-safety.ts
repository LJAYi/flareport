import { isAbsolute, relative, resolve, sep } from "node:path";

export function assertRelativeSafePath(value: string, label: string): string {
  if (!value || isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty relative path`);
  }

  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) {
    throw new Error(`${label} contains an unsafe path segment`);
  }
  return normalized;
}

export function resolveInside(root: string, candidate: string, label: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(resolvedRoot, candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
    return resolvedCandidate;
  }
  throw new Error(`${label} resolves outside its allowed root`);
}

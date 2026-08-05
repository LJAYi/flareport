import { readFile } from "node:fs/promises";
import type { AdapterManifest, UpstreamLock } from "./types.ts";
import { validateLock, validateManifest } from "./validate.ts";

async function readJson(path: string): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Unable to read ${path}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${(error as Error).message}`);
  }
}

export async function readManifest(path: string): Promise<AdapterManifest> {
  return validateManifest(await readJson(path));
}

export async function readLock(path: string, manifest?: AdapterManifest): Promise<UpstreamLock> {
  return validateLock(await readJson(path), manifest);
}

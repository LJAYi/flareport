#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { loadCatalog } from "./catalog.ts";

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export async function runCli(
  args: string[],
  io: CliIo = { stdout: console.log, stderr: console.error },
): Promise<number> {
  const command = args[0] ?? "catalog";
  const repositoryRoot = resolve(args[1] ?? dirname(dirname(fileURLToPath(import.meta.url))));
  try {
    const catalog = await loadCatalog({
      repositoryRoot,
      ...(process.env.FLAREPORT_PUBLIC_REPOSITORY
        ? { publicRepository: process.env.FLAREPORT_PUBLIC_REPOSITORY }
        : {}),
    });
    if (command === "validate") {
      io.stdout(`Validated ${catalog.length} adapters: ${catalog.map((entry) => entry.id).join(", ")}`);
      return 0;
    }
    if (command === "catalog") {
      io.stdout(JSON.stringify({ schemaVersion: 1, projects: catalog }, null, 2));
      return 0;
    }
    io.stderr("Usage: flareport <catalog|validate> [repository-root]");
    return 2;
  } catch (error) {
    io.stderr((error as Error).message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}

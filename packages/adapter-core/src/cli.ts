import { resolve } from "node:path";
import { readLock, readManifest } from "./io.ts";
import { createSyncPlan } from "./plan.ts";

export interface CliIo {
  cwd?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export async function runAdapterCommand(args: string[], io: CliIo = {}): Promise<number> {
  const cwd = resolve(io.cwd ?? process.cwd());
  const stdout = io.stdout ?? console.log;
  const stderr = io.stderr ?? console.error;
  const command = args[0];
  try {
    if (command === "validate") {
      const adapterDirectory = resolve(cwd, args[1] ?? ".");
      const manifest = await readManifest(resolve(adapterDirectory, "manifest.json"));
      await readLock(resolve(adapterDirectory, "upstream.lock.json"), manifest);
      stdout(`valid ${manifest.id}@${manifest.adapterVersion}`);
      return 0;
    }
    if (command === "plan") {
      const adapterDirectory = resolve(cwd, args[1] ?? ".");
      const outputDirectory = resolve(cwd, args[2] ?? `templates/${adapterDirectory.split("/").at(-1) ?? "adapter"}`);
      const manifest = await readManifest(resolve(adapterDirectory, "manifest.json"));
      const lock = await readLock(resolve(adapterDirectory, "upstream.lock.json"), manifest);
      stdout(JSON.stringify(createSyncPlan(manifest, lock, { adapterDirectory, outputDirectory }), null, 2));
      return 0;
    }
    stderr("Usage: adapter-core <validate|plan> <adapter-directory> [output-directory]");
    return 2;
  } catch (error) {
    stderr((error as Error).message);
    return 1;
  }
}

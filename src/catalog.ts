import { access, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readLock, readManifest, type AdapterManifest, type UpstreamLock } from "../packages/adapter-core/src/index.ts";

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  adapterVersion: string;
  upstream: AdapterManifest["upstream"];
  cloudflare: AdapterManifest["cloudflare"];
  defaultUpdates: AdapterManifest["updates"];
  lock: UpstreamLock;
  templateDirectory: string;
  deployUrl: string;
}

export interface LoadCatalogOptions {
  repositoryRoot: string;
  publicRepository?: string;
}

export async function loadCatalog(options: LoadCatalogOptions): Promise<CatalogEntry[]> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const adaptersRoot = join(repositoryRoot, "adapters");
  const templatesRoot = join(repositoryRoot, "templates");
  const publicRepository = options.publicRepository ?? "https://github.com/LJAYi/flareport";
  const adapterEntries = await readdir(adaptersRoot, { withFileTypes: true });
  const result: CatalogEntry[] = [];

  for (const directory of adapterEntries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const adapterDirectory = join(adaptersRoot, directory.name);
    const absoluteTemplateDirectory = join(templatesRoot, directory.name);
    const manifest = await readManifest(join(adapterDirectory, "manifest.json"));
    const lock = await readLock(join(adapterDirectory, "upstream.lock.json"), manifest);
    if (manifest.id !== directory.name) {
      throw new Error(`Adapter directory ${directory.name} does not match manifest id ${manifest.id}`);
    }
    await access(absoluteTemplateDirectory);
    const templateSourceUrl = `${publicRepository.replace(/\/$/, "")}/tree/main/templates/${manifest.id}`;
    result.push({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      adapterVersion: manifest.adapterVersion,
      upstream: manifest.upstream,
      cloudflare: manifest.cloudflare,
      defaultUpdates: manifest.updates,
      lock,
      templateDirectory: `templates/${manifest.id}`,
      deployUrl: `https://deploy.workers.cloudflare.com/?url=${encodeURIComponent(templateSourceUrl)}`,
    });
  }

  if (result.length === 0) throw new Error("Catalog contains no adapters");
  return result;
}

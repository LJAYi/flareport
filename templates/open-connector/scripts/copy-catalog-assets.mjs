import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const upstreamDirectory = resolve(process.cwd(), ".flareport/upstream");
const scriptUrl = pathToFileURL(resolve(upstreamDirectory, "scripts/copy-catalog-assets.ts"));
const { copyCatalogAssets } = await import(scriptUrl.href);
const result = await copyCatalogAssets({
  sourceDir: resolve(upstreamDirectory, "catalog/apps"),
  targetDir: resolve(upstreamDirectory, "dist/web/catalog"),
});
console.log(`Copied ${result.providerCount} catalog apps into ${result.chunks.length} static asset chunks.`);

import { execFile as execFileCallback } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export async function verifyUpstreamNotices(root) {
  for (const name of ["LICENSE.txt", "LICENSE-APACHE-2.0.txt", "NOTICE.md"]) {
    const expected = await readFile(resolve(root, "licenses/open-connector", name), "utf8");
    const actual = await readFile(resolve(root, ".flareport/upstream", name), "utf8");
    if (actual.trimEnd() !== expected.trimEnd()) throw new Error(`Upstream ${name} changed; review license and attribution before updating`);
  }
}

export async function applyCatalogPatch(directory, patch) {
  // The downloaded tree is inside an ignored directory of the deployment repository.
  // Stop Git discovering that parent repo, where it could silently skip patch paths.
  const options = { cwd: directory, env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(directory) } };
  await execFile("git", ["apply", "--check", patch], options);
  await execFile("git", ["apply", patch], options);
}

export async function applyCloudflareOverlay(root = process.cwd()) {
  await verifyUpstreamNotices(root);
  const directory = resolve(root, ".flareport/upstream");
  await applyCatalogPatch(directory, resolve(root, "patches/cloudflare-catalog.patch"));
  const headersPath = resolve(directory, "web/public/_headers");
  const headers = await readFile(headersPath, "utf8");
  const oldHeaders = "/assets/*\n  Cache-Control: public, max-age=31536000, immutable";
  if (!headers.includes(oldHeaders)) throw new Error("Upstream asset cache headers changed; review the Cloudflare overlay");
  await writeFile(headersPath, headers.replace(oldHeaders,
    "/assets/*\n  Cache-Control: public, max-age=0, must-revalidate\n  Cloudflare-CDN-Cache-Control: public, max-age=0, must-revalidate"));
  console.log("Applied reviewed Cloudflare catalog and cache overlay");
}

if (import.meta.main) await applyCloudflareOverlay();

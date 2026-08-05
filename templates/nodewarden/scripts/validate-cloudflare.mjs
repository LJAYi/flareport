import { execFile as execFileCallback } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const limits = {
  workerGzipBytes: 2_950_000,
  assetBytes: Math.floor(24.75 * 1024 * 1024),
  assetCount: 18_000,
};

export function parseGzipBytes(output) {
  const match = output.match(/gzip:\s*([0-9]+(?:\.[0-9]+)?)\s*(B|KB|KiB|MB|MiB)\b/i);
  if (!match) throw new Error("Wrangler output did not report a gzip upload size");
  const multipliers = { b: 1, kb: 1000, kib: 1024, mb: 1_000_000, mib: 1024 * 1024 };
  return Math.round(Number(match[1]) * multipliers[match[2].toLowerCase()]);
}

async function collectAssets(directory) {
  const assets = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) assets.push({ path: absolute, bytes: (await stat(absolute)).size });
    }
  }
  await visit(directory);
  return assets;
}

export async function validateCloudflare(root = process.cwd()) {
  const config = JSON.parse(await readFile(resolve(root, "wrangler.jsonc"), "utf8"));
  const assets = await collectAssets(resolve(root, config.assets.directory));
  const largest = assets.reduce((current, asset) => asset.bytes > current.bytes ? asset : current, { path: "(none)", bytes: 0 });
  const result = await execFile(
    "npx",
    ["--yes", "wrangler@4.114.0", "deploy", "--dry-run", "--minify", "--outdir=.wrangler-dry-run"],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 },
  );
  const output = result.stdout + result.stderr;
  process.stdout.write(output);
  const gzipBytes = parseGzipBytes(output);
  const violations = [];
  if (gzipBytes > limits.workerGzipBytes) violations.push(`Worker gzip bytes ${gzipBytes} exceed ${limits.workerGzipBytes}`);
  if (assets.length > limits.assetCount) violations.push(`Asset count ${assets.length} exceeds ${limits.assetCount}`);
  if (largest.bytes > limits.assetBytes) violations.push(`Asset ${largest.path} is ${largest.bytes} bytes, exceeding ${limits.assetBytes}`);
  if (violations.length) throw new Error(`Cloudflare Free plan headroom check failed:\n- ${violations.join("\n- ")}`);
  console.log(`Cloudflare headroom passed: gzip=${gzipBytes}, assets=${assets.length}, largest=${largest.bytes}`);
}

if (import.meta.main) await validateCloudflare();

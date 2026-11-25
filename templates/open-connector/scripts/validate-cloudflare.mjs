import { execFile as execFileCallback } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
// https://developers.cloudflare.com/workers/platform/limits/ (reviewed 2026-11-25).
// Bundle limits do not guarantee request CPU, startup time, or account usage fits Free.
export const limits = {
  workerBytes: 64 * 1024 * 1024,
  assetBytes: Math.floor(24.75 * 1024 * 1024),
  assetCount: 18_000,
};

export function parseUploadBytes(output) {
  const plainOutput = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  const match = plainOutput.match(/Total Upload:\s*([0-9]+(?:\.[0-9]+)?)\s*(B|KB|KiB|MB|MiB)\b/i);
  if (!match) throw new Error("Wrangler output did not report an uncompressed upload size");
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

export function assertBundleLimits(workerBytes, assets) {
  const largest = assets.reduce((current, asset) => asset.bytes > current.bytes ? asset : current, { path: "(none)", bytes: 0 });
  const violations = [];
  if (workerBytes > limits.workerBytes) violations.push(`Worker uncompressed bytes ${workerBytes} exceed ${limits.workerBytes}`);
  if (assets.length > limits.assetCount) violations.push(`Asset count ${assets.length} exceeds ${limits.assetCount}`);
  if (largest.bytes > limits.assetBytes) violations.push(`Asset ${largest.path} is ${largest.bytes} bytes, exceeding ${limits.assetBytes}`);
  if (violations.length) throw new Error(`Cloudflare build-size check failed:\n- ${violations.join("\n- ")}`);
  return largest;
}

export async function validateCloudflare(root = process.cwd()) {
  const config = JSON.parse(await readFile(resolve(root, "wrangler.jsonc"), "utf8"));
  const assets = await collectAssets(resolve(root, config.assets.directory));
  const result = await execFile(
    "npx",
    ["--yes", "wrangler@4.149.0", "deploy", "--dry-run", "--minify", "--outdir=.wrangler-dry-run"],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 },
  );
  const output = result.stdout + result.stderr;
  process.stdout.write(output);
  const workerBytes = parseUploadBytes(output);
  const largest = assertBundleLimits(workerBytes, assets);
  console.log(`Cloudflare build-size checks passed: uncompressed=${workerBytes}, assets=${assets.length}, largest=${largest.bytes}`);
}

if (import.meta.main) await validateCloudflare();

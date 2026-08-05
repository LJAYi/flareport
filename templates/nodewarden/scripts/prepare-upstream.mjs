import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createGunzip } from "node:zlib";

const execFile = promisify(execFileCallback);

export const ARCHIVE_LIMITS = Object.freeze({
  compressedBytes: 128 * 1024 * 1024,
  entries: 50_000,
  expandedBytes: 1024 * 1024 * 1024,
});

function tarString(block, start, length) {
  return block.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "").trim();
}

function tarSize(block) {
  const raw = tarString(block, 124, 12);
  if (!/^[0-7]+$/.test(raw)) throw new Error(`Invalid TAR size field: ${JSON.stringify(raw)}`);
  const size = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid TAR entry size");
  return size;
}

export function assertSafeArchiveEntry(path) {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe archive entry: ${path}`);
  }
}

function assertSafeGlobalPax(contents) {
  const records = contents.toString("utf8").split("\n").filter(Boolean);
  if (records.length === 0) throw new Error("Empty global PAX metadata is forbidden");
  for (const record of records) {
    const match = record.match(/^(\d+) ([A-Za-z0-9_.-]+)=(.*)$/s);
    if (!match || Number(match[1]) !== Buffer.byteLength(`${record}\n`)) throw new Error("Malformed global PAX metadata");
    if (match[2] !== "comment") throw new Error(`Global PAX key ${match[2]} is forbidden`);
  }
}

export async function inspectTarGzip(archivePath, limits = ARCHIVE_LIMITS) {
  const compressed = await stat(archivePath);
  if (compressed.size > limits.compressedBytes) {
    throw new Error(`Upstream archive exceeds compressed size limit of ${limits.compressedBytes} bytes`);
  }
  let pending = Buffer.alloc(0);
  let payloadBytes = 0;
  let paxBytes = 0;
  let paxChunks = [];
  let entryCount = 0;
  let expandedBytes = 0;
  let inflatedBytes = 0;
  for await (const chunk of createReadStream(archivePath).pipe(createGunzip())) {
    inflatedBytes += chunk.length;
    if (inflatedBytes > limits.expandedBytes + limits.entries * 1024) {
      throw new Error("Upstream TAR stream exceeds its bounded expanded envelope");
    }
    pending = Buffer.concat([pending, chunk]);
    while (pending.length > 0) {
      if (payloadBytes > 0) {
        const consumed = Math.min(payloadBytes, pending.length);
        if (paxBytes > 0) {
          const captured = Math.min(paxBytes, consumed);
          paxChunks.push(pending.subarray(0, captured));
          paxBytes -= captured;
        }
        pending = pending.subarray(consumed);
        payloadBytes -= consumed;
        if (payloadBytes > 0) break;
        if (paxChunks.length) {
          assertSafeGlobalPax(Buffer.concat(paxChunks));
          paxChunks = [];
        }
        continue;
      }
      if (pending.length < 512) break;
      const header = pending.subarray(0, 512);
      pending = pending.subarray(512);
      if (header.every((byte) => byte === 0)) continue;
      entryCount += 1;
      if (entryCount > limits.entries) throw new Error(`Upstream archive exceeds member limit of ${limits.entries}`);
      const type = header[156];
      if (type !== 0 && type !== 0x30 && type !== 0x35 && type !== 0x67) {
        throw new Error(`Unsupported TAR member type ${String.fromCharCode(type)}; links and special files are forbidden`);
      }
      const name = tarString(header, 0, 100);
      const prefix = tarString(header, 345, 155);
      assertSafeArchiveEntry(prefix ? `${prefix}/${name}` : name);
      const size = tarSize(header);
      if (type === 0x35 && size !== 0) throw new Error("TAR directory entry must have zero size");
      expandedBytes += size;
      if (expandedBytes > limits.expandedBytes) {
        throw new Error(`Upstream archive exceeds expanded size limit of ${limits.expandedBytes} bytes`);
      }
      payloadBytes = Math.ceil(size / 512) * 512;
      if (type === 0x67) paxBytes = size;
    }
  }
  if (entryCount === 0) throw new Error("Upstream archive is empty");
  if (payloadBytes !== 0 || paxBytes !== 0 || pending.length % 512 !== 0) throw new Error("Upstream archive is truncated");
  return { entryCount, expandedBytes, compressedBytes: compressed.size };
}

function compressedByteLimiter(maximum) {
  let bytes = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maximum ? new Error(`Upstream archive exceeds compressed size limit of ${maximum} bytes`) : null, chunk);
    },
  });
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function extractVerifiedArchive({ archivePath, destination, expectedSha256, limits = ARCHIVE_LIMITS }) {
  const actualSha256 = await sha256File(archivePath);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Upstream archive SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }
  await inspectTarGzip(archivePath, limits);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await execFile("tar", [
    "-xzf",
    archivePath,
    "-C",
    destination,
    "--strip-components=1",
    "--no-same-owner",
    "--no-same-permissions",
  ]);
}

export async function prepareUpstream(root = process.cwd()) {
  const lock = JSON.parse(await readFile(resolve(root, "upstream.lock.json"), "utf8"));
  const workRoot = resolve(root, ".flareport");
  const destination = resolve(workRoot, "upstream");
  await mkdir(workRoot, { recursive: true });
  const archivePath = resolve(workRoot, "upstream.tar.gz");
  const fixtureArchive = process.env.FLAREPORT_ARCHIVE_PATH;
  if (fixtureArchive) {
    await pipeline(createReadStream(resolve(fixtureArchive)), compressedByteLimiter(ARCHIVE_LIMITS.compressedBytes), createWriteStream(archivePath));
  } else {
    const response = await fetch(lock.upstream.archiveUrl, { redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`Unable to fetch pinned upstream archive: HTTP ${response.status}`);
    const advertisedSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(advertisedSize) && advertisedSize > ARCHIVE_LIMITS.compressedBytes) {
      throw new Error(`Upstream archive exceeds compressed size limit of ${ARCHIVE_LIMITS.compressedBytes} bytes`);
    }
    await pipeline(response.body, compressedByteLimiter(ARCHIVE_LIMITS.compressedBytes), createWriteStream(archivePath));
  }

  try {
    await extractVerifiedArchive({
      archivePath,
      destination,
      expectedSha256: lock.upstream.archiveSha256,
    });
    await writeFile(resolve(workRoot, "source.json"), JSON.stringify({
      schemaVersion: 1,
      repository: lock.upstream.repository,
      release: lock.upstream.release,
      commit: lock.upstream.commit,
      archiveSha256: lock.upstream.archiveSha256,
    }, null, 2) + "\n");
  } finally {
    await unlink(archivePath).catch(() => {});
  }
  console.log(`Prepared verified upstream ${lock.upstream.repository}@${lock.upstream.commit}`);
  return destination;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await prepareUpstream();
}

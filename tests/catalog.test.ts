import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "../src/catalog.ts";
import { runCli } from "../src/cli.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("loads the two MVP projects and produces subdirectory deploy URLs", async () => {
  const catalog = await loadCatalog({ repositoryRoot, publicRepository: "https://github.com/example/flareport" });
  assert.deepEqual(catalog.map((entry) => entry.id), ["nodewarden", "open-connector"]);
  for (const entry of catalog) {
    assert.equal(entry.lock.adapter.id, entry.id);
    assert.match(entry.deployUrl, /^https:\/\/deploy\.workers\.cloudflare\.com\/\?url=/);
    assert.match(decodeURIComponent(entry.deployUrl), new RegExp(`/templates/${entry.id}$`));
  }
});

test("CLI validates the integrated catalog", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(["validate", repositoryRoot], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  assert.equal(code, 0);
  assert.deepEqual(stderr, []);
  assert.match(stdout.join("\n"), /Validated 2 adapters/);
});

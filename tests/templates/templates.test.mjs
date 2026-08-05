import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { readLock, readManifest, validateLock } from "../../packages/adapter-core/src/index.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const templateRoot = resolve(repositoryRoot, "templates");
const adapterRoot = resolve(repositoryRoot, "adapters");
const ids = ["nodewarden", "open-connector"];
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

test("the catalog has exactly the two MVP templates", async () => {
  const directories = (await readdir(templateRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(directories, ids);
});

for (const id of ids) {
  test(`${id} is a standalone, locked Deploy Button root`, async () => {
    const root = resolve(templateRoot, id);
    const required = [
      ".dev.vars.example",
      ".github/scripts/flareport-update.mjs",
      ".github/workflows/ci.yml",
      ".github/workflows/flareport-update.yml",
      ".gitignore",
      "README.md",
      "UPSTREAM.md",
      "flareport.json",
      "flareport.user.example.json",
      "package.json",
      "scripts/prepare-upstream.mjs",
      "scripts/validate-cloudflare.mjs",
      "tests/prepare-upstream.test.mjs",
      "tests/update-security.test.mjs",
      "upstream.lock.json",
      "wrangler.jsonc",
    ];
    await Promise.all(required.map((path) => access(resolve(root, path))));

    const [metadata, lock, adapter, adapterLock, packageJson, wrangler, readme, workflow, validationWorkflow, updater, gitignore, vars] =
      await Promise.all([
        readJson(resolve(root, "flareport.json")),
        readJson(resolve(root, "upstream.lock.json")),
        readManifest(resolve(adapterRoot, id, "manifest.json")),
        readManifest(resolve(adapterRoot, id, "manifest.json")).then((manifest) => readLock(resolve(adapterRoot, id, "upstream.lock.json"), manifest)),
        readJson(resolve(root, "package.json")),
        readFile(resolve(root, "wrangler.jsonc"), "utf8").then(JSON.parse),
        readFile(resolve(root, "README.md"), "utf8"),
        readFile(resolve(root, ".github/workflows/flareport-update.yml"), "utf8"),
        readFile(resolve(root, ".github/workflows/ci.yml"), "utf8"),
        readFile(resolve(root, ".github/scripts/flareport-update.mjs"), "utf8"),
        readFile(resolve(root, ".gitignore"), "utf8"),
        readFile(resolve(root, ".dev.vars.example"), "utf8"),
      ]);

    const validatedTemplateLock = validateLock(lock, adapter);
    assert.equal(metadata.schemaVersion, 1);
    assert.deepEqual(metadata.adapter, lock.adapter);
    assert.deepEqual(validatedTemplateLock.adapter, adapterLock.adapter);
    assert.deepEqual(validatedTemplateLock.upstream, adapterLock.upstream);
    assert.equal(validatedTemplateLock.generatedAt, adapterLock.generatedAt);
    assert.equal(metadata.adapter.id, adapter.id);
    assert.equal(metadata.adapter.version, adapter.adapterVersion);
    assert.equal(metadata.upstream.repository, adapter.upstream.repository);
    assert.equal(metadata.upstream.release, adapter.upstream.release);
    assert.equal(metadata.upstream.commit, adapter.upstream.commit);
    assert.equal(metadata.upstream.archiveSha256, lock.upstream.archiveSha256);
    assert.deepEqual(metadata.upstream, {
      repository: adapterLock.upstream.repository,
      release: adapterLock.upstream.release,
      commit: adapterLock.upstream.commit,
      archiveSha256: adapterLock.upstream.archiveSha256,
    });
    assert.match(lock.upstream.commit, /^[0-9a-f]{40}$/);
    assert.match(lock.upstream.archiveSha256, /^[0-9a-f]{64}$/);
    assert.equal(lock.upstream.archiveUrl, `https://github.com/${lock.upstream.repository}/archive/${lock.upstream.commit}.tar.gz`);

    assert.equal(packageJson.private, true);
    assert.match(packageJson.scripts.build, /prepare:upstream/);
    assert.match(packageJson.scripts.deploy, /wrangler@\d+\.\d+\.\d+/);
    assert.match(wrangler.main, /^\.flareport\/upstream\//);
    assert.equal(wrangler.keep_vars, true);
    assert.match(gitignore, /^\.flareport\/$/m);
    const checkedInSource = await readdir(resolve(root, "src")).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    assert.deepEqual(checkedInSource, [], "upstream source must not be checked in");

    const expectedUrl = `https://deploy.workers.cloudflare.com/?url=https://github.com/LJAYi/flareport/tree/main/templates/${id}`;
    assert.match(readme, /deploy\.workers\.cloudflare\.com\/button/);
    assert.ok(readme.includes(expectedUrl));
    assert.match(readme, /SHA-256/);

    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /schedule:/);
    assert.match(workflow, /contents: write/);
    assert.match(workflow, /checks: write/);
    assert.match(workflow, /pull-requests: write/);
    assert.match(workflow, /secrets\.GITHUB_TOKEN/);
    assert.match(workflow, /persist-credentials: false/g);
    assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/);
    assert.match(workflow, /actions\/download-artifact@[0-9a-f]{40}/);
    assert.ok(workflow.indexOf("Seal candidate") < workflow.indexOf("build untrusted pinned upstream"));
    assert.ok(workflow.indexOf("propose:") < workflow.indexOf("GITHUB_TOKEN:"));
    assert.doesNotMatch(workflow, /pull_request(?:_target)?:/);
    assert.match(validationWorkflow, /pull_request:/);
    assert.match(validationWorkflow, /contents: read/);
    assert.match(validationWorkflow, /persist-credentials: false/);
    assert.match(validationWorkflow, /npm run build/);
    assert.match(validationWorkflow, /npm run validate:cloudflare/);
    assert.doesNotMatch(validationWorkflow, /contents: write|pull-requests: write|secrets\.GITHUB_TOKEN/);
    assert.match(updater, /commits\/\$\{encodeURIComponent\(sourceRef\)\}/);
    assert.match(updater, /sourceCommit/);
    assert.match(updater, /Candidate artifact hash does not match/);
    assert.match(updater, /Sealed candidate SHA-256/);
    assert.match(updater, /Applied managed-tree SHA-256/);
    assert.match(updater, /\/check-runs/);
    assert.match(updater, /head_sha: commit\.sha/);
    assert.match(updater, /flareport\.user\.json/);
    assert.match(updater, /user-owned and cannot be centrally managed/);
    assert.match(updater, /Existing update PR lacks the FlarePort ownership marker/);
    assert.match(updater, /pulls\/\$\{pulls\[0\]\.number\}\/files/);
    assert.ok(updater.indexOf("assertOwnedUpdateBranch({ existingRef") < updater.lastIndexOf("force: true"));
    assert.match(updater, /localMetadata\.management\.autoMergeAllowed === true && nextMetadata\.management\.autoMergeAllowed === true/);
    assert.doesNotMatch(updater, /execFile|spawn\(|git config|http\.proxy|https\.proxy/);
    assert.doesNotMatch(updater, /console\.log\([^\n]*process\.env/);

    for (const path of metadata.managedFiles) {
      assert.ok(!path.startsWith("/") && !path.split("/").includes(".."), `unsafe managed path ${path}`);
      await access(resolve(root, path));
    }
    assert.equal(metadata.managedFiles.includes("flareport.user.json"), false);
    assert.equal(metadata.managedFiles.some((path) => path.startsWith(".github/workflows/")), false);
    assert.equal(metadata.management.autoMergeAllowed, true);
    assert.match(vars, /replace-with-/);
    assert.doesNotMatch(vars, /(?:sk-|ghp_|github_pat_)[A-Za-z0-9_]+/);
  });
}

# Adapter lifecycle

## Admission

1. Confirm the upstream license permits redistribution or build-time retrieval.
2. Classify Workers compatibility and required paid services.
3. Create a manifest and immutable upstream lock.
4. Keep Cloudflare-specific files in the adapter overlay.
5. Generate a standalone template and verify it without account credentials.
6. Perform a Wrangler dry run and project-specific smoke tests.

## Release update

The `Upstream sync` Actions workflow runs daily at 02:17 UTC or manually for one
adapter (`adapter: nodewarden`) or `all`. It discovers registered adapters from
the catalog; each adapter gets an independent preparation, validation and PR
job sequence. This first version supports stable `x.y.z` GitHub releases only.
Tag-only projects and prerelease policies fail closed instead of guessing.
For an initial read-only trial, dispatch with `propose_pr: false`; discovery and
validation still run, but no branch, PR or Check is written.

Preparation resolves lightweight or annotated release tags to a full SHA,
rejects downgrades, moved existing tags and non-descendant releases, and hashes
the bounded commit archive. It increments the adapter patch version and seals
exactly six files: the central manifest and lock, template lock, template
metadata, package version and upstream attribution. Configuration, secrets,
Wrangler bindings and workflow files are not updated by this process.

The candidate is uploaded before any upstream code runs. A separate read-only
job verifies its digest, runs repository/template tests, builds the pinned
upstream, and performs a size-checked Wrangler dry run. NodeWarden also runs its
compatibility and security regression scripts. A fresh write-capable job reads
that original artifact by immutable ID and checks its digest again; it never
executes candidate or upstream code. It creates a manual-review PR and an exact
head-SHA `FlarePort upstream validation` Check. No auto-merge is requested.

The repository must allow GitHub Actions to create pull requests (Settings →
Actions → General → Workflow permissions). No PAT, Cloudflare credential or
additional GitHub App installation is needed. The workflow requests scoped
contents, pull-request and check writes only in the publishing job. PRs made
with `GITHUB_TOKEN` do not trigger ordinary PR CI runs, so the explicit validation
Check links back to the successful originating run; it is not a deployment Check.

A changed default branch requires a fresh run. Unknown occupied update branches,
edited PR heads and previously closed update PRs require maintainer review; the
updater never force-pushes or deletes them. Merging the public template PR only
publishes that template. Dispatch to user repositories remains a separate step;
this workflow does not upgrade deployed applications or migrate databases.

Before approving a real upgrade, review upstream migration/runtime changes,
validate preservation of user configuration and resource identity, establish a
data recovery point, and upgrade a test deployment. A code rollback alone cannot
undo a database migration.

1. Detect the newest stable upstream release.
2. Resolve its tag to a full commit SHA.
3. Generate a candidate in a clean temporary directory.
4. Restore only reviewed FlarePort-owned deployment files.
5. Run upstream tests, adapter tests, bundle limits, and a Wrangler dry run.
6. Publish a signed or content-addressed update descriptor.
7. Create pull requests according to each repository's update mode and rollout channel.

Before extraction, generated templates verify the archive digest and inspect the TAR stream. Only regular files, directories, and GitHub's comment-only global PAX header are accepted; links, device nodes, local PAX overrides, traversal paths, oversized downloads, excessive members, and oversized expanded payloads are rejected. Every preparation starts from a clean extraction directory instead of trusting a marker from an earlier build.

CI validates the template lock with the same adapter-core validator used for the catalog, then requires its adapter identity, upstream repository, release, commit, archive URL, digest, and generation timestamp to match the central adapter lock and template metadata.

## User configuration

Inputs are classified by phase and sensitivity. Runtime secrets are declared through `.dev.vars.example`; runtime text values belong in Worker variables or a first-run setup flow; build-only values belong in Workers Builds; Cloudflare resources are provisioned from Wrangler bindings. Account identifiers and secret values are never written to adapter manifests or upstream locks.

## Failure handling

A failed central validation never becomes eligible for rollout. A failed user-repository check blocks auto-merge and contributes one failure observation. A rollout pause stops new automatic merges but does not silently roll back existing deployments. Rollback requires a separate reviewed update or an explicit repository opt-in.

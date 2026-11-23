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
Scheduled runs also stay read-only until the maintainer sets the repository
Actions variable `FLAREPORT_UPSTREAM_PR_ENABLED` to `true` after enabling PR
creation. This prevents an unconfigured installation from leaving orphaned
update branches when GitHub rejects PR creation.

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
updater never force-pushes or deletes them. Merging the public template PR publishes
the template; the separate, opt-in main-branch CI publisher described below can
then make it available to the Bot. The upstream-sync workflow itself never
upgrades deployed applications or migrates databases.

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

## Bot publication and dispatch

The main-branch `CI` workflow (push or manual dispatch) can publish version-only
Bot releases after repository tests and all selected template builds/dry-runs
pass. Manual CI dispatch validates all catalog templates and is also the
bootstrap/retry path. PR events never publish. Publication runs in a separate
job with a clean checkout pinned to the validated `github.sha`, read-only
GitHub permissions, no dependency installation or upstream execution, and no
downloaded build outputs. Only that step receives the publisher secret.

To enable it deliberately:

1. Deploy the reviewed Bot code with D1 migration `0004_verified_deployments.sql`
   applied, its GitHub App credentials installed, and signed Check Run webhooks
   subscribed. Leave `AUTO_DISPATCH_ENABLED` as `"false"` initially.
2. Create the GitHub environment `flareport-publishing`, restrict it to `main`
   (and add required reviewers if desired), and store `FLAREPORT_ARTIFACT_TOKEN`
   there. Its value must match the Bot's `ARTIFACT_TOKEN`, **not** `ADMIN_TOKEN`.
   Set repository variable `FLAREPORT_BOT_URL` to the Bot's HTTPS origin, with no
   path or query. No Cloudflare deployment or application secrets go in this job.
3. Set repository variable `FLAREPORT_BOT_PUBLISH_ENABLED=true`, then manually
   run CI on `main`. Publication uploads a content-addressed artifact and activates
   its adapter version. Existing paused releases remain paused on retries.
4. Register only the intended test deployment with an active installation,
   `mode: manual`, `channel: canary`, and the exact `Workers Builds: <worker>`
   check name. Turn on the Bot's `AUTO_DISPATCH_ENABLED="true"` to test automatic
   PR delivery. This does not permit merging. When the deployment is already
   current, expect a no-op, not an artificial update or downgrade.
5. After reviewing a real candidate PR, validate the deployment workflow and
   branch-required checks, then separately opt in to `auto` or `staged-auto`
   and the repository's local merge policy. Manual mode continues to require
   owner review. Choose either the App or the scheduled Actions fallback for a
   given repository to avoid competing updater PRs.

The artifact contains only four version/attribution files. The Bot preserves
local metadata policy and package settings; it never changes Wrangler, runtime
variables, D1/R2 identifiers, secrets or workflows. Package wiring differences
require manual migration. This is not a general adapter-code/config migration
system: maintainers must hold publication when an upstream upgrade requires
new helper scripts, bindings or other configuration, and migrate test/user
repositories separately before releasing it. Upstream runtime compatibility
and data migration safety still need review.

Defaults require 10 canary successes over 12 hours and then 100 early-phase
successes over 24 hours. Those are distinct eligible deployment repositories,
not people. A small test fleet does not satisfy production gates automatically;
the end-to-end tests use reduced **test-only** thresholds. The current 100-repository
reconciliation bound and default cohort sizes are not a production-scale rollout
configuration; add pagination/batching and plan cohort sizes before fleet rollout.
The successful deployment observation is not runtime health telemetry.

For local inspection without publishing:

```sh
node src/template-release.ts prepare nodewarden
npm run check
```

## User configuration

Inputs are classified by phase and sensitivity. Runtime secrets are declared through `.dev.vars.example`; runtime text values belong in Worker variables or a first-run setup flow; build-only values belong in Workers Builds; Cloudflare resources are provisioned from Wrangler bindings. Account identifiers and secret values are never written to adapter manifests or upstream locks.

## Failure handling

A failed central validation never becomes eligible for rollout. A failed user-repository validation check blocks auto-merge; only verified post-merge provider deployment checks contribute rollout evidence. A rollout pause stops automatic dispatch and merging but does not silently roll back existing deployments. Rollback requires a separate reviewed update or an explicit repository opt-in.

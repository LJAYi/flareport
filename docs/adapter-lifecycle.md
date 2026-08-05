# Adapter lifecycle

## Admission

1. Confirm the upstream license permits redistribution or build-time retrieval.
2. Classify Workers compatibility and required paid services.
3. Create a manifest and immutable upstream lock.
4. Keep Cloudflare-specific files in the adapter overlay.
5. Generate a standalone template and verify it without account credentials.
6. Perform a Wrangler dry run and project-specific smoke tests.

## Release update

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

# OpenConnector on Cloudflare · FlarePort

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LJAYi/flareport/tree/main/templates/open-connector)

This standalone directory is the Cloudflare Deploy Button root for OpenConnector. It intentionally contains no copy of the upstream source: the build downloads the exact commit in `upstream.lock.json`, verifies the archive SHA-256, extracts it under ignored `.flareport/upstream`, builds it, and deploys from there.

## Build contract

1. FlarePort validates the central adapter manifest and the copied `upstream.lock.json` before publishing this template.
2. Run `npm run build`; `scripts/prepare-upstream.mjs` fetches the immutable archive and verifies its SHA-256 before extraction.
3. Install from the upstream lockfile and run its catalog/web build inside `.flareport/upstream`.
4. Run `npm run deploy`; Wrangler uses the root adapter configuration while its entry point, assets, and migrations point at that verified workspace.
5. Never fetch `main`, `latest`, or another floating ref during deployment.

## User-owned configuration

Cloudflare asks for `OOMOL_CONNECT_ADMIN_TOKEN` and `OOMOL_CONNECT_ENCRYPTION_KEY`. Their real values belong in Cloudflare Secrets, never in Git. D1 and R2 are provisioned from `wrangler.jsonc`; dashboard variables are retained across deployments through `keep_vars`.

The copied repository includes a weekly/manual updater. Its read-only job resolves FlarePort's configured branch to a full commit, seals the candidate as a hashed artifact, and then builds the untrusted upstream without credentials. A separate job receives the write token, starts from a clean checkout with persisted Git credentials disabled, verifies the sealed hash, and creates the branch and PR through GitHub's API. It never runs candidate or upstream code.

Automatic merge is user-owned. Copy `flareport.user.example.json` to `flareport.user.json`, commit it, set `autoMerge` to `true`, and configure every name in `requiredChecks` as a required branch-protection check. The updater verifies those protections before requesting GitHub auto-merge. This local file is deliberately absent from `managedFiles`, so central updates cannot enable auto-merge. Central metadata is only a permission ceiling: an update may disable automatic merging, but cannot re-enable it after it has been disabled.

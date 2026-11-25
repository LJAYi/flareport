# OpenConnector on Cloudflare · FlarePort

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LJAYi/flareport/tree/main/templates/open-connector)

This standalone directory is the Cloudflare Deploy Button root for OpenConnector. It intentionally contains no copy of the upstream source: the build downloads the exact commit in `upstream.lock.json`, verifies the archive SHA-256, extracts it under ignored `.flareport/upstream`, builds it, and deploys from there.

> **License:** the pinned v1.10.1 release uses the [OpenConnector License](licenses/open-connector/LICENSE.txt), not unmodified Apache-2.0. It includes restrictions on providing hosted or managed connector services to third parties. Review the [upstream attribution and notices](UPSTREAM.md) before deploying. FlarePort's original tooling remains MIT.

## Build contract

1. FlarePort validates the central adapter manifest and the copied `upstream.lock.json` before publishing this template.
2. Run `npm run build`; `scripts/prepare-upstream.mjs` fetches the immutable archive and verifies its SHA-256 before extraction.
3. Apply the reviewed Cloudflare overlay, install from the upstream lockfile, and run its catalog/web build inside `.flareport/upstream`. Use Node.js 24.22.1+ on the Node 24 line, or 26.12.1+. The overlay preserves the optimized catalog startup, lazy schema assets, request-local coalescing and cache revalidation from `LJAYi/open-connector-cloudflare`; patch conflicts stop the build.
4. Run `npm run deploy`; Wrangler uses the root adapter configuration while its entry point, assets, and migrations point at that verified workspace.
5. Never fetch `main`, `latest`, or another floating ref during deployment.

## User-owned configuration

Cloudflare asks for `OOMOL_CONNECT_ADMIN_TOKEN` and `OOMOL_CONNECT_ENCRYPTION_KEY`. Their real values belong in Cloudflare Secrets, never in Git. D1 and R2 are provisioned from `wrangler.jsonc`; dashboard variables are retained across deployments through `keep_vars`.

Use different random values and keep a secure backup of the encryption key. Changing or losing it can make existing stored credentials unreadable. Self-hosting does not include OOMOL-managed OAuth apps; configure your own provider OAuth clients when required.

For a new test deployment, use a unique Worker name and new D1/R2 resources. Do not point the test at a production database. R2 activation may require billing setup even when usage stays within its free allowance.

For an explicitly planned migration, set **both** `OPEN_CONNECT_D1_DATABASE_ID` and `OPEN_CONNECT_R2_BUCKET_NAME` as Workers Builds variables. `npm run deploy` uses them only in the build checkout, before applying D1 migrations. These variables alone do not select the correct Worker, preserve its secrets or establish a rollback plan: verify the Worker identity, domain, encryption key, backups and schema compatibility separately. Never commit the generated resource configuration.

## Validation and background tasks

Run `npm test`, `npm run build`, and `npm run validate:cloudflare`. Validation includes the catalog/Worker regression tests and a Wrangler dry-run. The build guard checks the current 64 MiB **uncompressed** Worker limit, at most 18,000 static assets, and 24.75 MiB per asset. See [Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/). Passing these checks does not prove startup time or request CPU fits the Free plan, and is not account-wide usage or billing monitoring.

The app's `* * * * *` Cron handles OpenConnector cleanup and trigger maintenance. It consumes a separate account Cron slot and is **not** the FlarePort Bot's shared update scheduler. The template uses R2 by default; optional MCP OAuth/KV modes are not configured automatically.

## Updates and migration

Choose one scheduled updater per deployment: the FlarePort Bot **or** the repository Actions fallback described below. Do not run the old `Sync latest upstream release` direct-to-main workflow alongside either updater. Bot installation and repository registration are separate from initial deployment; public self-service Bot onboarding is not yet available.

Adapter 0.1.7 changes build scripts and configuration as well as the upstream version. Existing 0.1.6 or full-source `open-connector-cloudflare` repositories need a reviewed migration; the Bot's version-only releases deliberately refuse to change that wiring. Start with a separate test deployment and keep the old service untouched until migration is verified.

The copied repository includes a weekly/manual updater. Its read-only job resolves FlarePort's configured branch to a full commit, seals the candidate as a hashed artifact, and then builds the untrusted upstream without credentials. A separate job receives the write token, starts from a clean checkout with persisted Git credentials disabled, verifies the sealed hash, and creates the branch and PR through GitHub's API. It never runs candidate or upstream code.

Automatic merge is user-owned. Copy `flareport.user.example.json` to `flareport.user.json`, commit it, set `autoMerge` to `true`, and list the checks you require in `requiredChecks` as an explicit local safety acknowledgement. After validating the sealed candidate, the updater publishes a successful `Validate deployment` Check Run on the exact candidate commit and requests GitHub native auto-merge. The updater does not read or verify Branch Protection; GitHub Branch Protection and native auto-merge enforce the repository's configured required checks. This local policy file is deliberately absent from `managedFiles`, so central updates cannot enable auto-merge. Central metadata is only a permission ceiling: an update may disable automatic merging, but cannot re-enable it after it has been disabled.

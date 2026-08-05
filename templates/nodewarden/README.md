# NodeWarden on Cloudflare · FlarePort

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LJAYi/flareport/tree/main/templates/nodewarden)

This standalone directory is the Cloudflare Deploy Button root for NodeWarden. It intentionally contains no copy of the upstream source: the build downloads the exact commit in `upstream.lock.json`, verifies the archive SHA-256, extracts it under ignored `.flareport/upstream`, builds it, and deploys from there.

## Build contract

1. FlarePort validates the central adapter manifest and the copied `upstream.lock.json` before publishing this template.
2. Run `npm run build`; `scripts/prepare-upstream.mjs` fetches the immutable archive and verifies its SHA-256 before extraction.
3. Install from the upstream lockfile and run NodeWarden's web-vault build inside `.flareport/upstream`.
4. Run `npm run deploy`; Wrangler uses the root adapter configuration while its entry point and assets point at that verified workspace.
5. Never fetch `main`, `latest`, or another floating ref during deployment.

## User-owned configuration

Cloudflare asks for `JWT_SECRET`; its real value belongs in Cloudflare Secrets, never in Git. D1, R2, and both Durable Objects are provisioned from `wrangler.jsonc`. Dashboard variables are retained across deployments through `keep_vars`.

The copied repository includes a weekly/manual updater. Its read-only job resolves FlarePort's configured branch to a full commit, seals the candidate as a hashed artifact, and then builds the untrusted upstream without credentials. A separate job receives the write token, starts from a clean checkout with persisted Git credentials disabled, verifies the sealed hash, and creates the branch and PR through GitHub's API. It never runs candidate or upstream code.

Automatic merge is user-owned. Copy `flareport.user.example.json` to `flareport.user.json`, commit it, set `autoMerge` to `true`, and list the checks you require in `requiredChecks` as an explicit local safety acknowledgement. After validating the sealed candidate, the updater publishes a successful `Validate deployment` Check Run on the exact candidate commit and requests GitHub native auto-merge. The updater does not read or verify Branch Protection; GitHub Branch Protection and native auto-merge enforce the repository's configured required checks. This local policy file is deliberately absent from `managedFiles`, so central updates cannot enable auto-merge. Central metadata is only a permission ceiling: an update may disable automatic merging, but cannot re-enable it after it has been disabled. Password-manager deployments should normally keep `autoMerge` false.

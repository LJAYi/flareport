# FlarePort repository guidance

## Ownership boundaries

- `packages/adapter-core`: manifest, lock file, source planning, and generation primitives.
- `apps/github-bot`: GitHub App webhook, rollout, and pull-request orchestration.
- `adapters`: reviewed project-specific facts and immutable upstream locks.
- `templates`: generated, standalone Deploy to Cloudflare inputs.
- `src`: repository-level catalog and CLI integration.

Do not make one package import source files owned by another package through relative path traversal. Public cross-package contracts must be exported from the owning package.

## Security

- Never fetch or deploy an unpinned branch. Resolve releases to a full commit SHA before generation.
- Never commit user secrets, Cloudflare credentials, GitHub installation tokens, or resource identifiers.
- Treat upstream archives, manifests, webhook payloads, paths, and build output as untrusted input.
- User repositories and Cloudflare resources remain user-owned. The GitHub App may request only repository contents, pull requests, metadata, and checks permissions.
- Automatic merging must remain opt-in and gated by required checks. Staged rollout cannot override a repository's local update policy.

## Verification

Run `npm run check` before merging. Template directories must remain isolated because Cloudflare treats a Deploy Button subdirectory as the root of the generated repository.

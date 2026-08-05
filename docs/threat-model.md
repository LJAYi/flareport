# Threat model

FlarePort executes and republishes third-party source, then proposes updates to repositories that can deploy into Cloudflare accounts. The updater is therefore a supply-chain boundary.

## Protected assets

- integrity of generated deployment repositories;
- GitHub installation tokens and repository write access;
- Cloudflare build credentials available only inside a user's Workers Builds project;
- runtime secrets and user data, which FlarePort must never receive;
- rollout evidence used to permit automatic merging.

## Required controls

### Upstream source

- Resolve a release to a full commit SHA and store it in an immutable lock file.
- Reject archive entries that are absolute, contain `..`, escape the generation root, or represent links/devices/special files.
- Bound compressed bytes, member count, expanded bytes, and total TAR stream size; rebuild the extraction tree for every validation.
- Do not restore upstream `.github` workflows into a generated deployment repository.
- Run generation and validation with no production secrets.
- Preserve upstream license and notice files.

### Generated repository

- Own update workflows, Wrangler overlays, and FlarePort metadata in the adapter.
- Keep runtime secrets in Cloudflare bindings, never generated files.
- Use deterministic update branch names so retries cannot create competing pull requests.
- Require a clean validation result before requesting auto-merge.
- Run untrusted upstream validation in a read-only job, seal the candidate first, and use a separate clean write job that never executes candidate code.
- Keep user merge policy outside the centrally managed file set. Central policy may revoke permission but cannot grant it back.

### GitHub App

- Verify every webhook signature before parsing or dispatching an event.
- Request access only to metadata, contents, pull requests, and checks for selected repositories.
- Keep installation tokens short-lived and out of logs and persistent rollout records.
- Treat repository policy as authoritative. A central rollout may pause an update but cannot enable auto-merge where the repository selected manual mode.
- Accept dispatches only for immutable content-addressed artifacts published under a separate credential; reject workflow, Git metadata, CODEOWNERS, and unsafe paths.
- Fail closed when a deterministic update branch exists but cannot be proven to belong to the recorded updater flow.

### Rollout evidence

- Count a repository at most once per update.
- Record successful checks separately from optional runtime health reports.
- Open the next channel only after both the success threshold and observation window pass.
- Pause on excessive failures. Never interpret missing telemetry as success.
- Do not let administrative rollout observations directly arm auto-merge; require a future signed check/deployment handler bound to the exact PR head.

## Explicit non-goals

FlarePort does not promise that arbitrary Node.js, container, or filesystem-dependent software is compatible with Workers. Admission to the catalog requires a reviewed adapter and repeatable validation.

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
- Select one server-owned scheduler mode: Cloudflare, GitHub, or manual-only. The Worker rejects wrong-mode HTTP sources and ignores native ticks in non-native modes; invalid explicit mode values fail closed. The source header is authenticated routing metadata, not proof of GitHub identity, and the caller cannot select server mode or update permissions. Gate off the Actions caller, stop native Cron if present, and drain in-flight work before switching. Authenticate external reconciliation with a separate scheduler-only secret; it cannot publish artifacts or change registration, rollout config or merge policy. Restrict scheduled/manual Actions calls to the default branch in a dedicated environment, with no checkout, GitHub write permissions or upstream execution. Reject HTTP redirects before sending credentials elsewhere; wait for completion and report partial failures. Neither the mode gate nor Actions concurrency is a distributed lock against old deployed versions, native ticks or in-flight work; cancellation/timeouts do not prove remote side effects stopped. Manual-only scheduling does not disable signed webhooks or revoke merge opt-ins.
- Treat repository policy as authoritative. A central rollout may pause an update but cannot enable auto-merge where the repository selected manual mode.
- Accept dispatches only for immutable content-addressed artifacts published under a separate credential; reject workflow, Git metadata, CODEOWNERS, and unsafe paths.
- Fail closed when a deterministic update branch exists but cannot be proven to belong to the recorded updater flow.

### Rollout evidence

- Count a repository at most once per update.
- Record successful checks separately from optional runtime health reports.
- Open the next channel only after both the success threshold and observation window pass.
- Pause on excessive failures. Never interpret missing telemetry as success.
- Do not let administrative reports open automatic gates. Re-read signed notifications through the installation's GitHub API access, require the official Cloudflare App and configured Worker check, and bind deployment evidence to the recorded PR's merge SHA and immutable artifact.
- Persist evidence and its revision atomically; compare state and revision before promoting a phase. Retain late failures across phase changes.
- Re-check local authorization after the last PR lookup and merge only the expected head SHA. D1 and GitHub cannot commit atomically: a later pause cannot recall a merge already in flight, and successful build/deployment evidence does not prove runtime or migration health.

## Explicit non-goals

FlarePort does not promise that arbitrary Node.js, container, or filesystem-dependent software is compatible with Workers. Admission to the catalog requires a reviewed adapter and repeatable validation.

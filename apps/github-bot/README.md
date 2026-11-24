# FlarePort GitHub App core

Cloudflare Worker for repository registration, GitHub App installation authentication, gated update PRs, and staged rollouts. State is persisted in D1; tests can inject `MemoryStateStore` and mocked GitHub clients.

The production App is **FlarePort Bot** (`flareport-bot`), served by the `flareport` Worker. The test identity is **FlarePort Bot Canary** (`flareport-bot-canary`). Keep App IDs, installation IDs, and private keys tied to their original App when renaming; do not create replacement identities just to change their names.

For an existing `flareport-github-bot` Worker, use Cloudflare's [partial Worker update](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/methods/edit/) to rename the same Worker, then update the App webhook and `FLAREPORT_BOT_URL` to the new HTTPS origin. Verify the Worker ID, active version, secret bindings, D1 binding, and single Cron are preserved. Changing only Wrangler's name and deploying can create a second Worker instead. Preserve the existing D1 identity and database name (`flareport-github-bot` in the original installation); renaming the Worker does not require a new database or key rotation.

## Worker bindings

Set the string values as Worker secrets; never commit them:

| Binding | Purpose |
| --- | --- |
| `WEBHOOK_SECRET` | Verifies `X-Hub-Signature-256` on GitHub webhook requests |
| `ADMIN_TOKEN` | Bearer token protecting management and dispatch routes |
| `ARTIFACT_TOKEN` | Separate publisher credential for immutable artifacts and automatic-release activation |
| `SCHEDULER_TOKEN` | Separate credential permitting only a reconciliation tick, not management or publication |
| `APP_ID` | Numeric GitHub App ID used as the JWT issuer |
| `PRIVATE_KEY` | GitHub App RSA private key; PKCS#1 and PKCS#8 PEM are accepted |
| `DB` | D1 database containing installations, repository policies, and rollout state |

Create D1, replace the placeholder `database_id` in `wrangler.jsonc`, apply `migrations/`, then set the string values with `wrangler secret put`. `SCHEDULER_TOKEN` is optional unless using the GitHub/manual HTTP caller; native Cron does not need it. `MemoryStateStore` is ephemeral and intended for tests only; both scheduler entry points require App configuration and durable D1 outside injected tests.

`AUTO_DISPATCH_ENABLED` is a non-secret Worker variable, shipped as `"false"`. Setting it to `"true"` lets reconciliation create eligible PRs for registered repositories. It does not grant auto-merge permission, enable branch settings, or subscribe unregistered repositories. See [publication setup](../../docs/adapter-lifecycle.md#bot-publication-and-dispatch) for the separate central CI opt-in.

## Central scheduler

Choose one of three modes without editing Worker or workflow code. The non-secret Worker variable `SCHEDULER_MODE` is authoritative. The central GitHub repository variable `FLAREPORT_BOT_SCHEDULER_MODE` mirrors that choice only to avoid unnecessary Actions calls; it cannot override the Worker. The Bot identity, private key, D1, reconciliation and merge gates stay in the same Worker in every mode.

| Mode | Worker `SCHEDULER_MODE` | Wrangler `triggers.crons` | GitHub `FLAREPORT_BOT_SCHEDULER_MODE` | Execution |
| --- | --- | --- | --- | --- |
| Cloudflare (default) | `cloudflare` | `["*/5 * * * *"]` | `cloudflare` | Native Cron every five minutes; Actions caller skipped |
| GitHub | `github` | `[]` | `github` | Actions schedule every five minutes, or **Run workflow** |
| Manual only | `manual` | `[]` | `manual` | **Run workflow** only; no periodic reconciliation |

Persist the Worker mode and Cron list in the operator's Wrangler config so the next deployment preserves the choice. Native mode consumes one Cron slot for all registered templates/deployments, not one per user or template; GitHub/manual mode consumes none after removing native Cron. Setting the mode alone does not free an existing Cron slot. The GitHub variable is under repository **Settings > Secrets and variables > Actions > Variables**. This is configuration-based selection, not a cross-platform one-click settings UI.

An absent Worker mode retains the native default for existing installations; an explicitly invalid value fails closed. An unset/invalid GitHub mode skips the Actions job. Native events are ignored in GitHub/manual mode. HTTP requests require `x-flareport-trigger: github-schedule` or `manual`; scheduled HTTP calls are accepted only in GitHub mode, manual calls in GitHub/manual mode, and neither in Cloudflare mode. Mismatches return 409 before reconciliation. The header is routing metadata from the authenticated scheduler, not independent proof of GitHub identity. Request bodies, query parameters and workflow inputs cannot select the Worker's mode or grant update permissions.

### Switching safely

1. Set `FLAREPORT_BOT_SCHEDULER_MODE=cloudflare` to gate off the Actions caller, regardless of the intended final mode. Wait for in-flight Actions/HTTP work to finish. Cancellation or timeout does not prove that remote work stopped.
2. If a native Cron exists, remove it and persist `triggers.crons: []`. Allow up to 15 minutes for Cloudflare schedule propagation, then verify old invocations have stopped and in-flight work has drained before changing mode. Do not use a blind sleep as proof that work finished.
3. Set and deploy the intended Worker `SCHEDULER_MODE` and Cron list from the table. For native mode, first confirm a free account Cron slot; never remove another application's schedule without its owner's approval. Preserve D1, secrets and update policy; no migration or token rotation is needed.
4. Set the GitHub mirror to the chosen mode **last**. Verify a real `scheduler-reconcile` success event or completed Actions run, not merely `/healthz` or configured triggers. Native `scheduler-skipped` logs mean an ignored source, not a completed reconciliation. For GitHub mode, test manual dispatch and then separately check that a `schedule` event ran; GitHub timing remains best-effort.

Manual-only refers to periodic reconciliation, not a global suspension of the Bot: signed webhooks still run, and existing PR/merge policies remain authoritative. To run manually while using native Cron, switch safely to manual mode first; the Actions button cannot bypass native-mode protection. Stopping all update activity requires separate publication/dispatch and merge-policy controls.

Migration from the earlier boolean switch: deploy this source-gated Worker first, keep the old `FLAREPORT_BOT_SCHEDULER_ENABLED=false` while the older workflow is present, then install the new workflow and configure the new mode variable. The old boolean is no longer read by this workflow and is not a kill switch. The native default preserves current Cloudflare installations; older headerless HTTP clients must be updated before opting into GitHub/manual mode.

### GitHub and manual caller setup

Configure the existing scheduler-only credential as Worker secret `SCHEDULER_TOKEN` and GitHub environment secret `FLAREPORT_SCHEDULER_TOKEN` in the central repository's `flareport-scheduler` environment, restricted to the default branch. For first-time setup generate a distinct random credential; do not print, commit or pass it as a workflow input. Set `FLAREPORT_BOT_URL` to the Worker's HTTPS origin (no path, credentials, query or fragment). No Cloudflare management token or App private key goes into Actions.

The workflow has both `schedule` and `workflow_dispatch` triggers, but its mode gate decides whether the job calls the Bot. In GitHub/manual mode, select **Actions > Reconcile FlarePort Bot > Run workflow** on the default branch. Native/manual-only configurations may still show **skipped** scheduled workflow runs in GitHub; those do not call the Worker. Inspect the job, not just the presence of a workflow run. HTTP 400 indicates missing/invalid source metadata, 409 indicates a mode mismatch, and 503 indicates invalid mode or missing App/D1 configuration.

The job has no GitHub token permissions and performs no checkout, install or upstream execution. It uses only the scheduler credential, rejects redirects, waits for a completed HTTP 200 response with a successful result, and times out after four minutes (six-minute job limit). Missing App/DB configuration returns 503; failed reconciliation returns 502, including per-repository failures. Other repositories can still be examined, but new automatic dispatch is skipped if recovery was incomplete. Dispatch failures are reported even when other dispatches succeeded. An HTTP failure is **not** a rollback of earlier side effects.

GitHub concurrency serializes its scheduled and manual jobs with cancellation disabled, not native Cron. There are no immediate HTTP retries after ambiguous errors; existing dispatch records, evidence deduplication and exact-head merge guards support later reconciliation. A mode gate is **not a distributed execution lock**: old deployed versions/in-flight work can outlive a configuration change, and long native ticks can overlap. Follow the drain procedure above; investigate timeout/orphan-branch failures before retrying. Large fleets need batching and execution coordination before they approach execution limits or the five-minute interval. Re-enabling a timer never changes a deployment repository's opt-in policy.

GitHub scheduling is best-effort and may delay or drop runs; inactive public-repository schedules can also be disabled after 60 days without activity. Native Cron also is not an exact-time or exactly-once guarantee. See [Cloudflare Cron behavior](https://developers.cloudflare.com/workers/configuration/cron-triggers/) and [account limits](https://developers.cloudflare.com/workers/platform/limits/).

Application schedules are separate: this Bot does not execute NodeWarden backups or OpenConnector cleanup, access application data, or receive user Cloudflare credentials. The public-template upstream discovery workflow remains a separate daily/manual Actions job. Only Bot reconciliation uses this mode selection.

## HTTP contract

Bodies and responses are JSON unless empty. Management routes require `Authorization: Bearer <ADMIN_TOKEN>`. Artifact publication requires the distinct `ARTIFACT_TOKEN`; scheduler calls require only `SCHEDULER_TOKEN`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Liveness |
| `POST` | `/webhooks/github` | Signed GitHub App webhook; installation lifecycle and completed Check Run reconciliation |
| `POST` | `/api/scheduler/reconcile` | Scheduler-token-only tick with `x-flareport-trigger: github-schedule` or `manual`; server mode must permit that source; waits for recovery and optional dispatch to complete |
| `PUT` | `/api/artifacts/:sha256` | Publish an immutable artifact whose canonical body hashes to the path ID |
| `PUT` | `/api/releases/:template/:version` | Publisher-token-only activation of `{ artifactId }` for automatic PR dispatch; fixed default gates |
| `GET` | `/api/installations/:id` | Read installation state |
| `PUT` | `/api/repositories/:owner/:repo` | Register/update `{ installationId, template, mode, channel?, enabled?, deploymentCheck? }` |
| `GET` | `/api/repositories/:owner/:repo` | Read repository policy/state |
| `POST` | `/api/repositories/:owner/:repo/dispatch` | Dispatch one validated artifact using its installation token and rollout policy |
| `PUT` | `/api/rollouts/:template/:version` | Start an idempotent rollout; optional gate config |
| `GET` | `/api/rollouts/:template/:version` | Read phase, gates, and observations |
| `POST` | `/api/rollouts/:template/:version/events` | Record an administrative report; never used to open automatic rollout gates |
| `GET` | `/api/rollouts/:template/:version/observations` | Read verified provider observations, including merge SHA, Check Run ID and deployed version ID |
| `POST` | `/api/rollouts/:template/:version/advance` | Re-evaluate observation window and stage gates |
| `GET` | `/api/rollouts/:template/:version/decisions` | Explain PR/auto-merge decision per repository |

Repository modes are `manual`, `auto`, and `staged-auto`. Channels are `canary`, `early`, and `stable`. If a channel is omitted, a stable deterministic cohort is assigned from template plus repository name.

`UpdateOrchestrator` consumes only an artifact already published into the trusted artifact store. It creates all blobs, one tree and one commit through the Git Data API, then creates the update ref directly at that commit. Files are therefore never exposed as a sequence of partially committed branch updates. If the branch name already exists, its tip must equal the commit just prepared; otherwise dispatch stops to prevent branch squatting.

The dispatch body is only `{ artifactId }`. The endpoint derives the files, version, commit, template and installation from server-side state, and requires the rollout to reference the exact same immutable artifact. Callers cannot supply paths or file content at dispatch time. Artifact publication rejects `.github/**`, `.git/**`, `CODEOWNERS`, traversal, absolute paths, backslashes and NUL bytes.

After PR creation, the App publishes a successful `FlarePort artifact integrity` Check Run on the exact PR head SHA. This proves that the immutable artifact came through the separately authenticated publication boundary; it does not claim that the user deployment built or ran successfully.

Automatic releases use the adapter's stable `x.y.z` version, not the upstream version. They contain exactly `UPSTREAM.md`, `upstream.lock.json`, `flareport.json`, and `package.json`. Dispatch updates only the adapter/upstream metadata and package version in the two JSON files, preserving other local fields. `autoMergeAllowed: false` is sticky. It refuses changed package scripts/engine/dependency wiring, uses a pinned base SHA, and aborts if that base moves before branch creation. The integrity check covers the trusted source artifact plus this deterministic preservation step, not a byte-for-byte replacement of local JSON with the public template. Wrangler configuration, secrets, resource identities and workflows are never included in automatic-release artifacts.

PR creation never merges. The Check Run handler and central reconciliation timer separately evaluate the latest tracked update. Automatic merging requires all of:

- an active installation, enabled registration, `auto` or eligible `staged-auto` mode, and a non-paused rollout;
- the repository's `allow_auto_merge` setting enabled, its default branch protected, and an App-bound required `Validate deployment` check from GitHub Actions (App ID 15368);
- `flareport.user.json` on the current base branch explicitly opting in with `autoMerge: true` and `requiredChecks` including `Validate deployment`;
- `flareport.json` on both base and candidate retaining `management.autoMergeAllowed: true`;
- the recorded, unedited PR head, this App's matching artifact-integrity check, and every branch-required check successfully completed on that exact head.

The handler uses GitHub's native squash-merge API with the expected head SHA as a precondition. GitHub enforces its branch rules; the bot requests no bypass. The queued auto-merge mutation is not used because it cannot pin the expected head. Missing policy, missing/ambiguous protection, stale checks, changed heads, disabled installations, superseded updates and paused releases all fail closed. The App permissions remain contents, pull requests, metadata and checks only.

The Deploy Button may strip template Actions workflows. Before opting a user repository into auto-updates, the owner must install/review its validation workflow and configure branch-required checks. FlarePort artifacts cannot modify workflows or `flareport.user.json`. No part of deployment-result collection enables these settings automatically.

After PR creation, FlarePort persists the repository + artifact ID, branch, head SHA and PR identity in D1. Retrying a completed dispatch returns that trusted record and performs no GitHub write. There is deliberately no unconditional recovery from an unknown pre-existing branch. If GitHub accepted the ref but PR creation or D1 recording then failed, dispatch fails closed; an operator must inspect and delete that orphaned `flareport/update-*` branch before retrying. Dangling blobs, trees or commits created before the ref are harmless and expire under GitHub's normal object maintenance.

For deployment observations, configure the registration's exact `deploymentCheck`, for example `Workers Builds: my-nodewarden`. Signed `check_run` notifications are re-read using the installation token. Only Cloudflare's official App (ID 85455 and matching slug), the configured Worker check name, and a merged PR matching the stored head/PR/artifact record qualify. The Check's SHA must equal the PR merge commit on the configured default branch. A successful Check must also report a deployed Version ID. PR-head checks are pre-merge validation, not post-merge deployment evidence.

Verified observations have a separate D1 table, unique per repository and Check Run. Repeated deliveries do not add samples; a late old run cannot replace a newer attempt. Observation writes and evidence-revision changes are atomic. Phase changes compare both state and evidence revision, so concurrently arriving failures invalidate a stale promotion decision. Only enabled, eligible registered repositories contribute, once each; this counts deployment repositories, not distinct people. Administrative reports remain audit data and never count. Observation windows start no earlier than the first qualifying result. Excessive failures pause even stable rollout; historical phases without verified provenance cannot authorize staged auto-merges.

Promotion successes are counted within the current phase. The failure circuit retains the latest result per eligible repository across the whole release, including late callbacks from a previous phase. It uses the current phase's failure-rate limit and the smaller of the canary/current phase minimum sample counts, so moving to early/stable does not reset failure protection. Registration, installation, superseding dispatch and evidence are checked again after the final GitHub PR lookup. There is no distributed transaction between D1 and GitHub: a pause arriving after the final local check cannot recall an in-flight merge. GitHub still enforces the expected head SHA and branch rules; already merged/deployed updates are not automatically rolled back.

Reconciliation first recovers missed callbacks for the latest tracked PR per repository and advances elapsed observation windows. With automatic dispatch enabled and recovery successful, it then creates PRs for newly eligible repositories using only the highest activated adapter version per template. A paused latest version never falls back to an older release. Missing/inactive installations are skipped; a failure in one dispatch does not block others. Already dispatched, current or newer repositories are not rewritten. Republishing a release cannot reset a pause, observation window or evidence. A newer activated release also blocks older automatic-release PRs from automatic merging; old PRs are not deleted. A Cloudflare build/deployment success is not application health or a guarantee of defect-free data migration.

Apply migration `0004_verified_deployments.sql` before deploying this version. The HTTP scheduler requires no additional migration. The MVP has explicit bounds: 100 repositories/releases, latest 50 stored dispatches per repository, and 1000 provider observations per release. Add pagination/retention before fleet-scale use. Reconciliation uses GitHub API requests, Worker execution and D1 reads; moving the timer does not eliminate these costs and is not account-usage or billing monitoring.

## Test

Requires Node 24:

```sh
npm test
```

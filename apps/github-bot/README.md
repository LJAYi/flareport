# FlarePort GitHub App core

Cloudflare Worker for repository registration, GitHub App installation authentication, gated update PRs, and staged rollouts. State is persisted in D1; tests can inject `MemoryStateStore` and mocked GitHub clients.

## Worker bindings

Set the string values as Worker secrets; never commit them:

| Binding | Purpose |
| --- | --- |
| `WEBHOOK_SECRET` | Verifies `X-Hub-Signature-256` on GitHub webhook requests |
| `ADMIN_TOKEN` | Bearer token protecting management and dispatch routes |
| `ARTIFACT_TOKEN` | Separate publisher credential for immutable artifacts and automatic-release activation |
| `APP_ID` | Numeric GitHub App ID used as the JWT issuer |
| `PRIVATE_KEY` | GitHub App RSA private key; PKCS#1 and PKCS#8 PEM are accepted |
| `DB` | D1 database containing installations, repository policies, and rollout state |

Create D1, replace the placeholder `database_id` in `wrangler.jsonc`, apply `migrations/`, then set all five string values with `wrangler secret put`. `MemoryStateStore` is ephemeral and intended for tests only; the default Worker selects `D1StateStore` whenever `DB` is bound.

`AUTO_DISPATCH_ENABLED` is a non-secret Worker variable, shipped as `"false"`. Setting it to `"true"` lets the cron create eligible PRs for registered repositories. It does not grant auto-merge permission, enable branch settings, or subscribe unregistered repositories. See [publication setup](../../docs/adapter-lifecycle.md#bot-publication-and-dispatch) for the separate central CI opt-in.

## HTTP contract

All bodies and responses are JSON. Management routes require `Authorization: Bearer <ADMIN_TOKEN>`. Artifact publication requires the distinct `ARTIFACT_TOKEN`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Liveness |
| `POST` | `/webhooks/github` | Signed GitHub App webhook; installation lifecycle and completed Check Run reconciliation |
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

PR creation never merges. The Check Run handler and five-minute reconciliation cron separately evaluate the latest tracked update. Automatic merging requires all of:

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

The cron first recovers missed callbacks for the latest tracked PR per repository and advances elapsed observation windows. With automatic dispatch enabled, it then creates PRs for newly eligible repositories using only the highest activated adapter version per template. A paused latest version never falls back to an older release. Missing/inactive installations are skipped; a failure in one dispatch does not block others. Already dispatched, current or newer repositories are not rewritten. Republishing a release cannot reset a pause, observation window or evidence. A newer activated release also blocks older automatic-release PRs from automatic merging; old PRs are not deleted. A Cloudflare build/deployment success is not application health or a guarantee of defect-free data migration.

Apply migration `0004_verified_deployments.sql` before deploying this version. The MVP has explicit bounds: 100 repositories/releases, latest 50 stored dispatches per repository, and 1000 provider observations per release. Add pagination/retention before fleet-scale use. Cron uses GitHub API requests and D1 reads; it is not account-usage or billing monitoring.

## Test

Requires Node 24:

```sh
npm test
```

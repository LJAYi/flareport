# FlarePort GitHub App core

Cloudflare Worker for repository registration, GitHub App installation authentication, gated update PRs, and staged rollouts. State is persisted in D1; tests can inject `MemoryStateStore` and mocked GitHub clients.

## Worker bindings

Set the string values as Worker secrets; never commit them:

| Binding | Purpose |
| --- | --- |
| `WEBHOOK_SECRET` | Verifies `X-Hub-Signature-256` on GitHub webhook requests |
| `ADMIN_TOKEN` | Bearer token protecting management and dispatch routes |
| `ARTIFACT_TOKEN` | Separate publisher credential for immutable, content-addressed artifacts |
| `APP_ID` | Numeric GitHub App ID used as the JWT issuer |
| `PRIVATE_KEY` | GitHub App RSA private key; PKCS#1 and PKCS#8 PEM are accepted |
| `DB` | D1 database containing installations, repository policies, and rollout state |

Create D1, replace the placeholder `database_id` in `wrangler.jsonc`, apply `migrations/`, then set all five string values with `wrangler secret put`. `MemoryStateStore` is ephemeral and intended for tests only; the default Worker selects `D1StateStore` whenever `DB` is bound.

## HTTP contract

All bodies and responses are JSON. Management routes require `Authorization: Bearer <ADMIN_TOKEN>`. Artifact publication requires the distinct `ARTIFACT_TOKEN`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Liveness |
| `POST` | `/webhooks/github` | Signed GitHub App webhook; tracks installation lifecycle |
| `PUT` | `/api/artifacts/:sha256` | Publish an immutable artifact whose canonical body hashes to the path ID |
| `GET` | `/api/installations/:id` | Read installation state |
| `PUT` | `/api/repositories/:owner/:repo` | Register/update `{ installationId, template, mode, channel?, enabled? }` |
| `GET` | `/api/repositories/:owner/:repo` | Read repository policy/state |
| `POST` | `/api/repositories/:owner/:repo/dispatch` | Dispatch one validated artifact using its installation token and rollout policy |
| `PUT` | `/api/rollouts/:template/:version` | Start an idempotent rollout; optional gate config |
| `GET` | `/api/rollouts/:template/:version` | Read phase, gates, and observations |
| `POST` | `/api/rollouts/:template/:version/events` | Record repository, artifact, version, commit and result evidence |
| `POST` | `/api/rollouts/:template/:version/advance` | Re-evaluate observation window and stage gates |
| `GET` | `/api/rollouts/:template/:version/decisions` | Explain PR/auto-merge decision per repository |

Repository modes are `manual`, `auto`, and `staged-auto`. Channels are `canary`, `early`, and `stable`. If a channel is omitted, a stable deterministic cohort is assigned from template plus repository name.

`UpdateOrchestrator` consumes only an artifact already published into the trusted artifact store. It creates all blobs, one tree and one commit through the Git Data API, then creates the update ref directly at that commit. Files are therefore never exposed as a sequence of partially committed branch updates. If the branch name already exists, its tip must equal the commit just prepared; otherwise dispatch stops to prevent branch squatting.

The dispatch body is only `{ artifactId }`. The endpoint derives the files, version, commit, template and installation from server-side state, and requires the rollout to reference the exact same immutable artifact. Callers cannot supply paths or file content at dispatch time. Artifact publication rejects `.github/**`, `.git/**`, `CODEOWNERS`, traversal, absolute paths, backslashes and NUL bytes.

For this MVP, PR creation never enables auto-merge. `auto` and eligible `staged-auto` policies mean “create the PR automatically”; their decision remains `pending-checks`. `GitHubClient.enableAutoMerge` is reserved for a later signed `check_run`/deployment handler that binds an accurate Check Run to the exact PR head SHA. That handler will not read or validate Branch Protection itself: GitHub native auto-merge and Branch Protection remain responsible for enforcing the repository's configured required checks.

After PR creation, FlarePort persists the repository + artifact ID, branch, head SHA and PR identity in D1. Retrying a completed dispatch returns that trusted record and performs no GitHub write. There is deliberately no unconditional recovery from an unknown pre-existing branch. If GitHub accepted the ref but PR creation or D1 recording then failed, dispatch fails closed; an operator must inspect and delete that orphaned `flareport/update-*` branch before retrying. Dangling blobs, trees or commits created before the ref are harmless and expire under GitHub's normal object maintenance.

The staged gate counts the latest rollout result per repository during the current phase. Event ingestion rejects unknown, disabled, wrong-template and out-of-phase repositories, and requires the exact rollout artifact ID, version and upstream commit. It advances only after both the success threshold and observation window pass. It pauses when the configured failure rate is exceeded after the minimum sample size. In this MVP the events route is protected administrative input, not yet evidence derived from a signed GitHub deployment webhook, so it cannot directly arm auto-merge.

For the MVP, each D1 rollout row stores its observation events as JSON. This keeps state transitions atomic and understandable, but it is not intended as an unbounded analytics store; production operation should retain a bounded observation window or move events into an append-only table before fleet scale.

## Test

Requires Node 24:

```sh
npm test
```

# Architecture

FlarePort is an open-source control repository for reviewed Cloudflare deployment adapters. It does not hold user Cloudflare credentials or deploy applications on a user's behalf.

## Planes

### Catalog plane

The central repository owns adapter manifests, immutable upstream locks, generators, validation, release channels, and the optional GitHub App. Central CI publishes only updates that pass project tests and a Wrangler dry run.

### User plane

A Deploy to Cloudflare button copies one isolated template directory into a new repository owned by the user. Workers Builds deploys that repository into the user's Cloudflare account. Runtime secrets and provisioned resources live only in that account.

Each application gets a separate deployment repository by default. A future fleet mode may coordinate several repositories, but must not merge their secrets or Cloudflare resources.

## Update modes

- `manual`: create a pull request and wait for the user.
- `auto`: create a pull request automatically; after publishing an accurate Check Run for the validated candidate commit, the repository Actions path may request native auto-merge. GitHub Branch Protection, not the updater, enforces user-owned required checks.
- `staged-auto`: additionally wait for the selected rollout channel to open.

The generated repository contains a fallback update workflow, though the Deploy Button may strip it from the created repository. The optional `flareport-bot[bot]` GitHub App has a separate, opt-in publication/dispatch path: successful main-branch CI publishes four version files, then the Bot delivers PRs to eligible registered repositories. Its reconciliation source is selectable: Cloudflare Cron (default), central GitHub Actions Cron, or manual-only. All modes reuse the same Worker backend, App credentials and D1; there are no per-user timers in the App path. The Worker's `SCHEDULER_MODE` is authoritative, and the GitHub mode mirror only gates the caller. Source checks prevent wrong-mode reconciliation, but configuration changes require stopping and draining the old source because mode selection is not a distributed lock. CI publishing, Bot deployment and automatic dispatch each require explicit setup; none enables auto-merge. Both updater paths use deterministic branch names and safely reuse completed dispatches. They fail closed on unknown occupied branches; an interrupted App dispatch that created a ref but not a PR may require operator recovery. Choose one scheduled updater per repository. See [scheduler setup and limits](../apps/github-bot/README.md#central-scheduler).

The daily public-template upstream discovery workflow is separate from Bot reconciliation. Likewise, application-local schedules (backups, subscription cleanup, and other runtime jobs) belong to the user plane; installing the GitHub App does not migrate or share those schedules, runtime secrets, or data.

The App's automatic merge gate reads user opt-in from the base branch, verifies App-bound branch-required checks and artifact integrity on the exact recorded PR head, and uses GitHub's native merge API with a head-SHA precondition. Repository auto-merge must also be enabled; no branch-rule bypass is requested. See the [App contract](../apps/github-bot/README.md) for all prerequisites. Post-merge Cloudflare results drive staged rollout decisions, not permission to merge the same PR retroactively.

## Staged rollout

Canary and early repositories are selected deterministically from repository coordinate and template. Stable rollout opens only after the configured number of distinct eligible deployment repositories and observation time pass. Signed notifications are re-read from GitHub and must match Cloudflare's App, the configured Worker, and the recorded PR merge SHA/artifact. D1 deduplicates Check Runs and atomically invalidates stale phase decisions when evidence changes. Administrative reports never contribute to automatic gates. Excessive failures pause rollout, including future automatic dispatch. The coordinator selects only the highest activated adapter version per template and never falls back from a paused release. A successful deployment check is not a claim that the application has no runtime defects.

## Configuration ownership

Adapter manifests classify inputs as runtime secrets, runtime text variables, build variables, generated values, or Cloudflare resources. Values never belong in the adapter lock. Dashboard-managed runtime variables must be preserved across Wrangler deployments.

## Trust boundaries

1. Upstream source is untrusted and pinned to a 40-character commit SHA.
2. Adapter overlays are reviewed FlarePort code.
3. Generated templates are reproducible outputs.
4. A user opts into automatic merging in their own repository policy.
5. The GitHub App never receives Cloudflare runtime secrets or application data.

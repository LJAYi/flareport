# FlarePort

> Open-source apps, ported to Cloudflare.

FlarePort is a community-maintained catalog of deployment adapters for open-source projects. Each adapter produces an isolated Deploy to Cloudflare template, preserves upstream attribution, pins immutable source revisions, and carries a safe update path into the repository created for the user.

FlarePort is not an application marketplace or a hosted deployment service. User repositories, Cloudflare resources, secrets, domains, and application data remain user-owned.

## MVP

The initial catalog validates two projects:

- OpenConnector
- NodeWarden

The repository contains four cooperating parts:

- adapter manifests and immutable upstream locks;
- a generator and validation library;
- standalone Deploy to Cloudflare template directories;
- an optional GitHub App core for trusted update PRs, staged rollout, and aggregate rollout observations.

Generated repositories also include a GitHub Actions fallback for users who do not install the App.

## Update policy

Public templates are tracked by the daily/manual **Upstream sync** Actions
workflow. It pins and validates stable upstream releases, then proposes a
version-only PR for maintainer review. It does not automatically merge public
template updates or deploy them to users. See [the release lifecycle](docs/adapter-lifecycle.md)
for permissions, validation boundaries and recovery guidance.

Repositories choose `manual`, `auto`, or `staged-auto`. Automatic merging is opt-in, cannot bypass required checks, and may be paused globally when a rollout exceeds its failure threshold. Sensitive projects should default to manual updates.

The repository Actions fallback and optional GitHub App have separate update paths. Central CI can publish validated version-only artifacts, and the Bot can automatically dispatch eligible update PRs; both switches default off. The App merges only after user/repository opt-in, protected App-bound required checks, and exact-head artifact validation, using GitHub's SHA-conditional merge API without a bypass. Cloudflare's verified post-merge Check Runs provide deduplicated rollout observations; administrative success reports do not open automatic gates. See the [release lifecycle](docs/adapter-lifecycle.md#bot-publication-and-dispatch) for setup and the [App contract](apps/github-bot/README.md) for prerequisites and limits.

The optional Bot uses one [central Cloudflare Cron Trigger](apps/github-bot/README.md#central-scheduler) for reconciliation across all registered templates and deployments. It consumes one cron slot in the Bot operator's account, not one per user or template. GitHub Actions retains a gated manual recovery entry only. Application tasks such as NodeWarden backups and OpenConnector cleanup are separate and are not run by the public Bot.

## Development

Requires Node.js 24 or later.

```bash
npm install
npm run check
```

See [the architecture](docs/architecture.md) for ownership and trust boundaries.

## Upstream first

Every template must link to and credit its upstream project, preserve the upstream license and notices, and distinguish adapter issues from upstream application issues. FlarePort's MIT license covers FlarePort tooling; it does not replace an application's upstream license.

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

Repositories choose `manual`, `auto`, or `staged-auto`. Automatic merging is opt-in, cannot bypass required checks, and may be paused globally when a rollout exceeds its failure threshold. Sensitive projects should default to manual updates.

The repository Actions fallback implements guarded native GitHub auto-merge after verifying the user's required branch checks. The GitHub App MVP deliberately stops after creating a trusted PR: its auto-merge hook remains disabled until a signed check/deployment webhook can bind successful checks to the exact PR head SHA.

## Development

Requires Node.js 24 or later.

```bash
npm install
npm run check
```

See [the architecture](docs/architecture.md) for ownership and trust boundaries.

## Upstream first

Every template must link to and credit its upstream project, preserve the upstream license and notices, and distinguish adapter issues from upstream application issues. FlarePort's MIT license covers FlarePort tooling; it does not replace an application's upstream license.

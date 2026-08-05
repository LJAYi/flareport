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
- `auto`: create a pull request automatically; the repository Actions path may arm native auto-merge only after verifying user-owned required checks.
- `staged-auto`: additionally wait for the selected rollout channel to open.

The generated repository contains a fallback update workflow. When the optional `flareport[bot]` GitHub App is installed, the App becomes the scheduled coordinator and the repository workflow remains available for manual recovery. Both paths use deterministic branch names and safely reuse completed dispatches. They fail closed on unknown occupied branches; an interrupted App dispatch that created a ref but not a PR may require deletion of that orphaned update branch before retrying.

The App MVP does not arm auto-merge. That step is reserved for a signed check/deployment webhook that verifies the exact PR head and configured required checks. This keeps cross-repository rollout coordination available without treating an administrative status report as proof that a deployment passed.

## Staged rollout

Every validated adapter update starts closed. Canary and early repositories are selected deterministically from the repository coordinate and template. Stable rollout opens only after the configured success threshold and observation window pass. Excessive failures pause the rollout. The MVP validates that observations belong to registered in-phase repositories and the exact immutable artifact, but its management endpoint is still a trusted administrative input rather than a signed GitHub deployment signal. A successful deployment check is not a claim that the application has no runtime defects.

## Configuration ownership

Adapter manifests classify inputs as runtime secrets, runtime text variables, build variables, generated values, or Cloudflare resources. Values never belong in the adapter lock. Dashboard-managed runtime variables must be preserved across Wrangler deployments.

## Trust boundaries

1. Upstream source is untrusted and pinned to a 40-character commit SHA.
2. Adapter overlays are reviewed FlarePort code.
3. Generated templates are reproducible outputs.
4. A user opts into automatic merging in their own repository policy.
5. The GitHub App never receives Cloudflare runtime secrets or application data.

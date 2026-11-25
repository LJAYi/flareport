<!-- Keep README.md, README.zh-CN.md, and README.es.md aligned when changing project facts. -->
<h1 align="center">FlarePort</h1>

<p align="center">
  <strong>Great open-source projects, easier to deploy on Cloudflare.</strong><br />
  Open-source apps, ported to Cloudflare.
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a>
</p>

<p align="center">
  <a href="https://github.com/LJAYi/flareport/actions/workflows/ci.yml"><img src="https://github.com/LJAYi/flareport/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="FlarePort tooling: MIT License" /></a>
  <a href="#project-status"><img src="https://img.shields.io/badge/Status-Public%20Preview-f38020" alt="Public Preview" /></a>
</p>

<p align="center">
  <a href="#template-catalog">Choose a template</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#keeping-your-deployment-updated">Updates</a> ·
  <a href="#contributing">Contribute</a> ·
  <a href="#acknowledgments">Acknowledgments</a>
</p>

---

FlarePort is a **community-maintained, non-commercially operated collection of open-source deployment templates**. We bring together Cloudflare adapters, configuration guidance, and update paths for existing open-source projects, so you can start with a deploy button and run the services you like in your own account.

Each application keeps its own license. The catalog also includes source-available releases with additional restrictions, explicitly identified below; FlarePort's MIT license does not remove those restrictions.

**Upstream authors build the apps. FlarePort helps you deploy them. You own your services and data.**

- **Start with a template**: create your deployment repository through the setup flow, without forking FlarePort or the upstream project.
- **Keep ownership**: repositories live in your GitHub account; Workers, databases, secrets, and application data live in your Cloudflare account.
- **Trace the source**: builds use a pinned upstream commit and verify the source archive's SHA-256.
- **Choose how to update**: manual review remains available; automatic merging and staged updates require separate configuration and explicit opt-in.

> [!NOTE]
> FlarePort is in public preview. Deployment templates and the update Bot are at different stages of availability; check their status below. This is not a hosted service or a universal tool for converting any GitHub repository into a Worker.

## Template catalog

There are currently **2 templates**. Both are community adaptations, not official endorsements from the upstream projects or Cloudflare.

| Template | Purpose | Status | Deploy |
| --- | --- | --- | --- |
| **[NodeWarden](templates/nodewarden/README.md)** | A self-hosted, Bitwarden-compatible password manager | Available to try · Maintainer deployment verified | [![Deploy NodeWarden to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LJAYi/flareport/tree/main/templates/nodewarden) |
| **[OpenConnector](templates/open-connector/README.md)** | A self-hosted authentication gateway connecting AI agents to third-party services; source-available license | Experimental · v1.10.1 build validated; live verification pending | [![Deploy OpenConnector to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LJAYi/flareport/tree/main/templates/open-connector) |

<details>
<summary>Before deploying: resources, required secrets, and known limitations</summary>

| Template | Cloudflare resources | Required Secrets | Upstream and version source |
| --- | --- | --- | --- |
| NodeWarden | Workers, D1, R2, Durable Objects | `JWT_SECRET`: a cryptographically secure random value of at least 32 characters | [shuaiplus/nodewarden](https://github.com/shuaiplus/nodewarden) · [Pinned version](templates/nodewarden/UPSTREAM.md) |
| OpenConnector | Workers, D1, R2 | `OOMOL_CONNECT_ADMIN_TOKEN`, `OOMOL_CONNECT_ENCRYPTION_KEY`: separately generated, long random values | [oomol-lab/open-connector](https://github.com/oomol-lab/open-connector) · [Pinned version](templates/open-connector/UPSTREAM.md) |

OpenConnector is pinned to **v1.10.1**, with the reviewed Cloudflare optimizations from `LJAYi/open-connector-cloudflare`. The archive compatibility issue is fixed without extracting symbolic links. Build and regression checks pass; a fresh deployment and Bot update are still being verified. This release uses the [OpenConnector License](templates/open-connector/licenses/open-connector/LICENSE.txt), **not unmodified Apache-2.0**, and restricts third-party hosted/managed connector services without OOMOL authorization. This template is for deployment in your own account, not a FlarePort-hosted connector service. It also uses one application Cron slot, separate from the Bot scheduler. Existing deployment repositories require a reviewed migration to adapter 0.1.7.

Status checked on 2026-11-25. Maintainer deployment verification is not a full security audit and does not guarantee that every account, configuration, or future version will work without issues.

</details>

## Quick start

**Have a GitHub account and a Cloudflare account ready, then:**

1. **Choose a template.** Read its guide, make sure the required services are enabled, and click **Deploy to Cloudflare**.
2. **Create your deployment repository.** Follow Cloudflare's setup flow to connect GitHub and name your repository, for example `my-nodewarden`. The flow copies the selected template; no double fork is needed.
3. **Configure and deploy.** Enter random secrets in Cloudflare Secrets and review the resource and build settings. The build fetches and verifies the pinned upstream source.
4. **Open your service.** Once the build finishes, visit the address provided by Cloudflare and follow the upstream documentation to complete setup. Add a custom domain if needed.

**Deploying an application does not require installing FlarePort Bot or deploying the Bot into your account.** Cloudflare's GitHub integration handles builds and deployments; FlarePort Bot is a separate, optional update-management path.

> [!IMPORTANT]
> A deploy button does not mean zero configuration or free hosting forever. Check service activation requirements, [usage limits](https://developers.cloudflare.com/workers/platform/limits/), and [pricing](https://developers.cloudflare.com/workers/platform/pricing/) for Workers, D1, R2, and other required services. Never commit real secrets or post them in issues. Verify backup and recovery before storing important data, especially in a password vault.

### Deploying multiple services?

Deploy each service separately, with its own deployment repository and application Worker by default. Account connections can usually be reused; secrets, domains, and data are managed separately. Adding services to the same account does not create a separate account-level free allowance for each service.

For multiple instances of the same template, check and distinguish Worker, D1, and R2 names and bindings to avoid accidentally reusing existing resources. Once update management is configured, one FlarePort Bot can manage multiple registered deployments.

## Keeping your deployment updated

Updates have two layers: **upstream release → FlarePort validates and reviews a template update → your deployment repository receives an update PR → merging triggers a Cloudflare build and deployment.** The last two steps require an update path to be configured; they are not enabled just by clicking the deploy button.

| Update policy | Your involvement | Best suited for |
| --- | --- | --- |
| `manual` | Review the update PR and merge it yourself | Recommended default, especially for password vaults and important data |
| `auto` | Opt in; merging happens only when validation and branch-protection requirements are met | Deployments with verification and recovery measures in place |
| `staged-auto` | Meet automatic-update requirements and also wait for observations from the preceding rollout phase | Deployments participating in staged releases |

There are two update paths. **Choose one scheduled update path per repository**:

- **Repository-local GitHub Actions**: templates include weekly and manually triggered update workflows. The Deploy Button may omit `.github/workflows`; check, restore, and review the workflows and repository permissions after deployment.
- **FlarePort Bot**: a shared GitHub App operated by the maintainer, handling update PRs, merge checks, and staged rollout coordination for registered repositories. Installing the App and registering a template and update policy are separate steps.

> [!WARNING]
> **Complete self-service Bot onboarding is not yet available to third parties.** As of 2026-11-25, the production App is private, repository registration requires maintainer assistance, and central automatic publication and PR dispatch are not enabled. An implemented Bot core does not mean all deployments are automatically subscribed to updates.

Automatic merging always requires explicit user opt-in, required checks, and branch protection; a central template cannot enable it for you. Version updates delivered by the Bot do not modify runtime Secrets, Wrangler resource configuration, or workflows. New bindings, adapter-code changes, and database migrations still need separate review and migration work. **A successful build and deployment does not prove application health or make database changes automatically reversible.**

The maintainer can choose [Cloudflare Cron, GitHub Actions Cron, or manual triggering](apps/github-bot/README.md#central-scheduler) for Bot reconciliation. In native mode, one Bot timer serves multiple templates and deployments; application-specific backup and cleanup jobs remain independent.

## Project status

- [x] NodeWarden and OpenConnector template directories with deploy buttons.
- [x] Pinned upstream commits, archive hash verification, template tests, and build-validation workflows.
- [x] Upstream version discovery and manually reviewed PRs for public templates.
- [x] Core Bot capabilities for update PRs, validation gates, rollout observations, and selectable reconciliation sources.
- [x] Adapt OpenConnector v1.10.1 with reviewed Cloudflare optimizations and explicit license notices.
- [ ] Open self-service Bot installation, repository registration, and update-policy configuration to third parties.
- [ ] Verify a new user's complete journey from first deployment to first update.

This list describes current capabilities and planned work, not delivery dates. Existing services do not need every item completed to keep running.

## Contributing

Recommend projects, contribute adapters, improve documentation, or test deployment with a fresh account. Read the [contribution guide](CONTRIBUTING.md) before submitting. Report vulnerabilities privately as described in the [security policy](SECURITY.md); do not disclose sensitive details publicly.

- **Suggest a template**: open an [issue](https://github.com/LJAYi/flareport/issues) with the upstream link, license, use case, and known runtime and resource requirements.
- **Report adapter issues**: include the template, pinned version, reproduction steps, and sanitized logs. Start with FlarePort; if the issue belongs to the upstream application, we can help route it there without burdening upstream maintainers with adapter-specific problems.
- **Contribute an adapter**: start with the [adapter lifecycle](docs/adapter-lifecycle.md), preserve upstream attribution and licensing, pin a full commit and archive hash, declare configuration inputs, and include template tests.
- **Help good projects get discovered**: if this helps you, consider starring FlarePort—and send stars, feedback, and support to the upstream authors who create the applications.

<details>
<summary>For developers: local checks, repository structure, and technical documentation</summary>

Requires **Node.js 24+**. Run these commands at the root of this repository; they are not prerequisites for ordinary users deploying a template.

```bash
npm ci
npm run check
npm run catalog
```

| Directory | Contents |
| --- | --- |
| `adapters/` | Project manifests and immutable upstream locks |
| `packages/adapter-core/` | Adapter specifications, validation, and generation |
| `templates/` | Standalone deployment template directories |
| `apps/github-bot/` | Optional update Bot Worker, state storage, and rollout coordination |
| `src/` | Catalog, CLI, and repository-level integration |

Technical documentation: [Architecture and boundaries](docs/architecture.md) · [Adapter lifecycle](docs/adapter-lifecycle.md) · [Bot configuration and API](apps/github-bot/README.md) · [Threat model](docs/threat-model.md).

Naming: **FlarePort** is the project display name; repositories, Workers, and commands use `flareport`. The production App is **FlarePort Bot** (`flareport-bot`), and the test App is **FlarePort Bot Canary** (`flareport-bot-canary`). Names alone do not isolate permissions, credentials, or runtime environments.

</details>

## Acknowledgments

**FlarePort builds on the work that upstream authors create and maintain.** Thank you for sharing your code, expertise, and time with the open-source community.

| Project and contributors | What they make possible | Upstream license information |
| --- | --- | --- |
| [NodeWarden](https://github.com/shuaiplus/nodewarden) · [shuaiplus](https://github.com/shuaiplus) and all contributors | A Bitwarden-compatible password management service running on Cloudflare Workers | [LGPL-3.0 attribution and source](templates/nodewarden/UPSTREAM.md) |
| [OpenConnector](https://github.com/oomol-lab/open-connector) · [OOMOL Lab](https://github.com/oomol-lab) and all contributors | Self-hosted authentication and third-party service connections for AI agents | [OpenConnector License, attribution and source](templates/open-connector/UPSTREAM.md) |
| [Cloudflare](https://developers.cloudflare.com/) and [GitHub](https://github.com/) | Workers, deployment tools, code hosting, Actions, and the App platform | Each platform and tool has its own terms |

Thanks also to everyone who reports issues, reviews PRs, tests templates, or improves the documentation. Together, we hope to help good projects reach more users, make self-hosting easier, and share adaptation knowledge with the next contributor.

## License

FlarePort's own tooling is licensed under the [MIT License](LICENSE). **This does not replace the upstream applications' licenses.** When using or distributing an application, you must still comply with its license, attribution, NOTICE, and source-availability obligations.

FlarePort is an independent community project. Names and trademarks belong to their respective owners; mentioning a project or platform does not imply an official partnership or endorsement.

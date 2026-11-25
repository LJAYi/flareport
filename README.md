<h1 align="center">FlarePort</h1>

<p align="center">
  <strong>让优秀的开源项目，更容易部署到 Cloudflare。</strong><br />
  Open-source apps, ported to Cloudflare.
</p>

<p align="center">
  <a href="https://github.com/LJAYi/flareport/actions/workflows/ci.yml"><img src="https://github.com/LJAYi/flareport/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="FlarePort tooling: MIT License" /></a>
  <a href="#当前进展"><img src="https://img.shields.io/badge/Status-Public%20Preview-f38020" alt="Public Preview" /></a>
</p>

<p align="center">
  <a href="#模板目录">选择模板</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#部署之后如何更新">更新机制</a> ·
  <a href="#参与贡献">参与贡献</a> ·
  <a href="#致谢">致谢</a>
</p>

---

FlarePort 是一个**社区维护、非商业运营的开源部署模板集**。我们为已有的开源项目整理 Cloudflare 适配、配置说明和更新路径，让你从一个部署按钮开始，在自己的账号里运行喜欢的服务。

**上游创造应用，FlarePort 连接部署，你掌握自己的服务与数据。**

- **从模板开始**：无需 Fork FlarePort 或上游项目，按向导生成自己的部署仓库。
- **资源归你所有**：仓库在你的 GitHub，Worker、数据库、密钥和应用数据在你的 Cloudflare。
- **来源可追溯**：构建使用锁定的上游提交，并验证源码归档的 SHA-256。
- **更新由你决定**：保留人工审核路径，自动合并和灰度更新需要另外配置并明确开启。

> [!NOTE]
> FlarePort 仍处于公开预览阶段。部署模板与更新 Bot 的开放程度不同；请先看下方状态。它不是托管平台，也不是把任意 GitHub 仓库自动转换成 Worker 的万能工具。

## 模板目录

目前收录 **2 个模板**，均为社区适配，不代表上游项目或 Cloudflare 的官方背书。

| 模板 | 用途 | 状态 | 部署入口 |
| --- | --- | --- | --- |
| **[NodeWarden](templates/nodewarden/README.md)** | 兼容 Bitwarden 的自托管密码管理服务 | 可试用 · 已完成维护者部署验证 | [![Deploy NodeWarden to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LJAYi/flareport/tree/main/templates/nodewarden) |
| **[OpenConnector](templates/open-connector/README.md)** | 为 AI Agent 连接第三方服务的开源认证网关 | 试验性 · 新版同步待修复 | [![Deploy OpenConnector to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LJAYi/flareport/tree/main/templates/open-connector) |

<details>
<summary>部署前：查看资源、必填密钥与已知限制</summary>

| 模板 | Cloudflare 资源 | 必填 Secrets | 上游与版本来源 |
| --- | --- | --- | --- |
| NodeWarden | Workers、D1、R2、Durable Objects | `JWT_SECRET`：至少 32 字符的安全随机值 | [shuaiplus/nodewarden](https://github.com/shuaiplus/nodewarden) · [锁定版本](templates/nodewarden/UPSTREAM.md) |
| OpenConnector | Workers、D1、R2 | `OOMOL_CONNECT_ADMIN_TOKEN`、`OOMOL_CONNECT_ENCRYPTION_KEY`：分别生成的长随机值 | [oomol-lab/open-connector](https://github.com/oomol-lab/open-connector) · [锁定版本](templates/open-connector/UPSTREAM.md) |

OpenConnector 的[新版同步验证](https://github.com/LJAYi/flareport/actions/runs/45394775408)因源码归档中的符号链接被安全校验拒绝而未通过，候选版本未发布。上面的按钮使用模板当前锁定的版本，**不代表已经支持上游最新版**；新用户建议先从 NodeWarden 体验。

状态核对日期：2026-11-25。维护者部署验证不等于完整安全审计，也不保证所有账号、配置或后续版本都没有问题。

</details>

## 快速开始

**准备一个 GitHub 账号和一个 Cloudflare 账号，然后：**

1. **选模板。** 阅读对应模板说明，确认所需服务已开通，再点击 **Deploy to Cloudflare**。
2. **创建部署仓库。** 按 Cloudflare 向导连接 GitHub，为自己的仓库命名，例如 `my-nodewarden`。向导复制所选模板，不需要双 Fork。
3. **填写配置并部署。** 将随机密钥填入 Cloudflare Secrets，确认资源与构建配置。构建会获取并校验锁定的上游源码。
4. **打开自己的服务。** 等待构建完成，访问 Cloudflare 提供的地址，按上游文档完成初始化；需要时再绑定域名。

**部署应用不要求安装 FlarePort Bot，也不要求把 Bot 部署到你的账号。** Cloudflare 的 GitHub 集成负责构建部署，FlarePort Bot 是另一条可选的更新管理路径。

> [!IMPORTANT]
> 部署按钮不等于零配置或永久免费。请确认 Workers、D1、R2 等服务的开通条件、[用量限制](https://developers.cloudflare.com/workers/platform/limits/)与[计费规则](https://developers.cloudflare.com/workers/platform/pricing/)。不要把真实密钥提交到仓库或 Issue；密码库等重要数据投入使用前，请先验证备份与恢复。

### 想部署多个服务？

每个服务分别部署，默认拥有独立的部署仓库和应用 Worker。账号连接通常可以复用，密钥、域名和数据则分别管理；在同一账号部署，不会为每个服务新增一份独立的账号级免费额度。

同一个模板部署多份时，需检查并区分 Worker、D1、R2 等资源名称与绑定，避免误用已有资源。接入更新管理后，一个 FlarePort Bot 可以管理多个登记过的部署。

## 部署之后如何更新

更新分两层：**上游发布新版本 → FlarePort 验证并审核模板更新 → 你的部署仓库收到更新 PR → 合并后由 Cloudflare 构建部署。** 后两步需要先配置更新路径，并非点完部署按钮就自动启用。

| 更新策略 | 你的操作 | 适用场景 |
| --- | --- | --- |
| `manual` | 检查更新 PR，确认后手动合并 | 默认建议；尤其是密码库和重要数据服务 |
| `auto` | 明确开启后，满足校验和分支保护条件才自动合并 | 已配置验证与恢复措施的部署 |
| `staged-auto` | 在自动更新条件之外，再等待前一阶段的部署观察结果 | 愿意参与分批发布的部署 |

有两条更新路径，**同一仓库选择其中一条定时更新路径即可**：

- **仓库内 GitHub Actions**：模板提供每周检查与手动触发的更新工作流。Deploy Button 可能不复制 `.github/workflows`，部署后需检查、补齐并审核工作流及仓库权限。
- **FlarePort Bot**：由维护者运行的共享 GitHub App，负责登记仓库的更新 PR、合并校验和灰度协调。安装 App 与登记模板、更新策略是不同步骤。

> [!WARNING]
> **Bot 尚未开放第三方完整自助接入。** 截至 2026-11-25，正式 App 仍为私有，仓库登记需要维护者协助，中央自动发布与自动派发尚未开启。请勿将“Bot 核心已实现”理解为“所有部署已自动订阅更新”。

自动合并始终需要用户明确授权、必要检查和分支保护，不能由中央模板替你开启。Bot 的版本更新不会修改运行时 Secrets、Wrangler 资源配置或工作流；涉及新绑定、适配代码或数据库迁移时，仍需单独审核和迁移。**构建部署成功也不等于应用运行无误，更不代表数据库变更可以自动回滚。**

Bot 的巡检可由 [Cloudflare Cron、GitHub Actions Cron 或手动触发](apps/github-bot/README.md#central-scheduler)，由维护者选择。原生模式下一个 Bot 定时器服务多个模板和部署；应用自己的备份、清理任务仍独立运行。

## 当前进展

- [x] NodeWarden、OpenConnector 模板目录与部署按钮。
- [x] 上游提交锁定、归档哈希校验、模板测试与构建验证流程。
- [x] 公共模板上游版本发现与人工审核 PR。
- [x] Bot 更新 PR、校验门槛、灰度观察与可切换巡检来源的核心能力。
- [ ] 修复 OpenConnector 新版源码归档的适配问题。
- [ ] 开放第三方 Bot 安装、仓库登记与更新策略自助配置。
- [ ] 完成陌生用户从部署到首次更新的全流程验收。

这里记录的是当前能力与待办，不是完成时间承诺。已有服务不依赖这些待办全部完成才能运行。

## 参与贡献

欢迎推荐项目、贡献适配器、完善文档，也欢迎用一个新的账号测试部署体验。提交前请阅读 [贡献指南](CONTRIBUTING.md)；安全漏洞请按 [安全策略](SECURITY.md) 私下报告，不要公开敏感细节。

- **推荐模板**：在 [Issues](https://github.com/LJAYi/flareport/issues) 提供上游链接、许可证、用途，以及已知的运行环境和资源需求。
- **反馈适配问题**：说明模板、锁定版本、复现步骤与脱敏日志。请先反馈到 FlarePort，确认是上游应用问题后再协助转交，避免让上游维护者处理适配层问题。
- **提交适配器**：从 [适配器生命周期](docs/adapter-lifecycle.md) 开始，保留上游署名与许可，锁定完整提交和归档哈希，声明配置输入，并补齐模板测试。
- **帮助更多人发现好项目**：如果它帮到了你，欢迎收藏 FlarePort，也请把 Star、反馈和支持送给真正创造应用的上游作者。

<details>
<summary>开发者入口：本地验证、目录结构与技术文档</summary>

需要 **Node.js 24+**。以下命令在本仓库根目录运行，不是普通用户的部署前置步骤。

```bash
npm ci
npm run check
npm run catalog
```

| 目录 | 内容 |
| --- | --- |
| `adapters/` | 项目 Manifest 与不可变上游版本锁 |
| `packages/adapter-core/` | 适配器规范、校验与生成能力 |
| `templates/` | 可独立部署的模板目录 |
| `apps/github-bot/` | 可选更新 Bot 的 Worker、状态存储与发布协调 |
| `src/` | 模板目录、CLI 与仓库级集成 |

技术文档：[架构与边界](docs/architecture.md) · [适配器生命周期](docs/adapter-lifecycle.md) · [Bot 配置与接口](apps/github-bot/README.md) · [威胁模型](docs/threat-model.md)。

命名约定：项目展示名为 **FlarePort**，仓库、Worker 与命令使用 `flareport`；正式 App 为 **FlarePort Bot**（`flareport-bot`），测试 App 为 **FlarePort Bot Canary**（`flareport-bot-canary`）。名称本身不构成权限、密钥或运行环境隔离。

</details>

## 致谢

**FlarePort 的价值建立在上游作者持续创造与维护的成果之上。** 感谢他们把代码、经验和时间贡献给开源社区。

| 项目与贡献者 | 感谢他们带来的能力 | 上游许可说明 |
| --- | --- | --- |
| [NodeWarden](https://github.com/shuaiplus/nodewarden) · [shuaiplus](https://github.com/shuaiplus) 及所有贡献者 | 运行在 Cloudflare Workers 上、兼容 Bitwarden 的密码管理服务 | [LGPL-3.0 署名与来源](templates/nodewarden/UPSTREAM.md) |
| [OpenConnector](https://github.com/oomol-lab/open-connector) · [OOMOL Lab](https://github.com/oomol-lab) 及所有贡献者 | 面向 AI Agent 的开源认证与第三方服务连接能力 | [Apache-2.0 署名与来源](templates/open-connector/UPSTREAM.md) |
| [Cloudflare](https://developers.cloudflare.com/) 与 [GitHub](https://github.com/) | Workers、部署工具、代码托管、Actions 与 App 平台 | 各平台及工具遵循自己的条款 |

也感谢每一位提交 Issue、审阅 PR、测试模板和改进文档的参与者。让好项目获得更多用户与反馈，让自托管更容易，让适配经验可以被下一位贡献者复用——这是我们希望一起实现的事情。

## 许可证

FlarePort 自身的工具采用 [MIT License](LICENSE)。**这不替代上游应用的许可证**；使用和分发应用时，仍须遵守对应的许可证、署名、NOTICE 与源码提供义务。

FlarePort 是独立的社区项目。文中名称和商标归各自权利人所有，提及项目与平台不代表官方合作或背书。

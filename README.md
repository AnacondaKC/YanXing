<div align="center">

<img src="public/研行LOGO-完整矢量平滑版.svg" alt="研行 YanXing 品牌标志" width="240" />

# 研行 · YanXing

### 让研究有据，让洞察落地。

AI 驱动的产业政策研究工作台<br />
从一份报告，到一项课题，再到团队可持续积累的研究资产。

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-2563EB?style=flat-square)](LICENSE)
![Next.js 16](https://img.shields.io/badge/Next.js-16-171717?style=flat-square&logo=next.js&logoColor=white)
![React 19](https://img.shields.io/badge/React-19-149ECA?style=flat-square&logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?style=flat-square&logo=typescript&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-本地存储-0F80CC?style=flat-square&logo=sqlite&logoColor=white)

**[功能亮点](#功能亮点) · [界面预览](#界面预览) · [快速开始](#快速开始) · [生产部署](#生产部署) · [参与贡献](#参与贡献)**

<br />

<a href="docs/screenshots/overview.png">
  <img src="docs/screenshots/overview.png" alt="研行工作台总览界面" width="100%" />
</a>

<sub>工作台总览 · 将课题与研究进展收拢到同一处</sub>

</div>

<br />

## 为什么选择研行

研究不止于阅读一份文档，更在于串联资料、检验结论、推进课题，并让成果能够被团队复用。

**研行（YanXing）** 面向产业研究、政策分析与课题协作场景，将 **报告解析 → AI 分析 → 课题洞察 → 知识沉淀** 整合到一个可自托管的工作台中。

- **围绕研究流程组织工作**：课题、报告、阶段交付物与洞察关联管理，减少在分散工具之间切换。
- **把长文本转化为可读结构**：结合结构化分析、词云、思维导图和热力图，辅助理解研究内容。
- **保持部署与模型选择的自主权**：Web + Worker + SQLite，无需额外部署 Redis 或独立数据库服务；模型通过 Chat Completions 兼容接口接入。

> [!NOTE]
> 自托管不等于 AI 数据完全离线。执行 AI 任务时，相关报告内容和上下文会发送至你配置的模型服务；请根据资料敏感程度选择渠道，并遵守对应的数据与隐私政策。AI 结果用于研究辅助，重要结论仍需人工核验。

## 功能亮点

| 能力 | 可以做什么 |
| :--- | :--- |
| **📄 报告解析与管理** | 上传 DOCX / PDF 研究报告，解析文本并集中管理；内建文件大小、解析资源与超时限制。 |
| **🤖 结构化 AI 分析** | 生成结构化分析结果，校验输出格式，展示任务进度；支持失败重试与结果快照。 |
| **💡 课题洞察** | 围绕课题汇总研究材料与分析结果，生成带标题、摘要与章节结构的洞察文稿，辅助梳理研究方向。 |
| **📊 研究可视化** | 使用词云、思维导图与热力图，呈现报告中的主题与结构。 |
| **🗂️ 课题与阶段管理** | 管理课题负责人、协作者、有序阶段计划、阶段内多次完整提交与进度。 |
| **📚 团队知识库** | 集中归档参考资料，为团队积累可持续维护的研究资料库。 |
| **👥 账号与权限** | 区分管理员与研究员角色；启用账号可查看全部课题，非课题成员只读，成员按权限编辑。 |
| **⚙️ 模型管理** | 配置模型渠道、模型选择与提示词，并通过多级任务队列限制控制并发。 |
| **🔔 后台任务与通知** | 独立 Worker 执行分析和洞察任务，通过 SSE 推送任务事件，并提供站内通知。 |
| **🎨 品牌与界面** | 自定义品牌标志、登录水印和品牌文案，使用统一的浅色工作界面。 |

## 界面预览

以下为仓库随附的界面截图，点击可查看原图。页面内容与统计数值仅用于界面展示，不代表安装后自动生成的数据。

<table>
  <tr>
    <td width="50%" align="center">
      <a href="docs/screenshots/topic-detail.png"><img src="docs/screenshots/topic-detail.png" alt="课题详情界面：课题信息与研究进度" width="100%" /></a>
      <br /><strong>01 / 课题详情</strong><br />围绕课题组织研究与阶段推进
    </td>
    <td width="50%" align="center">
      <a href="docs/screenshots/topic-insight.png"><img src="docs/screenshots/topic-insight.png" alt="课题洞察界面：结构化研究洞察" width="100%" /></a>
      <br /><strong>02 / 课题洞察</strong><br />将研究材料转化为可读结论
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <a href="docs/screenshots/research-report.png"><img src="docs/screenshots/research-report.png" alt="研究报告界面" width="100%" /></a>
      <br /><strong>03 / 研究报告</strong><br />在报告层面开展研究与分析
    </td>
    <td width="50%" align="center">
      <a href="docs/screenshots/report-library.png"><img src="docs/screenshots/report-library.png" alt="报告库界面" width="100%" /></a>
      <br /><strong>04 / 报告库</strong><br />集中管理研究报告与资料
    </td>
  </tr>
</table>

<details>
<summary><strong>查看登录页与品牌展示</strong></summary>

<br />

<a href="docs/screenshots/login.png"><img src="docs/screenshots/login.png" alt="研行登录页与品牌展示" width="100%" /></a>

</details>

## 快速开始

### 1. 准备环境与源码

| 依赖 | 要求 |
| :--- | :--- |
| Node.js | **24.x（≥ 24.20.0）**，使用内置 `node:sqlite`；本地与 CI 的基准版本由 [.nvmrc](.nvmrc) 固定为 **24.20.0** |
| pnpm | **11.18.0**，与 [package.json](package.json) 及 Docker 构建一致 |
| 模型服务 | 执行 AI 任务时需要可用的 Chat Completions 兼容接口；仅启动和浏览页面不需要 |

获取本仓库源码后，在项目根目录执行以下命令。示例使用 Bash，适用于 Linux / macOS；Windows 建议使用 WSL2。

```bash
# 使用 nvm 时：按 .nvmrc 安装并切换到项目基准 Node.js 版本
nvm install
nvm use

# 已安装其他 Node.js 管理工具时，可自行切换到 24.20.0，再安装固定版本 pnpm
npm install --global pnpm@11.18.0
pnpm install --frozen-lockfile
cp .env.example .env
```

### 2. 配置模型渠道

全新部署可在首次创建管理员或启动前编辑 `.env`，按所选服务商填写以下初始配置；也可以先启动应用，再以管理员身份在管理端配置渠道、模型，以及分析 / 洞察的模型指派。

```dotenv
# 示例：替换为实际使用的兼容服务地址、模型名与密钥
YANXING_CHAT_COMPLETIONS_BASE_URL=https://api.openai.com/v1
YANXING_CHAT_COMPLETIONS_MODEL=gpt-4.1-mini
YANXING_CHAT_COMPLETIONS_API_KEY=your-api-key
```

这些模型环境变量仅用于首次初始化空白配置表；初始化后以数据库中的设置为准，修改 `.env` 不会覆盖已有模型配置，请通过管理端调整。完整环境配置及默认值见 [.env.example](.env.example)。不要将真实密钥写入源码、截图或提交记录。

### 3. 创建管理员并启动

使用隐藏输入，避免将密码字面量写入 shell 历史：

```bash
read -rsp "管理员密码: " YANXING_ADMIN_PASSWORD; echo
export YANXING_ADMIN_PASSWORD
pnpm user:create
unset YANXING_ADMIN_PASSWORD

pnpm dev
pnpm status
```

打开 **<http://127.0.0.1:3000>**，使用默认用户名 `admin` 和刚刚设置的密码登录。

- `user:create` 会初始化空库或校验原生结构（旧库拒绝，不迁移），支持 `--username`、`--display-name` 和 `--role` 参数。
- 该命令会**创建或更新同名账号**，并使已有会话失效，不要将它作为每次启动的固定步骤。
- `pnpm dev` 由应用管理器在后台启动 Web 和 Worker，并在空库时做原生初始化；现有旧库会失败关闭。使用 `pnpm stop` 停止。不要对正在验收的业务库做删除或改写。
- 日志默认位于 `storage/logs/`。首次使用可先建立课题、上传报告，再运行 AI 分析并查看洞察。

## 生产部署

当前采用**课题 → 阶段 → 不可变报告提交**原生模型。**新项目，不做旧库迁移、历史兼容或双模运行。** 旧库/混合库启动会明确拒绝；不要把新镜像指向现有旧卷，不要清空旧数据绕过检查。

P5 本轮按用户确认只做隔离验收，**未切换正式实例、未推送正式镜像**。已有版本号或 GHCR 标签不能证明包含本轮原生实现。验收范围、发布候选和恢复操作见 [P5 发布验收记录](docs/project-stage-report-p5-acceptance.md)。

### Docker Compose

使用匹配的原生镜像与 Compose，单个 app 服务由 supervisor 管理 Web/Worker。正式部署前明确新项目名、新数据卷、域名/端口和稳定密钥；以下仅为未来新部署示例，本轮没有执行。


env 文件使用独立名称，避免覆盖当前配置：

```bash
# .env.native 已存在时不要覆盖，先核对配置。
test ! -e .env.native && cp .env.example .env.native
chmod 600 .env.native
# 编辑 .env.native：保存一次性生成的固定 YANXING_SETTINGS_ENCRYPTION_KEY；
# 设置新的 YANXING_IMAGE 标签、确认端口，并配置模型渠道。
export YANXING_ENV_FILE=.env.native
docker compose --env-file .env.native -p yanxing-native config --quiet
# 确认 yanxing-native_data 是本次新卷，且目标端口没有被现有实例占用后：
docker compose --env-file .env.native -p yanxing-native up -d --build --wait --wait-timeout 180
```

创建管理员（只对上述新实例）：

```bash
read -rsp "管理员密码: " YANXING_ADMIN_PASSWORD; echo
export YANXING_ADMIN_PASSWORD
docker compose --env-file .env.native -p yanxing-native exec -e YANXING_ADMIN_PASSWORD app /app/scripts/docker-entrypoint.sh user:create
unset YANXING_ADMIN_PASSWORD
```

正式登录须通过 HTTPS；默认仅绑定 127.0.0.1:3000。生产应钉选经本轮原生验收的确切镜像 digest，不使用不明 latest，也不覆盖已有回退镜像标签。共享默认上限为 4 GiB/4 CPU，Worker 并发 1～3；SQLite 不支持多主机共享或 scale app=2。

普通停机使用 stop 或不带 -v 的 down；**不要删除数据卷**。完整配置、HTTPS 和密钥保管见 [Docker 部署指南](docs/docker-deployment.md)。

### Node.js

先明确全新的绝对运行目录，并通过 YANXING_DATABASE_PATH 指定其中的 SQLite；配置并保管固定 YANXING_SETTINGS_ENCRYPTION_KEY。不要复用当前旧 storage/，不要在现有实例未确认停机时运行 restart。

构建使用 pnpm build:runtime 与 pnpm build；启动入口仍为 pnpm start，状态查看为 pnpm status。首次原生初始化命令仍叫 db:migrate，但只初始化空库或校验已有原生库，不迁移旧模型。

### 同模型备份与恢复

使用 pnpm backup:native --help 查看显式路径命令。原生备份包括 SQLite 一致性快照、正式/墓碑报告文件、知识资料、审计及加密设置；**主密钥另行保管，不放入归档**。恢复须使用同一 schema、同一绑定路径和同一密钥，不覆盖现有数据，不以旧模型降级代替恢复。

## 技术架构

```mermaid
flowchart LR
    U[浏览器工作台] --> W[Next.js Web / API]
    W --> D[(SQLite)]
    W --> F[本地文件存储]
    T[独立 Worker] <--> D
    T --> F
    T --> M[Chat Completions 模型服务]
    W -. SSE 任务事件 .-> U
```

| 层次 | 技术选型 |
| :--- | :--- |
| 应用与界面 | Next.js 16 · React 19 · TypeScript · Tailwind CSS 4 |
| 数据与任务 | Node.js 内置 SQLite · 独立 Worker · SSE |
| 文档处理 | Mammoth · pdf-parse · docx-preview |
| 可视化 | Visx · 自定义图表组件 |
| 工程与部署 | pnpm · node:test · Docker Compose · GitHub Actions |

<details>
<summary><strong>查看项目目录</strong></summary>

```text
app/                Next.js App Router 页面与 API 路由
components/         工作台、管理端与 UI 基础组件
modules/            课题、报告、分析、洞察等领域模块
lib/                配置、数据库、模型接入、存储与安全基础设施
worker/             分析与洞察任务执行器
scripts/            进程管理、原生库初始化/校验、用户创建与测试脚本
docs/               部署文档与界面截图
test/               自动化测试
public/             品牌与静态资源
storage/            本地运行数据，不纳入版本管理
```

</details>

## 开发与维护

| 命令 | 说明 |
| :--- | :--- |
| `pnpm dev` / `pnpm start` | 开发 / 生产模式启动 Web 与 Worker |
| `pnpm stop` / `pnpm restart` / `pnpm status` | 停止、重启与查看进程状态 |
| `pnpm build` | 构建生产版本 |
| `pnpm db:migrate` | 初始化空库或校验原生结构（旧库拒绝，不迁移） |
| `pnpm user:create` | 创建或更新用户 |
| `pnpm storage:reconcile` | 存储对账与维护 |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm lint` | 类型检查及未使用变量 / 参数检查 |
| `pnpm test` | 运行自动化测试 |
| `pnpm check` | 依次执行 lint、test、build |

持续集成执行代码检查、测试、构建及 Docker 部署验证，具体步骤见 [CI 工作流](.github/workflows/ci.yml)。GitHub Release 发布后，[镜像发布工作流](.github/workflows/docker-release.yml) 会先调用该 CI，两者均通过后再构建并推送 GHCR 镜像。

### 常见问题

<details>
<summary><strong>支持哪些文档？可以识别扫描件吗？</strong></summary>

报告与知识库支持 PDF / DOCX。当前解析以提取文档文本为主，不包含 OCR；图片型扫描件需先在其他工具中完成文字识别。文件大小、页数、解析时间与模型上下文均有上限，具体配置见 `.env.example`。

</details>

<details>
<summary><strong>没有模型 API，可以先体验吗？</strong></summary>

可以启动应用、登录并浏览界面；真正执行 AI 分析或洞察任务时，需要配置可用的模型渠道。不同兼容服务的能力存在差异，请验证所选模型的结构化输出能力和上下文限制。

</details>

<details>
<summary><strong>为什么上传后任务一直等待？</strong></summary>

先确认 Worker 正在运行：本地部署执行 `pnpm status`，Docker 部署执行 `docker compose ps -a`（联合健康检查要求 Web 与 Worker 都通过）。再检查 `app` 日志、模型渠道及队列容量。Web 能打开不代表后台任务执行器已经就绪。

</details>

<details>
<summary><strong>可以部署到多台服务器吗？</strong></summary>

默认架构面向单机自托管，SQLite 与文件存储应放在本地磁盘。不要通过 NFS / SMB 在多台主机间共享数据库。Docker 也只运行一个 `app` 容器，不要横向扩容；这不是多机集群方案。

</details>

## 参与贡献

欢迎通过仓库 **Issues** 反馈问题、提出功能建议，或提交 **Pull Request** 改进代码、文档与测试。

1. Fork 仓库，为修改创建独立分支。
2. 保持改动聚焦；行为变更请补充测试，界面变更请附上截图。
3. 提交前运行 `pnpm check`；涉及 Docker 部署时，额外运行 `sh scripts/test-docker.sh`。
4. 在 PR 中说明修改动机、影响范围与验证方式。

反馈问题时，请附上运行环境、复现步骤和**已脱敏**的日志。不要提交 `.env`、真实 API 密钥、管理员密码、数据库、内部报告或含敏感信息的截图。

### 安全与隐私

项目包含模型密钥加密存储、会话与权限校验、接口限流、上传路径约束及解析资源限制。这些措施不替代部署环境的安全配置与持续维护。

**安全漏洞请勿公开提交 Issue**，请按照 [安全策略](SECURITY.md) 进行私密报告。

## 许可证

本项目基于 **[Apache License 2.0](LICENSE)** 开源。使用、修改和分发时，请遵守许可证条款并保留相应声明。

源码发行包含 Dockerfile / Compose 构建配置；GitHub Release 发布成功后，还会按工作流向 GHCR 推送 `linux/amd64` 预构建镜像（见 [生产部署](#生产部署)）。依赖与第三方组件保留各自许可证；源码分发核验、素材确认及镜像再分发注意事项见 [第三方许可证说明](docs/third-party-licenses.md)。

---

<div align="center">

**研行 · 让每一份研究，走向更有价值的洞察。**

<sub>如果研行对你的工作有所帮助，欢迎 Star，也欢迎分享你的实践与建议。</sub>

<sub>© 2026 研行产业政策研究团队</sub>

</div>

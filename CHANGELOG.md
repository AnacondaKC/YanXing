# 更新记录

## 0.1.2 — 2026-09-09

本次版本将 Docker 部署统一为单容器，并完善进程生命周期、健康检查、测试隔离及升级文档。**这是部署方式的兼容性变更，旧镜像与新 Compose 不可混用。**

### 部署

- Docker Compose 改为仅一个 `app` 服务：默认入口启动 supervisor，由它先执行数据库迁移，再同时管理 Web 与 Worker；不再提供 `web` / `worker` / `migrate` 服务或 `all` 启动模式。
- `app` 共享资源上限改为 `YANXING_MEMORY`（默认 4g）与 `YANXING_CPUS`（默认 4），`stop_grace_period` 为 100 秒（supervisor 内部宽限约 80 秒）。合并不节省内存；单机 SQLite 不要扩容容器。
- 健康检查改为联合检查 Web `/api/health` 与 Worker 心跳（默认 `/tmp/yanxing-worker-heartbeat.json`）。`unhealthy` 本身不会触发 Docker 重启；Web 或 Worker 任一退出时，supervisor 停止另一方并以非零状态退出，由 Docker 重启整个容器。
- 管理命令改为 `docker compose exec app /app/scripts/docker-entrypoint.sh user:create` 等；离线维护在停机后使用 `docker compose run --rm --no-deps app …`。
- 从 `v0.1.1` 及更早的多容器部署升级时，须先用旧 Compose（`web` / `worker` / `migrate`）备份并执行 `docker compose down`（不要加 `-v`），保留同一项目名、数据卷和密钥后再切换新配置，以免孤儿 Worker 继续领取任务。已发布的 `v0.1.1` 镜像不能与新 Compose 搭配；使用 `v0.1.2` 对应的源码和镜像，镜像发布成功前可本地构建。旧 `YANXING_WEB_MEMORY` / `YANXING_WORKER_MEMORY` 与对应 CPU 限制不再生效，应改为共享的 `YANXING_MEMORY` / `YANXING_CPUS`。

### 测试与安全

- 健康测试显式隔离工作目录、数据库和知识库路径，直接运行测试文件也不会让 Worker 存储维护扫描项目资料。
- 生命周期测试统一登记 supervisor、嵌套 runner 与执行 Promise；回调异常后先请求停止并有界等待，再收集后代、强制清理和回收句柄，保留原始测试错误。
- 增加启动早期失败、未手动登记 PID、嵌套 runner 失败及忽略 TERM 等清理回归，完善迁移门禁、进程退出、信号处理、心跳与容器重启冒烟。
- 管理员创建示例补齐隐藏输入、导出及清除密码变量的步骤。

### 发布与升级

- 本次合并不改变数据库结构、数据卷布局或密钥格式；升级仍须先备份并保留旧镜像，不支持直接混用新旧 Compose。
- 发布前本地代码检查、601 项测试、生产构建，以及单容器 Docker 冒烟和纯 `docker run` 验证通过。
- Release 发布后须等待 GitHub Actions 的 CI、Docker 部署冒烟与镜像推送全部成功，再拉取 `ghcr.io/anacondakc/yanxing:v0.1.2`（`linux/amd64`）。成功的稳定版发布才更新 `latest`；生产环境应固定版本标签。

## 0.1.1 — 2026-09-09

本次维护版本重点提升 AI 分析稳定性、提示词预算校验及 Docker 部署可靠性。

### 修复

- 思维导图生成 Schema 与后端门禁统一为五层节点结构，固定提示词明确叶子节点必须包含空子节点数组。
- 分析校验前仅为名称合法、无额外字段的非根叶子节点补齐遗漏的 `子节点: []`，避免因可修复格式问题重新调用模型；错误类型、空根节点及节点数量、层数、宽度限制仍严格校验。
- 自动补齐以普通任务进度提示展示，并在 Worker 日志记录任务、尝试次数、修复数量及字段路径，不记录报告正文。

- 修复 TypeBox 校验错误适配，保留深层 JSON Pointer 路径及期望类型，缺失字段、额外字段与常见限制使用可定位的中文反馈，供自动重试纠错。
- 设置保存、任务入队及模型执行统一计算提示词预算；不兼容的新任务在预留 Token 前拒绝，旧冻结任务在调用模型前以明确配置错误终止，不产生模型用量，也不改写冻结配置。
- 上下文不足时仅截取报告正文，保留系统约束、任务要求、评价背景、纠错反馈与完整 Schema；配置不足的 API 响应返回 409 和所需/可用字符数。

### 默认配置

- 新建模型及首次初始化（未显式指定输出上限）的默认最大输出 Token 调整为 65,536；显式配置、已有模型及已冻结任务保持原值，运行时缺省回退值仍为 16,384。

### 部署与可靠性

- Docker 改用 Next standalone 与预编译 Worker、管理命令及解析子进程，仅保留追踪到的运行依赖、静态资源和许可文件，不再复制完整依赖目录或构建缓存。
- 程序与依赖保持 root 所有、运行用户只读，仅存储、运行缓存和临时目录可写；补充隔离部署与文件权限冒烟测试。
- 品牌配置按请求读取，读取失败时使用默认品牌回退，同时保持管理 API 的严格校验。

### 升级注意事项

- 升级前备份数据库、上传文件与加密密钥，并保留旧镜像；使用与 `v0.1.1` 匹配的 Compose 配置。本次 Docker 打包调整不改变数据库结构、数据卷或密钥。
- 新建模型的 65,536 输出 Token 默认值需要模型服务支持；已有配置不会自动调整。遇到提示词预算不足的 409 响应时，请按返回的所需/可用字符数调整模型上下文或提示词配置。
- Docker 内使用预编译 JavaScript 入口，不再直接执行旧 `.ts` 路径或依赖 `tsx`；现有 Compose 管理命令用法保持不变。
- Release 发布后仍须等待 GitHub Actions 验证与镜像构建成功，才可拉取 `ghcr.io/anacondakc/yanxing:v0.1.1`（仅 `linux/amd64`）；稳定版镜像发布成功后同步更新 `latest`。

## 0.1.0

首个开源版本，基于 Apache-2.0 分发。

### 功能与部署

- 提供课题管理、报告与知识库、PDF / DOCX 解析、AI 分析及洞察工作台。
- 提供账号角色、课题成员编辑权限、Token 预算和独立 Worker 任务执行。
- 提供 Dockerfile / Compose 本地构建方案、Web / Worker 健康检查、部署冒烟测试和离线存储路径迁移工具。
- 统一 Node.js 24.x（≥ 24.20.0）；本地、CI 和 Docker 基准为 Node.js 24.20.0、pnpm 11.18.0。
- GitHub Release 发布（`published`）后，由 `.github/workflows/docker-release.yml` 以 `workflow_call` 调用现有 CI（代码检查、测试、构建与 Docker 部署冒烟均须通过），再构建 `linux/amd64` 镜像，使用 `GITHUB_TOKEN` 推送到 `ghcr.io/anacondakc/yanxing`。
- 镜像标签为该 Release 对应的 Git 标签（例如 `v0.1.0`）；仅非预发布成功时更新 `latest`。`latest` 表示最近一次成功的稳定版发布，不按 semver 比较。工作流不提供 `workflow_dispatch`。
- 可通过在 `.env` 设置 `YANXING_IMAGE` 后执行 `docker compose pull` 与 `docker compose up -d --no-build` 部署预构建镜像。上传上限构建参数为 `26214400`，须与运行时一致；自定义上限需自行构建。

### 分发范围

- 分发源码、文档、已确认可公开的品牌素材与截图，以及 Docker 构建配置。
- GitHub Release 的 Actions 成功后，向 GHCR 推送 `linux/amd64` 预构建镜像。镜像是否可用，以对应 Release 的 Actions 成功结果和 Packages 标签为准。GHCR 包默认私有，公开可见性需在 GitHub Packages 另行设置。
- 源码包不附带本地依赖目录或构建产物；不分发数据库、上传资料或运行密钥。
- 第三方组件保留各自许可证，核验范围与后续二进制再分发注意事项见 [第三方许可证说明](docs/third-party-licenses.md)。

### 使用边界

- 默认面向单机自托管；启用账号可查看全部课题，非课题成员只读，不提供课题间严格的多租户读取隔离。
- AI 任务会向所配置的模型服务发送相关资料，模型结果需人工核验；PDF 扫描件不包含 OCR 支持。
- 生产登录需要 HTTPS；升级前备份数据库、文件及加密密钥。详见 [部署指南](docs/docker-deployment.md)。
- 自动化模拟模型测试不能替代真实模型兼容性、HTTPS 浏览器登录或备份恢复演练。

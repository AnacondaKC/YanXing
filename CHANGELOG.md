# 更新记录

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

# Docker 部署

研行使用同一镜像运行 Web、Worker 和一次性数据库迁移服务，不需要 Redis 或独立数据库。现有 `pnpm dev/start` 本地部署方式不变。

部署可以使用 GitHub Release 发布后推送到 GHCR 的预构建镜像，也可以继续用仓库内 Dockerfile / Compose 在本机构建。容器基准环境为 Node.js 24.20.0、pnpm 11.18.0，与 `.nvmrc` 和 CI 一致。对外再分发构建镜像前，应另行核验最终产物中的第三方组件，见 [第三方许可证说明](third-party-licenses.md)。

## 1. 环境与边界

- Docker Engine + Docker Compose v2（建议 2.24 或更新版本，支持 `up --wait`）。生产服务器不需要安装 Node.js/pnpm。
- 单台 Linux 主机、本地磁盘数据卷；不要通过 NFS/SMB 在多台主机之间共享 SQLite。默认 1 个 Web、1 个 Worker。
- 每个 Worker 默认并发 3 个任务，可通过 `YANXING_WORKER_CONCURRENCY=1/2/3` 调整。PDF/DOCX 解析仍有独立并发限制。
- Web 与 Worker 默认各有 2 GiB 内存、2 CPU 的上限，不是资源预留。建议至少 4 GiB 内存并保留系统余量。仅在本机构建镜像时还需要额外内存和磁盘；拉取预构建镜像不需要构建资源。实际配置应根据文件大小、模型响应与并发压测调整。
- GHCR 预构建镜像仅发布 `linux/amd64`。其他架构请自行构建并做冒烟测试后再用于生产。
- 正式访问必须配置 HTTPS。生产认证使用 `__Host-`/Secure Cookie，不能以远程 HTTP 裸 IP 作为正式登录入口。

## 2. GitHub Release 与 GHCR 镜像

GitHub 在 **Release 发布（`published`）** 后触发 [`.github/workflows/docker-release.yml`](../.github/workflows/docker-release.yml)：

1. 以 `workflow_call` 调用现有 [CI 工作流](../.github/workflows/ci.yml)。**代码检查 / 测试 / 构建**（lint、test、build）与 **Docker 部署冒烟** 两个 job 都必须通过，才会继续发布。
2. 通过后构建 `linux/amd64` 镜像，使用 `GITHUB_TOKEN` 推送到 `ghcr.io/anacondakc/yanxing`。
3. 始终打上该 Release 对应的 **精确 Git 标签**（例如 `v0.1.0` → `ghcr.io/anacondakc/yanxing:v0.1.0`）。
4. **仅当该 Release 未标记为预发布（prerelease）时**，才会同时推送 / 更新 `latest`。`latest` 表示**最近一次成功完成的稳定版发布**，不是按 semver 比较选出的最高版本。之后若又一次非预发布发布成功，`latest` 会指向后者，即使其版本号更低。
5. 该工作流**没有** `workflow_dispatch`，不能在 Actions 界面手动触发来发布镜像。

镜像是否可用，以对应 Release 的 Actions 成功结果和 GitHub Packages 上的标签为准。发布成功后，可在 Packages 查看 `yanxing` 容器包。

GitHub Packages 上的 GHCR 包**默认私有**。仓库公开不等于包可匿名拉取；若需要公开拉取，须在包设置中**另行**将可见性改为 public。私有包拉取前需要登录：

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

令牌至少需要 `read:packages`。不要把登录凭据写入仓库或提交记录。

预构建镜像按 Dockerfile 默认构建参数打入 `REPORT_MAX_UPLOAD_BYTES=26214400`。运行时必须使用同一上限，否则容器入口会拒绝启动。需要其他上传上限时，**不能**使用该预构建镜像，必须自行构建。

生产环境建议钉选精确标签（`ghcr.io/anacondakc/yanxing:v0.1.0`），不要把 `latest` 当作稳定的版本锁定。即使使用预构建镜像，也应使用与镜像标签匹配的 `compose.yaml`（按同一 Git 标签检出仓库）。

## 3. 首次部署（新数据）

在仓库根目录准备环境文件（拉取预构建镜像和本地构建都需要）：

```bash
cp .env.example .env
chmod 600 .env
# 编辑 .env，配置模型渠道，并为新部署生成、保存一把固定密钥：
openssl rand -hex 32
# 将生成值填写为 YANXING_SETTINGS_ENCRYPTION_KEY，勿每次重启重新生成。
```

### 从 GHCR 拉取

在确认 Packages 上已有对应标签后，在 `.env` 中设置：

```dotenv
YANXING_IMAGE=ghcr.io/anacondakc/yanxing:v0.1.0
```

将 `v0.1.0` 换成实际 Git 标签。包仍为私有时先完成上一节的 `docker login`。然后：

```bash
docker compose config --quiet
docker compose pull
docker compose up -d --no-build --wait --wait-timeout 180
docker compose ps -a
```

建议使用 `--no-build`：Compose 文件含 `build` 定义。省略该参数时，若本地没有对应镜像，**可能**触发本地构建；加上 `--build` 会明确重新构建并覆盖所拉取的标签。

### 本地构建

不设置 `YANXING_IMAGE` 时默认 `yanxing:local`。适用于尚未能从 GHCR 拉取对应标签、需要自定义上传上限，或目标平台不是 `linux/amd64` 的情况：

```bash
docker compose config --quiet
docker compose up -d --build --wait --wait-timeout 180
docker compose ps -a
```

`migrate` 成功后退出（Exited 0 是正常状态），Web 和 Worker 才会启动。迁移失败应先检查日志，不能删除数据库来绕过错误：

```bash
docker compose logs --tail 100 migrate
```

默认端口仅绑定宿主机 `127.0.0.1:3000`，供反向代理访问。可以在宿主机访问 `http://127.0.0.1:3000/api/health` 检查 Web；远程用户通过下一节的 HTTPS 域名访问。

### 创建管理员

以下示例使用 Bash 隐藏输入密码，不将密码字面量写入 shell 历史：

```bash
read -rsp "管理员密码: " YANXING_ADMIN_PASSWORD; echo
export YANXING_ADMIN_PASSWORD
docker compose run --rm --no-deps -e YANXING_ADMIN_PASSWORD migrate user:create
unset YANXING_ADMIN_PASSWORD
```

默认用户名 `admin`，可追加 `--username`、`--display-name`。命令会创建或更新同名账号，并使已有会话失效，因此不要在每次启动时自动执行。不要把管理员密码长期写入 `.env`。

模型配置可使用 `.env` 中的 Chat Completions 变量，也可登录后在管理端配置。仅登录、查看页面不要求真实模型服务，执行 AI 任务则需要可用渠道。

## 4. HTTPS 反向代理

推荐复用宿主机现有 Nginx/Caddy，不自动占用 80/443。下面是宿主机 Caddy 的最小示例（将域名替换为自己的域名，正确配置 DNS 和防火墙）：

```caddyfile
yanxing.example.com {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
```

如果使用 Nginx，HTTPS server 内的反代位置示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    # 单层代理覆盖来访者伪造的头；多层代理应另行定义可信链。
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_buffering off;
    proxy_read_timeout 1800s;
    proxy_send_timeout 600s;
    client_body_timeout 60s;
    client_max_body_size 26m;
}
```

该片段不含证书配置，请使用有效证书并将 HTTP 重定向到 HTTPS。SSE 必须关闭代理缓冲；上传上限与超时必须和应用配置匹配。

仅当 Web 确实只能经可信代理访问时设置：

```dotenv
YANXING_TRUST_PROXY=true
YANXING_TRUSTED_PROXY_HOPS=1
```

如果代理也在容器里，代理容器内的 `127.0.0.1` 不是宿主机或 Web 容器；请把代理接入应用网络，使用 `web:3000`，不要为此直接将应用端口开放到公网。

## 5. 配置与镜像

容器通过 Compose `env_file` 读取 `.env`，环境文件不会复制进镜像。Compose 固定容器工作目录为 `/app`，并覆盖以下容器内路径：

| 配置 | Docker 值 |
| --- | --- |
| `YANXING_DATABASE_PATH` | `/app/storage/yanxing.sqlite` |
| `YANXING_KNOWLEDGE_STORAGE_ROOT` | `/app/storage/knowledge` |
| `YANXING_NEXT_DIST_DIR` | `.next` |
| `PORT` | `3000` |

Docker 宿主机配置：

| 配置 | 默认值 / 含义 |
| --- | --- |
| `YANXING_HTTP_PORT` | `3000`，宿主机映射端口，不是本地管理器的 `YANXING_PORT` |
| `YANXING_BIND_ADDRESS` | `127.0.0.1`，默认不对公网暴露 |
| `YANXING_IMAGE` | 默认 `yanxing:local`（本地构建标签）。使用 GHCR 时设为 `ghcr.io/anacondakc/yanxing:<git-tag>`，例如 `ghcr.io/anacondakc/yanxing:v0.1.0`；`latest` 仅表示最近一次成功的稳定发布，不是 semver 最大值 |
| `YANXING_NODE_IMAGE` | `node:24.20.0-bookworm-slim`，仅使用 Node.js 24.x（≥ 24.20.0）；更换补丁版本或 digest 后需重新验证。仅本地构建时使用 |
| `YANXING_WEB_MEMORY` / `YANXING_WORKER_MEMORY` | 各 `2g` |
| `YANXING_WEB_CPUS` / `YANXING_WORKER_CPUS` | 各 `2` |
| `YANXING_ENV_FILE` | `.env`，自定义时需同时供 Compose 变量替换和容器 env_file 使用 |

使用其他环境文件的示例：

```bash
# 本地构建
YANXING_ENV_FILE=/secure/yanxing.env docker compose --env-file /secure/yanxing.env up -d --build --wait

# GHCR 拉取
YANXING_ENV_FILE=/secure/yanxing.env docker compose --env-file /secure/yanxing.env pull
YANXING_ENV_FILE=/secure/yanxing.env docker compose --env-file /secure/yanxing.env up -d --no-build --wait
```

修改普通运行时参数后执行 `docker compose up -d --force-recreate --wait`（使用预构建镜像时加上 `--no-build`）；单纯 `restart` 不会更新容器环境变量。

**上传上限是例外：** `REPORT_MAX_UPLOAD_BYTES` 同时参与 Next.js 构建配置。Compose 将同一个值传给构建和运行环境；容器入口会验证镜像构建记录，不一致时拒绝启动。本地修改后执行 `docker compose up -d --build --force-recreate --wait`，同时调整反向代理的上限。不要只更改运行环境。**GHCR 预构建镜像固定为默认值 `26214400`**；使用该镜像时运行时也必须保持这一上限。自定义上限需要自行构建，不能只改 `.env` 后拉取预构建镜像。

镜像采用多阶段普通 Next.js 构建，保留生产依赖、运行源码、`tsx` 和 PDF/DOCX 解析子进程，不使用 standalone 极限裁剪。原生可选依赖按目标平台安装，不要使用 `--no-optional`，也不要把宿主机 `node_modules` 复制进镜像。GHCR 发布与默认 CI 均针对 `linux/amd64`；其他架构应自行运行冒烟测试后再使用本地构建产物。定期更新基础镜像以获取安全修复。

## 6. 数据卷、权限与密钥

默认项目名为 `yanxing`，命名卷通常为 `yanxing_data`；使用 `-p` 后卷名前缀也会改变。不要无意中更改项目名，否则可能连接一个新的空卷。

整个卷挂载到 `/app/storage`，包括数据库、WAL/SHM、报告原文件、解析 `.content.json` 缓存、知识库和本地 `.settings-key`。品牌图像保存在数据库中。stdout/stderr 日志由 Docker 轮转，不再写应用管理器日志。

所有服务使用 UID/GID `1000:1000`，以非 root 身份运行，入口设置 `umask 077`；新卷初始化目录为 0700。不要让其他不可信服务访问该卷。旧文件权限不会被自动递归修改。

使用宿主机目录时可添加覆盖文件，将共享 volume 的 `/app/storage` 挂载改成 `./docker-data:/app/storage`，并预先创建目录、设置属主为 1000:1000、权限 0700。不要将项目源码整体挂载到 `/app`，否则会遮蔽镜像构建产物。

**密钥不可丢失或随意更换：** 原部署使用环境变量密钥就沿用原值；原部署使用 `.settings-key` 就原样保留该二进制文件，并保持环境变量密钥未设置。不能将旧二进制密钥转成 hex 字符串直接当作环境变量密钥，两者字节内容不同。使用环境变量密钥时，要在数据备份之外另行安全备份它。

## 7. 备份、升级和恢复

### 一致性备份

先停止全部写入者（包括通过其他方式启动、共享同一数据卷的进程），再备份整个卷：

```bash
umask 077
docker compose stop -t 90 web worker
docker compose run --rm -T --no-deps migrate tar -C /app/storage -czf - . > yanxing-backup.tar.gz
# 另行安全备份 .env / 外部密钥及当前镜像版本。确认备份成功后恢复运行：
docker compose up -d --wait   # 使用预构建镜像时加 --no-build
```

不要在线只复制 SQLite 主文件，也不要只备份数据库或只备份上传目录。备份包含会话、密码哈希和报告，必须限制访问。

### 升级

1. 停止 Web/Worker，按上述步骤完整备份。
2. 切换到与目标镜像匹配的代码版本（至少更新 `compose.yaml`），保留原 `YANXING_SETTINGS_ENCRYPTION_KEY`，不要重新生成。
3. 更新 `.env` 中的 `YANXING_IMAGE`：
   - GHCR：设为 `ghcr.io/anacondakc/yanxing:<新 git-tag>`，执行 `docker compose pull`，再执行 `docker compose up -d --no-build --force-recreate --wait --wait-timeout 180`。
   - 本地构建：设为新的本地版本标签，执行 `docker compose up -d --build --force-recreate --wait --wait-timeout 180`。
4. 检查健康状态、登录、原有报告下载、PDF/DOCX 上传和分析任务。

本方案不承诺滚动零停机升级。迁移可能改变数据库结构；回滚时应恢复旧镜像及对应数据、密钥，不能只切换镜像标签。迁移账本的 checksum 校验失败应排查版本问题，不能修改已发布迁移文件或删除账本来绕过。

### 恢复

在全新空卷上恢复最安全。下例使用新的 Compose 项目 `yanxing-restored`，因此不会覆盖原项目卷；恢复期间不启动 Web/Worker：

```bash
docker compose -p yanxing-restored run --rm -T --no-deps migrate \
  sh -c 'tar -C /app/storage -xzf - && chmod -R go-rwx /app/storage' < yanxing-backup.tar.gz
# 确保 .env 使用匹配的镜像配置和原加密密钥，并避免与原实例争用宿主机端口。
docker compose -p yanxing-restored up -d --wait   # 使用预构建镜像时加 --no-build
```

不要把备份叠加恢复到正在使用或含其他数据的目录；数据库与文件集合不一致可能导致维护流程删除被判定为孤立的文件。

**警告：`docker compose down -v` 会删除命名数据卷。普通停机使用 `stop` 或不带 `-v` 的 `down`。**

## 8. 从非 Docker 部署迁入

旧报告、知识库和存储台账可能保存宿主机绝对路径，仅复制 `storage/` 会使容器找不到文件。

1. 停止旧 Web、Worker 和其他维护进程；完整备份数据库、上传文件、缓存与原密钥。
2. 拉取或构建镜像，但暂不运行 `up`，尤其不要先启动 Worker 的存储维护。
3. 用上一节的恢复命令将备份导入空数据卷，统一权限。若旧数据库或知识库使用自定义外部路径，也必须完整导入相应数据。
4. 在复制后的数据库上预览旧根路径转换，再显式应用：

```bash
docker compose run --rm --no-deps migrate storage:relocate \
  --from /old/server/YanXing/storage --to /app/storage
docker compose run --rm --no-deps migrate storage:relocate \
  --from /old/server/YanXing/storage --to /app/storage --apply
```

`--from` 是数据库记录的旧绝对存储根目录，不是新备份文件所在位置。默认只预览；转换前检查目标文件和路径边界，应用在事务中完成。此工具只改路径，不复制文件、不执行数据库迁移，也不修复缺失的原始文件。未匹配的外部路径会保持原样并使本次操作失败，必须在同一次调用中提供完整映射。例如另有知识库根目录，可追加 `--map /old/knowledge=/app/storage/knowledge`。不要做全库字符串替换。工具只接受与当前代码匹配的数据库 schema/迁移账本；若数据库版本落后，备份后先只执行 `docker compose run --rm --no-deps migrate` 完成迁移，再做路径转换，期间仍不要启动 Web/Worker。

5. 确认所有文件引用已正确转换，移除复制数据中的旧应用管理器 PID/锁/ready 文件（不要删除 `.settings-key` 或数据库文件）。
6. 确认使用原密钥，然后执行 `docker compose up -d --wait`（预构建镜像加 `--no-build`），验证旧报告下载、知识库、品牌图像和已保存 API Key 的可用性。

工具必须离线使用；数据库事务不能替代停止所有旧服务。对账和路径转换是不同操作，路径未修好之前不要运行 `storage:reconcile`。

## 9. Worker 扩容、健康与运维

```bash
docker compose logs -f --tail 100 web worker
docker compose ps -a
docker compose run --rm --no-deps migrate storage:reconcile
# 可选：同机两个 Worker；默认每个并发 3，合计最多 6 个任务槽位。
docker compose up -d --scale worker=2 --wait
```

Worker 未设置固定容器名称，心跳位于每个容器自己的 `/tmp`，副本不会相互覆盖。增加副本前确认内存、模型限流、预算和 SQLite 写竞争；并发/解析限制并非全部为跨进程全局计数。基础冒烟测试不代替真实模型、高负载、故障注入和维护竞争压测，不建议盲目增加副本。

- Web 健康接口只返回最小状态，不暴露数据库路径或错误详情，不依赖外部模型服务。
- Worker 健康依据轮询推进与数据库访问，不使用一次性的 ready 文件。心跳时效为 `max(60 秒, 3 × pollMs)`；启用容器健康检查时轮询周期应为 100～600000 毫秒，默认 1000 毫秒。无效/过期心跳会失败。全部 Worker 停止时，周期性预算对账和存储维护也会停止。
- 进程异常退出会按 `unless-stopped` 重启；Docker 标记 `unhealthy` **本身不会触发重启**，需监控告警后诊断。
- SIGTERM 会转发到前台 Node 进程；Worker 有 90 秒退出宽限期。若被 OOM 或强制终止，任务按现有租约规则恢复，也可能因不确定的 AI 调用进入失败状态，不能承诺外部模型调用恰好一次。
- 不要在容器内执行 `pnpm start/stop/restart`，其后台进程管理器不是 Docker 生命周期管理方式。

## 10. 验证与排障

有 Docker、Compose 和 Node.js 的开发机/CI 可执行：

```bash
sh scripts/test-docker.sh
```

脚本使用唯一项目名、临时环境和独立数据卷，创建临时管理员，验证生产 API、PDF/DOCX 上传解析、Worker 消费、容器重建后数据保留及两个 Worker 启动，最后删除**该测试项目**的容器、卷和镜像。不使用真实模型密钥，不要手工把冒烟脚本指向生产数据。

没有 Docker 的开发机可先执行 `pnpm build`，再运行 `node scripts/test-production.mjs`。该脚本复制运行产物到临时目录，使用独立数据库和临时本地端口，完成后关闭进程并删除临时数据；它不验证镜像依赖裁剪、容器权限或 Compose 行为，不能替代 Docker 冒烟测试。

常见问题：

| 现象 | 检查方向 |
| --- | --- |
| `migrate` 退出非零 | 数据权限、原数据库版本与迁移账本；不要自动删库 |
| 运行参数与构建上限不一致 | 同一 `REPORT_MAX_UPLOAD_BYTES` 重新构建镜像和创建容器；GHCR 预构建镜像固定 `26214400`，自定义上限须自行构建 |
| 拉取 GHCR 镜像 401 / denied | 包默认私有；需 `docker login ghcr.io`，或由维护者将包可见性改为 public |
| 页面打开但登录不保持 | HTTPS、生产 Cookie、Host/转发协议头 |
| 旧文件 404 或维护告警 | 数据是否完整、数据库绝对路径是否已转换 |
| API Key 无法解密 | 原密钥文件/环境变量是否保留，是否误换密钥来源 |
| 容器退出 137 / OOMKilled | 内存限制、每个 Worker 并发及解析子进程资源 |
| Worker 不健康 | 轮询/数据库访问、SQLite 锁、磁盘空间和心跳文件；检查日志 |
| 本地模型地址不可达 | 容器的 localhost 是容器自己；使用可达的宿主机地址或同网络服务名 |

CI 包含独立的代码检查 / 测试 / 构建 job 与 Docker 构建冒烟 job。GitHub Release 发布工作流会先调用该 CI，两者均通过后再推送 GHCR 镜像。没有 Docker daemon 的环境只能运行源码测试和生产构建，不能据此宣称容器部署已通过验证。

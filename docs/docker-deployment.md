# Docker 部署

研行使用**同一镜像、单一 Compose 服务 `app`** 运行。默认入口启动 supervisor，由它先执行数据库迁移，再同时管理 Web 与 Worker；不需要 Redis、独立数据库，也不再提供 `web` / `worker` / `migrate` 服务或 `all` 启动模式。现有 `pnpm dev/start` 本地部署方式不变。

部署可以使用 GitHub Release 发布后推送到 GHCR 的预构建镜像，也可以继续用仓库内 Dockerfile / Compose 在本机构建。**`v0.1.2` 是首个单容器版本**（`ghcr.io/anacondakc/yanxing:v0.1.2`）。已发布的 `v0.1.1`、`v0.1.0` 镜像面向旧的多容器 Compose，不能与本仓库现在的单容器 `compose.yaml` 搭配。**不要假定 `latest` 已经是新布局**（`latest` 只在一次成功的非预发布稳定版发布后才会更新；确认 `v0.1.2` 镜像可用之前，`latest` 仍可能指向多容器的 `v0.1.1`）。拉取预构建镜像前，须等待对应 Release 的 Actions（CI、Docker 部署冒烟、镜像推送）全部成功，并在 Packages 上确认 `v0.1.2` 标签可用；发布前或流水线进行中请本地构建。容器基准环境为 Node.js 24.20.0、pnpm 11.18.0，与 `.nvmrc` 和 CI 一致。对外再分发构建镜像前，应另行核验最终产物中的第三方组件，见 [第三方许可证说明](third-party-licenses.md)。发布范围与验证边界见 [v0.1.2 发布说明](releases/v0.1.2.md)。

## 镜像运行产物

Docker 构建使用 Next standalone，并在构建阶段将 Worker、数据库迁移、用户/存储管理命令及 PDF/DOCX 解析子进程预编译为 `.runtime/` 下的 JavaScript。最终镜像只合并 Web 与这些入口实际追踪到的运行依赖，另行保留静态资源和第三方许可文件，不复制完整 `node_modules` 或 `.next/cache`。构建工具仍保留在构建阶段。

- 基础环境继续使用 Debian bookworm slim / Node 24，保留 shell，不切换 Alpine，也不削减 PDF/DOCX 功能。
- 程序、依赖及管理脚本由 root 拥有，运行用户只读；仅 `/app/storage`、`/app/.next/cache` 和临时目录允许应用写入。不要将整个程序目录改为运行用户所有。
- Docker 内 `YANXING_COMPILED_RUNTIME=1` 选择预编译解析子进程；不要覆盖此内部运行标记。现有源码部署 `pnpm dev/start` 仍使用原来的 TypeScript 启动方式。
- 默认无参数入口启动 supervisor；由 supervisor 先迁移，再同时拉起 Web（`/app/server.js`）与 Worker（`/app/.runtime/`）。管理子命令为 `migrate`、`user:create`、`storage:reconcile`、`storage:relocate`，通过入口脚本调用；不要在镜像内直接执行旧的 `.ts` 路径或依赖 `tsx`。不要再按独立的 web / worker / all 模式启动。
- 第三方许可文件保留于 `/app/third-party-licenses/`（包含构建依赖的许可副本，并非运行依赖清单）；镜像对外再分发仍需核验最终组件。
- 本次单容器调整不更改数据库结构、数据卷和密钥；升级仍应备份并保留旧镜像以便回滚。

## 1. 环境与边界

- Docker Engine + Docker Compose v2（建议 2.24 或更新版本，支持 `up --wait`）。生产服务器不需要安装 Node.js/pnpm。
- 单台 Linux 主机、本地磁盘数据卷；不要通过 NFS/SMB 在多台主机之间共享 SQLite。Compose 只运行 **1 个 `app` 容器**，容器内同时有 Web 与 Worker。单机 SQLite **不要** `--scale` 扩容容器，也不要并行启动第二个无参数 `app` 实例。
- 容器内 Worker 默认并发 3 个任务，可通过 `YANXING_WORKER_CONCURRENCY=1/2/3` 调整。PDF/DOCX 解析仍有独立并发限制，并与 Web/Worker 共享同一容器的内存、CPU 和 PID 上限。
- `app` 默认共享上限为 4 GiB 内存、4 CPU（`YANXING_MEMORY` / `YANXING_CPUS`），是上限不是资源预留。**把 Web 与 Worker 合并进同一容器并不会节省内存**；请勿因“少了一个容器”就把内存降到约 2 GiB。建议主机至少 4 GiB 内存并保留系统余量。仅在本机构建镜像时还需要额外内存和磁盘；拉取预构建镜像不需要构建资源。实际配置应根据文件大小、模型响应与并发压测调整。
- GHCR 预构建镜像仅发布 `linux/amd64`。其他架构请自行构建并做冒烟测试后再用于生产。
- 正式访问必须配置 HTTPS。生产认证使用 `__Host-`/Secure Cookie，不能以远程 HTTP 裸 IP 作为正式登录入口。

## 2. GitHub Release 与 GHCR 镜像

GitHub 在 **Release 发布（`published`）** 后触发 [`.github/workflows/docker-release.yml`](../.github/workflows/docker-release.yml)：

1. 以 `workflow_call` 调用现有 [CI 工作流](../.github/workflows/ci.yml)。**代码检查 / 测试 / 构建**（lint、test、build）与 **Docker 部署冒烟** 两个 job 都必须通过，才会继续发布。
2. 通过后构建 `linux/amd64` 镜像，使用 `GITHUB_TOKEN` 推送到 `ghcr.io/anacondakc/yanxing`。
3. 始终打上该 Release 对应的 **精确 Git 标签**（例如 `v0.1.2` → `ghcr.io/anacondakc/yanxing:v0.1.2`；历史多容器版本为 `v0.1.1` → `ghcr.io/anacondakc/yanxing:v0.1.1`）。
4. **仅当该 Release 未标记为预发布（prerelease）时**，才会同时推送 / 更新 `latest`。`latest` 表示**最近一次成功完成的稳定版发布**，不是按 semver 比较选出的最高版本。之后若又一次非预发布发布成功，`latest` 会指向后者，即使其版本号更低。
5. 该工作流**没有** `workflow_dispatch`，不能在 Actions 界面手动触发来发布镜像。

镜像是否可用，以对应 Release 的 Actions 成功结果和 GitHub Packages 上的标签为准，**不能**仅凭 Release 已创建就假定 `ghcr.io/anacondakc/yanxing:v0.1.2` 已经可以 pull。发布成功后，可在 Packages 查看 `yanxing` 容器包的 `v0.1.2` 标签。发布前、流水线进行中，或 Packages 标签尚未出现时，应 **本地构建**（默认 `yanxing:local`）。

GitHub Packages 上的 GHCR 包**默认私有**。仓库公开不等于包可匿名拉取；若需要公开拉取，须在包设置中**另行**将可见性改为 public。私有包拉取前需要登录：

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

令牌至少需要 `read:packages`。不要把登录凭据写入仓库或提交记录。

预构建镜像按 Dockerfile 默认构建参数打入 `REPORT_MAX_UPLOAD_BYTES=26214400`。运行时必须使用同一上限，否则容器入口会拒绝启动。需要其他上传上限时，**不能**使用该预构建镜像，必须自行构建。

生产环境应钉选精确标签 `ghcr.io/anacondakc/yanxing:v0.1.2`（仅在该标签的 Actions 与 Packages 均确认可用之后），不要把 `latest` 当作稳定的版本锁定，也不要假定 `latest` 已经是单容器布局。即使使用预构建镜像，也应使用与镜像标签匹配的 `compose.yaml`（按同一 Git 标签 `v0.1.2` 检出仓库）。

## 3. 首次部署（新数据）

在仓库根目录准备环境文件（拉取预构建镜像和本地构建都需要）：

```bash
cp .env.example .env
chmod 600 .env
# 编辑 .env，配置模型渠道，并为新部署生成、保存一把固定密钥：
openssl rand -hex 32
# 将生成值填写为 YANXING_SETTINGS_ENCRYPTION_KEY，勿每次重启重新生成。
```

不要把生成的密钥提交进仓库。

### 本地构建（发布前 / 流水线中仍推荐）

不设置 `YANXING_IMAGE` 时默认 `yanxing:local`。适用于 `v0.1.2` 的 GHCR 标签尚未在 Packages 上确认可用、需要自定义上传上限，或目标平台不是 `linux/amd64` 的情况：

```bash
docker compose config --quiet
docker compose up -d --build --wait --wait-timeout 180
docker compose ps -a
```

`app` 默认入口启动 supervisor；supervisor 先迁移，成功后再同时运行 Web 与 Worker。迁移失败时容器会退出，`unless-stopped` 可能反复重启；应先查看日志，不能删除数据库来绕过错误：

```bash
docker compose logs --tail 100 app
```

默认端口仅绑定宿主机 `127.0.0.1:3000`，供反向代理访问。可以在宿主机访问 `http://127.0.0.1:3000/api/health` 检查 Web；联合健康检查还要求 Worker 心跳文件有效。远程用户通过下一节的 HTTPS 域名访问。

### 从 GHCR 拉取（仅限已确认可用的 `v0.1.2`）

**不要**把已发布的多容器标签（`v0.1.1`、`v0.1.0`）配到本仓库 `compose.yaml`。不要假定 `latest` 已经是单容器布局。

仅当 `v0.1.2` Release 的 Actions（CI、Docker 部署冒烟、镜像推送）全部成功，并且 Packages 上已有 `v0.1.2` 标签后，在 `.env` 中设置：

```dotenv
YANXING_IMAGE=ghcr.io/anacondakc/yanxing:v0.1.2
```

不要使用 `v0.1.1`。发布前或流水线未完成时请改用上一节本地构建，镜像可用性以对应工作流结果与 Packages 标签为准。包仍为私有时先完成上一节的 `docker login`。然后：

```bash
docker compose config --quiet
docker compose pull
docker compose up -d --no-build --wait --wait-timeout 180
docker compose ps -a
```

建议使用 `--no-build`：Compose 文件含 `build` 定义。省略该参数时，若本地没有对应镜像，**可能**触发本地构建；加上 `--build` 会明确重新构建并覆盖所拉取的标签。

### 创建管理员

容器进入健康状态后，使用 Bash 隐藏输入密码，通过入口脚本在**正在运行的 `app`** 上创建管理员，不将密码字面量写入 shell 历史或长期写入 `.env`：

```bash
read -rsp "管理员密码: " YANXING_ADMIN_PASSWORD; echo
export YANXING_ADMIN_PASSWORD
docker compose exec -e YANXING_ADMIN_PASSWORD app /app/scripts/docker-entrypoint.sh user:create
unset YANXING_ADMIN_PASSWORD
```

默认用户名 `admin`，可追加 `--username`、`--display-name`。命令会创建或更新同名账号，并使已有会话失效，因此不要在每次启动时自动执行。

`app` 未运行时，也可先按上面的步骤读取并导出密码，将管理员创建命令替换为一次性容器命令：`docker compose run --rm --no-deps -e YANXING_ADMIN_PASSWORD app user:create`；执行后同样 `unset YANXING_ADMIN_PASSWORD`。不要在 `app` 已运行时再 `compose run` 一个无参数的 `app`，以免两个实例争用同一 SQLite。

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

如果代理也在容器里，代理容器内的 `127.0.0.1` 不是宿主机或 `app` 容器；请把代理接入应用网络，使用 `app:3000`，不要为此直接将应用端口开放到公网。

## 5. 配置与镜像

容器通过 Compose `env_file` 读取 `.env`，环境文件不会复制进镜像。Compose 固定容器工作目录为 `/app`，并覆盖以下容器内路径：

| 配置 | Docker 值 |
| --- | --- |
| `YANXING_DATABASE_PATH` | `/app/storage/yanxing.sqlite` |
| `YANXING_KNOWLEDGE_STORAGE_ROOT` | `/app/storage/knowledge` |
| `YANXING_NEXT_DIST_DIR` | `.next` |
| `PORT` | `3000` |
| `YANXING_WORKER_HEARTBEAT_PATH` | `/tmp/yanxing-worker-heartbeat.json`（镜像默认值；Compose 同样设置。`/tmp` 为 tmpfs，不要改到数据卷上的共享路径） |

Docker 宿主机配置：

| 配置 | 默认值 / 含义 |
| --- | --- |
| `YANXING_HTTP_PORT` | `3000`，宿主机映射端口，不是本地管理器的 `YANXING_PORT` |
| `YANXING_BIND_ADDRESS` | `127.0.0.1`，默认不对公网暴露 |
| `YANXING_IMAGE` | 默认 `yanxing:local`（本地构建标签）。仅当 Packages 已确认 `v0.1.2` 可用时，设为 `ghcr.io/anacondakc/yanxing:v0.1.2`。不要使用多容器的 `v0.1.1`；不要假定 `latest` 已经是新布局。`latest` 仅表示最近一次成功的稳定发布，不是 semver 最大值 |
| `YANXING_NODE_IMAGE` | `node:24.20.0-bookworm-slim`，仅使用 Node.js 24.x（≥ 24.20.0）；更换补丁版本或 digest 后需重新验证。仅本地构建时使用 |
| `YANXING_MEMORY` | `4g`，`app` 内容器共享上限（Web + Worker + 解析子进程），合并不降低内存需求 |
| `YANXING_CPUS` | `4`，同上，共享 CPU 上限 |
| `YANXING_ENV_FILE` | `.env`，自定义时需同时供 Compose 变量替换和容器 env_file 使用 |

Compose 还将 `pids_limit` 设为 **512**、`stop_grace_period` 设为 **100 秒**（supervisor 内部宽限约 80 秒，给 Docker 强制 SIGKILL 留出余量），并启用 `init: true`。镜像 `HEALTHCHECK` 为联合检查（无参数调用 `scripts/docker-healthcheck.mjs`）：Web `/api/health` 与 Worker 心跳都必须通过。间隔 15 秒、超时 10 秒、启动宽限 60 秒、连续失败 3 次后标记 `unhealthy`。

使用其他环境文件的示例：

```bash
# 本地构建
YANXING_ENV_FILE=/secure/yanxing.env docker compose --env-file /secure/yanxing.env up -d --build --wait

# GHCR 拉取（仅限 Packages 已确认的 v0.1.2）
YANXING_ENV_FILE=/secure/yanxing.env docker compose --env-file /secure/yanxing.env pull
YANXING_ENV_FILE=/secure/yanxing.env docker compose --env-file /secure/yanxing.env up -d --no-build --wait
```

修改普通运行时参数后执行 `docker compose up -d --force-recreate --wait`（使用预构建镜像时加上 `--no-build`）；单纯 `restart` 不会更新容器环境变量。

**上传上限是例外：** `REPORT_MAX_UPLOAD_BYTES` 同时参与 Next.js 构建配置。Compose 将同一个值传给构建和运行环境；容器入口会验证镜像构建记录，不一致时拒绝启动。本地修改后执行 `docker compose up -d --build --force-recreate --wait`，同时调整反向代理的上限。不要只更改运行环境。**GHCR 预构建镜像固定为默认值 `26214400`**；使用该镜像时运行时也必须保持这一上限。自定义上限需要自行构建，不能只改 `.env` 后拉取预构建镜像。

镜像采用多阶段构建：构建阶段使用 Next standalone 与预编译 Worker/管理入口，运行阶段只保留追踪到的依赖、静态资源和许可文件，不使用完整 `node_modules`，也不在运行镜像中依赖 `tsx`。原生可选依赖按目标平台安装，不要使用 `--no-optional`，也不要把宿主机 `node_modules` 复制进镜像。GHCR 发布与默认 CI 均针对 `linux/amd64`；其他架构应自行运行冒烟测试后再使用本地构建产物。定期更新基础镜像以获取安全修复。

### 不使用 Compose 的 `docker run` 示例

Compose 是推荐方式。若必须直接 `docker run`，至少启用 `--init`、用 `--env-file` 注入已有环境文件、把数据卷挂到 `/app/storage`、端口只绑 `127.0.0.1`，并把优雅停止时间设为 **至少 100 秒**。先完成本节开头的 `.env` 与密钥准备（密钥不要写入仓库）：

```bash
docker run --name yanxing \
  --init \
  --restart unless-stopped \
  --env-file .env \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -e YANXING_NEXT_DIST_DIR=.next \
  -e YANXING_DATABASE_PATH=/app/storage/yanxing.sqlite \
  -e YANXING_KNOWLEDGE_STORAGE_ROOT=/app/storage/knowledge \
  -e YANXING_WORKER_HEARTBEAT_PATH=/tmp/yanxing-worker-heartbeat.json \
  --user 1000:1000 \
  --memory 4g \
  --cpus 4 \
  --stop-timeout 100 \
  --publish 127.0.0.1:3000:3000 \
  --volume yanxing_data:/app/storage \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m,mode=1777 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 512 \
  --log-driver json-file \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  yanxing:local
```

镜像默认 `CMD` 为空，入口启动 supervisor（由它先迁移再拉起 Web 与 Worker）。容器健康后，在另一个 Bash 终端中隐藏输入管理员密码；不要将密码字面量写入命令历史或长期写入 `.env`：

```bash
read -rsp "管理员密码: " YANXING_ADMIN_PASSWORD; echo
export YANXING_ADMIN_PASSWORD
docker exec -e YANXING_ADMIN_PASSWORD yanxing /app/scripts/docker-entrypoint.sh user:create
unset YANXING_ADMIN_PASSWORD
```

停止时使用 `docker stop -t 100 yanxing`（或依赖 `--stop-timeout 100`）。不要省略 `--init`：supervisor 下有 Web/Worker 子进程，需要 PID 1 回收僵尸进程。

## 6. 数据卷、权限与密钥

默认项目名为 `yanxing`，命名卷通常为 `yanxing_data`；使用 `-p` 后卷名前缀也会改变。不要无意中更改项目名，否则可能连接一个新的空卷。从旧的多容器部署迁过来时，必须继续使用**同一项目名**，才能挂上原来的数据卷。

整个卷挂载到 `/app/storage`，包括数据库、WAL/SHM、报告原文件、解析 `.content.json` 缓存、知识库和本地 `.settings-key`。品牌图像保存在数据库中。stdout/stderr 日志由 Docker 轮转，不再写应用管理器日志。

`app` 使用 UID/GID `1000:1000`，以非 root 身份运行，入口设置 `umask 077`；新卷初始化目录为 0700。不要让其他不可信服务访问该卷。旧文件权限不会被自动递归修改。

使用宿主机目录时可添加覆盖文件，将共享 volume 的 `/app/storage` 挂载改成 `./docker-data:/app/storage`，并预先创建目录、设置属主为 1000:1000、权限 0700。不要将项目源码整体挂载到 `/app`，否则会遮蔽镜像构建产物。

**密钥不可丢失或随意更换：** 原部署使用环境变量密钥就沿用原值；原部署使用 `.settings-key` 就原样保留该二进制文件，并保持环境变量密钥未设置。不能将旧二进制密钥转成 hex 字符串直接当作环境变量密钥，两者字节内容不同。使用环境变量密钥时，要在数据备份之外另行安全备份它。

## 7. 备份、升级和恢复

### 一致性备份

先停止全部写入者（包括通过其他方式启动、共享同一数据卷的进程），再备份整个卷：

```bash
umask 077
docker compose stop -t 100 app
docker compose run --rm -T --no-deps app tar -C /app/storage -czf - . > yanxing-backup.tar.gz
# 另行安全备份 .env / 外部密钥及当前镜像版本。确认备份成功后恢复运行：
docker compose up -d --wait   # Packages 已确认 v0.1.2 时加 --no-build
```

不要在线只复制 SQLite 主文件，也不要只备份数据库或只备份上传目录。备份包含会话、密码哈希和报告，必须限制访问。

### 从 v0.1.1 及更早的多容器部署升级

已发布的 `v0.1.1` 是 **Web / Worker / migrate 三个服务** 的旧布局。切换到当前单容器 `compose.yaml` 之前，必须先用**旧 Compose** 停掉旧容器，否则旧 Worker 可能成为孤儿进程，继续领取并执行任务。

下列 `web` / `worker` / `migrate` **只用于从旧版多容器迁移**，不是当前 Compose 的服务。上一小节的 `app` 备份命令在旧 Compose 上不可用，应**先用旧文件备份，再 `down`**。

1. **先不要**把新 `compose.yaml` 直接 `up` 到仍在跑的旧项目上。
2. **仅旧版多容器迁移示例。** 在仍包含 `web` / `worker` / `migrate` 的旧工作副本（项目根目录）中，先 `stop` Web 与 Worker，用旧 `migrate` 服务打包数据卷，再 `down`（**不要加 `-v`**）：

   ```bash
   umask 077
   docker compose stop -t 90 web worker
   docker compose run --rm -T --no-deps migrate tar -C /app/storage -czf - . > yanxing-backup.tar.gz
   # 另行安全备份 .env / 外部密钥及当时的镜像标签
   docker compose down
   ```

   若当前目录已经是新代码，把旧标签中的 Compose 写到 `/tmp` 后，**必须**加 `--project-directory "$PWD"`（并在项目根目录执行）。只写 `-f /tmp/...` 时，相对的 `.env` 与 `build.context` 会解析到 `/tmp`，可能在 `down` 之前就因找不到 `.env` 失败。保持同一项目名：

   ```bash
   git show v0.1.1:compose.yaml > /tmp/yanxing-compose-v0.1.1.yaml
   umask 077
   docker compose -p yanxing --project-directory "$PWD" -f /tmp/yanxing-compose-v0.1.1.yaml \
     stop -t 90 web worker
   docker compose -p yanxing --project-directory "$PWD" -f /tmp/yanxing-compose-v0.1.1.yaml \
     run --rm -T --no-deps migrate tar -C /app/storage -czf - . > yanxing-backup.tar.gz
   docker compose -p yanxing --project-directory "$PWD" -f /tmp/yanxing-compose-v0.1.1.yaml down
   ```

3. 检出 `v0.1.2` 单容器代码，**保留**原项目名（默认 `yanxing`）、原数据卷、原 `.env` 与 `YANXING_SETTINGS_ENCRYPTION_KEY`（不要重新生成）。旧的 `YANXING_WEB_MEMORY` / `YANXING_WORKER_MEMORY` 及对应 CPU 限制不再生效，应改为共享的 `YANXING_MEMORY` / `YANXING_CPUS`。
4. 将保留的 `.env` 中 `YANXING_IMAGE` 改为**不会覆盖回滚镜像的新标签**，不要沿用 `v0.1.1`、`latest` 或旧本地镜像标签，否则 `--build` 会覆盖用于回滚的旧镜像。不要假定 `latest` 已经是单容器布局。
   - **本地构建**（发布前、流水线中，或尚未确认 GHCR 标签时）：例如 `YANXING_IMAGE=yanxing:v0.1.2-local`，然后：

     ```bash
     docker compose up -d --build --wait --wait-timeout 180
     ```

   - **GHCR 预构建镜像**：仅当 `v0.1.2` 的 Actions 与 Packages 标签均确认可用后，设为 `YANXING_IMAGE=ghcr.io/anacondakc/yanxing:v0.1.2`，再执行 `docker compose pull` 与 `docker compose up -d --no-build --wait --wait-timeout 180`。

5. 检查 `docker compose ps -a`、登录、原有报告下载、PDF/DOCX 上传和分析任务。

### 单容器版本之间的升级

1. 停止 `app`，按「一致性备份」完整备份（使用当前的 `app` 服务，不要套用上一节的 `web` / `worker` / `migrate`）。
2. 切换到与目标镜像匹配的代码版本（至少更新 `compose.yaml`），保留原 `YANXING_SETTINGS_ENCRYPTION_KEY`，不要重新生成。
3. 更新 `.env` 中的 `YANXING_IMAGE`：
   - GHCR：仅当目标 Git 标签（当前单容器版本为 `v0.1.2`）的 Actions（CI / Docker 冒烟 / 镜像发布）全部成功且 Packages 标签可用后，设为 `ghcr.io/anacondakc/yanxing:v0.1.2`（后续版本替换为对应精确标签），执行 `docker compose pull`，再执行 `docker compose up -d --no-build --force-recreate --wait --wait-timeout 180`。不要假定 `latest` 已经是新布局。
   - 本地构建：设为新的本地版本标签（例如 `yanxing:v0.1.2-local`，不要覆盖用于回滚的旧标签；也可继续 `yanxing:local`），执行 `docker compose up -d --build --force-recreate --wait --wait-timeout 180`。
4. 检查健康状态、登录、原有报告下载、PDF/DOCX 上传和分析任务。

本方案不承诺滚动零停机升级。迁移可能改变数据库结构；回滚时应恢复旧镜像及对应数据、密钥，不能只切换镜像标签。从单容器回滚到 `v0.1.1` 多容器时，也必须先停掉当前 `app`，再使用与 `v0.1.1` 匹配的 Compose（若把旧文件放到 `/tmp`，同样要加 `--project-directory "$PWD"`），不能把旧镜像配上新 Compose。迁移账本的 checksum 校验失败应排查版本问题，不能修改已发布迁移文件或删除账本来绕过。

### 恢复

在全新空卷上恢复最安全。下例使用新的 Compose 项目 `yanxing-restored`，因此不会覆盖原项目卷；恢复期间不要启动第二个会写入的实例：

```bash
docker compose -p yanxing-restored run --rm -T --no-deps app \
  sh -c 'tar -C /app/storage -xzf - && chmod -R go-rwx /app/storage' < yanxing-backup.tar.gz
# 确保 .env 使用匹配的镜像配置和原加密密钥，并避免与原实例争用宿主机端口。
docker compose -p yanxing-restored up -d --wait   # Packages 已确认 v0.1.2 时加 --no-build
```

不要把备份叠加恢复到正在使用或含其他数据的目录；数据库与文件集合不一致可能导致维护流程删除被判定为孤立的文件。

**警告：`docker compose down -v` 会删除命名数据卷。普通停机使用 `stop` 或不带 `-v` 的 `down`。从多容器迁到单容器时，`down` 同样不能加 `-v`。**

## 8. 从非 Docker 部署迁入

旧报告、知识库和存储台账可能保存宿主机绝对路径，仅复制 `storage/` 会使容器找不到文件。

1. 停止旧 Web、Worker 和其他维护进程；完整备份数据库、上传文件、缓存与原密钥。
2. 拉取或构建**单容器**镜像，但暂不运行无参数的 `up`（默认入口会启动 supervisor，先迁移再同时拉起 Web 与 Worker，Worker 会做存储维护）。
3. 用上一节的恢复命令将备份导入空数据卷，统一权限。若旧数据库或知识库使用自定义外部路径，也必须完整导入相应数据。
4. 在复制后的数据库上预览旧根路径转换，再显式应用：

```bash
docker compose run --rm --no-deps app storage:relocate \
  --from /old/server/YanXing/storage --to /app/storage
docker compose run --rm --no-deps app storage:relocate \
  --from /old/server/YanXing/storage --to /app/storage --apply
```

`--from` 是数据库记录的旧绝对存储根目录，不是新备份文件所在位置。默认只预览；转换前检查目标文件和路径边界，应用在事务中完成。此工具只改路径，不复制文件、不执行数据库迁移，也不修复缺失的原始文件。未匹配的外部路径会保持原样并使本次操作失败，必须在同一次调用中提供完整映射。例如另有知识库根目录，可追加 `--map /old/knowledge=/app/storage/knowledge`。不要做全库字符串替换。工具只接受与当前代码匹配的数据库 schema/迁移账本；若数据库版本落后，备份后先只执行 `docker compose run --rm --no-deps app migrate` 完成迁移，再做路径转换，期间仍不要启动会写入的 `app`。

5. 确认所有文件引用已正确转换，移除复制数据中的旧应用管理器 PID/锁/ready 文件（不要删除 `.settings-key` 或数据库文件）。
6. 确认使用原密钥，然后执行 `docker compose up -d --wait`（Packages 已确认 `v0.1.2` 时加 `--no-build`），验证旧报告下载、知识库、品牌图像和已保存 API Key 的可用性。

工具必须离线使用；数据库事务不能替代停止所有旧服务。对账和路径转换是不同操作，路径未修好之前不要运行 `storage:reconcile`。

## 9. 健康与运维

```bash
docker compose logs -f --tail 100 app
docker compose ps -a
# 运行中的管理命令（示例）：
docker compose exec app /app/scripts/docker-entrypoint.sh storage:reconcile
# 必须停机后再做的维护（路径转换 / 单独迁移）：
docker compose stop -t 100 app
docker compose run --rm --no-deps app storage:relocate --help
docker compose run --rm --no-deps app migrate
```

- **不要** `docker compose up -d --scale app=2`，也不要为同一数据卷再启动第二个无参数 `app`。不支持多实例部署，可能产生锁竞争、资源超限或任务冲突。
- 合并不节省内存：需要同时容纳 Web、Worker 和解析子进程。降低 `YANXING_MEMORY` 前应做压测。
- Web 健康接口只返回最小状态，不暴露数据库路径或错误详情，不依赖外部模型服务。
- Worker 健康依据轮询推进与数据库访问，不使用一次性的 ready 文件。心跳默认 `/tmp/yanxing-worker-heartbeat.json`；时效为 `max(60 秒, 3 × pollMs)`。启用容器健康检查时轮询周期应为 100～600000 毫秒，默认 1000 毫秒。无效/过期心跳会失败。Worker 未在跑时，周期性预算对账和存储维护也会停止。
- Dockerfile / Compose 使用**联合健康检查**：无参数调用时 Web 与 Worker 都必须通过。`unhealthy` **本身不会触发 Docker 重启**（`restart: unless-stopped` 只在容器进程退出时重启）。Web 或 Worker **任一退出（即使退出码为 0）时，supervisor 会停止另一方并以非零状态退出**，由 Docker 重启**整个容器**；supervisor **不会**在容器内单独拉起某一个子进程。需对 `unhealthy` 做监控告警后诊断，不要假定 Docker 会因健康检查失败而自动恢复。
- SIGTERM 由 supervisor 转给 Web 与 Worker。Compose `stop_grace_period` 为 100 秒，supervisor 内部宽限约 80 秒。若被 OOM 或强制终止，任务按现有租约规则恢复，也可能因不确定的 AI 调用进入失败状态，不能承诺外部模型调用恰好一次。
- 不要在容器内执行 `pnpm start/stop/restart`，其后台进程管理器不是 Docker 生命周期管理方式。

## 10. 验证与排障

有 Docker、Compose 和 Node.js 的开发机/CI 可执行：

```bash
sh scripts/test-docker.sh
```

脚本使用唯一项目名、临时环境和独立数据卷，创建临时管理员，验证生产 API、PDF/DOCX 上传解析、Worker 消费、容器重建后数据保留及单一 `app` 联合健康检查，最后删除**该测试项目**的容器、卷和镜像。不使用真实模型密钥，不要手工把冒烟脚本指向生产数据。

也可验证一个已构建的本地镜像（不会重新构建或删除该镜像，仍只使用独立的临时容器和数据卷）：

```bash
docker build -t yanxing:slim .
YANXING_TEST_IMAGE=yanxing:slim sh scripts/test-docker.sh
docker image ls yanxing:slim
```

体积比较应使用相同 Docker 存储后端和统计口径；本地 `docker image ls`、未压缩层合计、仓库压缩传输量及 `docker save | gzip` 文件大小不一定相同。构建缓存和运行时数据卷不属于应用运行镜像的功能产物。

没有 Docker 的开发机可先执行 `pnpm build`，再运行 `node scripts/test-production.mjs`。该脚本复制运行产物到临时目录，使用独立数据库和临时本地端口，完成后关闭进程并删除临时数据；它不验证镜像依赖裁剪、容器权限或 Compose 行为，不能替代 Docker 冒烟测试。

常见问题：

| 现象 | 检查方向 |
| --- | --- |
| `app` 启动后立刻退出 / 反复重启 | 迁移是否失败；数据权限、原数据库版本与迁移账本；不要自动删库 |
| 运行参数与构建上限不一致 | 同一 `REPORT_MAX_UPLOAD_BYTES` 重新构建镜像和创建容器；GHCR 预构建镜像固定 `26214400`，自定义上限须自行构建 |
| 拉取 GHCR 镜像 401 / denied | 包默认私有；需 `docker login ghcr.io`，或由维护者将包可见性改为 public |
| 拉取 `v0.1.2` 失败 / 标签不存在 | Release 已创建不等于镜像已推送。须等待 CI、Docker 冒烟与镜像发布全部成功，并在 Packages 确认 `v0.1.2` 后再 pull；此前请本地构建 |
| 使用 `v0.1.1` 无法按本文启动 | `v0.1.1` 是多容器旧镜像；当前 Compose 只有 `app`。请本地构建，或在 Packages 确认后使用 `ghcr.io/anacondakc/yanxing:v0.1.2`。不要假定 `latest` 已经是新布局 |
| 升级后仍有任务被“旧 Worker”执行 | 切换新 Compose 前未用旧 Compose `down`（无 `-v`），孤儿容器仍在写同一数据卷 |
| 页面打开但登录不保持 | HTTPS、生产 Cookie、Host/转发协议头 |
| 旧文件 404 或维护告警 | 数据是否完整、数据库绝对路径是否已转换 |
| API Key 无法解密 | 原密钥文件/环境变量是否保留，是否误换密钥来源 |
| 容器退出 137 / OOMKilled | 共享内存上限、Worker 并发及解析子进程；合并不节省内存 |
| `unhealthy` 但容器仍在跑 | 预期行为：健康检查失败不会触发 Docker 重启；查 Web 健康接口、心跳文件与应用日志。若 Web 或 Worker 进程已退出，supervisor 会带另一方一起退出，由 Docker 重启整个容器 |
| Worker 不健康 | 轮询/数据库访问、SQLite 锁、磁盘空间和心跳文件；检查日志 |
| 本地模型地址不可达 | 容器的 localhost 是容器自己；使用可达的宿主机地址或同网络服务名 |

CI 包含独立的代码检查 / 测试 / 构建 job 与 Docker 构建冒烟 job。GitHub Release 发布工作流会先调用该 CI，两者均通过后再推送 GHCR 镜像。没有 Docker daemon 的环境只能运行源码测试和生产构建，不能据此宣称容器部署已通过验证。

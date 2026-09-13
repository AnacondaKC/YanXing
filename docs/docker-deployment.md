# Docker 原生部署

> 当前是课题—阶段—不可变报告提交模型：**只初始化新库或校验同模型原生库，不迁移旧数据库、不做双模兼容**。仓库 `main`（0.2.0）即为该模型的源码。已发布的 GHCR `v0.1.x` 只对应历史版本，不能当作当前实现；正式镜像须等待对应 GitHub Release 的 CI、Docker 验收与镜像发布全部成功。

## 1. 运行边界

- 同一镜像、单个 Compose app 服务；supervisor 先执行名为 migrate 的原生初始化/校验命令，成功后再管理 Web 与默认 Worker。旧库、混合库、schema/根绑定不符均拒绝，禁止删库或改账本绕过。
- 新部署默认使用 compose.yaml 中的项目名 `yanxing` 与卷 `yanxing_data`、配置文件 `.env`。若宿主机已有同名项目或卷（例如 v0.1.x 实例），必须另选 `-p <新项目名>` 和新卷，不复用现有数据。已有旧实例保持原样；停机、删除或替换须单独确认。
- 单台 Linux、本地磁盘 SQLite，不通过 NFS/SMB 多机共享，不运行 scale app=2，不同时启动多个写入实例。
- Docker Engine、Compose v2（建议2.24+）；Node.js 24.20.0、pnpm 11.18.0，基础镜像node:24.20.0-bookworm-slim。构建使用 Next standalone 与预编译 .runtime，不依赖运行时 tsx。
- 进程 UID/GID 1000:1000，代码 root 所有、运行用户只读。只允许数据、缓存和临时目录写入。默认共享资源上限4 GiB/4 CPU，Worker并发1～3；这不是容量承诺。
- 正式访问必须 HTTPS。经反向代理暴露时，仅当 Web 只能经可信代理访问才开启 `YANXING_TRUST_PROXY`。外部模型费用与凭证由操作者负责。

## 2. 镜像与一致发布

Web、Worker、解析器和管理 CLI 必须来自**同一个已验收发布包**。隔离验收工具生成 BUILD_ID、runtime 入口 SHA-256 和发布身份，见 [P5 验收记录](project-stage-report-p5-acceptance.md)；那些标签不是正式发布标签。

在对应源码标签的 CI、Docker 验收和镜像发布全部成功前，不要把既有 `v0.1.2` 或 `latest` 当作当前原生镜像。正式发布后核对镜像 digest 和匹配的 Compose。GitHub 发布机制见 [.github/workflows/docker-release.yml](../.github/workflows/docker-release.yml)，不以文档中的版本号代替实际验证。

需要私有包时使用 password-stdin 登录 registry，凭据不入仓库。正式运行钉选已确认 digest；本地构建用新的标签，勿覆盖用于回退的旧产物。REPORT_MAX_UPLOAD_BYTES 的构建值与运行值必须一致，默认26214400。

## 3. 首次部署

下列步骤适用于新项目和新卷，且目标端口未被现有实例占用。默认配置文件为 `.env`；文件已存在时不要覆盖。

```bash
test ! -e .env && cp .env.example .env
chmod 600 .env
# 只生成一次稳定密钥并妥善保存，勿把生成结果提交到仓库：
openssl rand -hex 32
# 编辑 .env，填写固定 YANXING_SETTINGS_ENCRYPTION_KEY、确认后的端口与模型配置。
# 对应 GHCR 标签可用前保持默认 YANXING_IMAGE=yanxing:local。
docker compose --env-file .env config --quiet
# 确认 yanxing_data 是新卷后才执行：
docker compose --env-file .env up -d --build --wait --wait-timeout 180
docker compose --env-file .env ps -a
```

若宿主机已有 `yanxing` 项目或 `yanxing_data` 卷，改用 `docker compose --env-file .env -p <新项目名> ...`，并确认产生的是新卷。使用已核实的预构建镜像时先 pull，再 `up --no-build`，避免意外覆盖标签。对应 Release 完成前不要假定 registry 已有当前源码的镜像。

容器健康后创建管理员；该命令会更新同名账号并使已有会话失效，不要每次启动自动运行：

```bash
read -rsp "管理员密码: " YANXING_ADMIN_PASSWORD; echo
export YANXING_ADMIN_PASSWORD
docker compose --env-file .env run --rm -e YANXING_ADMIN_PASSWORD app user:create
unset YANXING_ADMIN_PASSWORD
```

默认用户名admin，可追加--username、--display-name。仅浏览不需要可用模型；实际分析/洞察需要完整评估上下文和可用渠道。阶段计划保存允许部分可选字段，AI准入另要求阶段工作内容和计划完成日期。分析与洞察每种操作分别总成功最多3次（初次成功+最多2次重新生成），失败/取消不占成功额度。未选模型（MODEL_NOT_CONFIGURED）、缺API key（MODEL_CREDENTIALS_MISSING）或缺评价上下文（PROJECT_CONTEXT_INCOMPLETE）返回409；前两项请联系管理员配置，未知解密/数据库/损坏配置异常仍为500。

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


## 5. 数据与密钥

默认卷内数据库为 /app/storage/yanxing.sqlite；原生报告根为 /app/storage/reports，知识库为同级knowledge，品牌设置及相关数据随原生备份保留。报告正文在数据库中持久化；正式文件及逻辑删除文件均保留，不自动物理清理。

固定 YANXING_SETTINGS_ENCRYPTION_KEY 必须单独安全保管，不能轮换后直接启动，也不能用旧 .settings-key 回退代替原生执行所需的显式主密钥。主密钥不要放入数据归档或镜像。

数据库与绑定根必须一致；移动数据不等于更改数据库中的绑定路径。storage:relocate 已关闭，不存在旧根映射或历史字段迁移流程。外部自定义知识库根不在本轮备份工具自动覆盖范围内；工具明确拒绝，不静默漏备。

## 6. 同模型备份与恢复

详见 [P5备份与恢复步骤](project-stage-report-p5-acceptance.md)。使用镜像内 /app/.runtime/scripts/native-backup.mjs，不依赖源码工具，不在线复制SQLite主文件。

- 先停止所有写入者。备份检查活动任务、未结束准备记录和配额预留，并持有SQLite写栅栏，使用SQLite backup生成一致快照。
- 归档包含数据库、正式/墓碑文件、知识资料和品牌资源；所有文件校验和受强制HMAC清单认证。密钥单独保管；归档本身含敏感明文，仍需私有权限和安全/加密存储。
- 恢复只接受同schema、同绑定绝对路径和同密钥；目标必须不存在，包含空目录也拒绝。不会覆盖原库、改写source/root绑定、自动启动服务或自动重跑模型。
- **Docker卷挂载根总是存在**，不能把标准 /app/storage 挂载点直接当作“不存在的恢复目标”。可在离线维护容器中把一个新的可写宿主机父目录挂到/app、将匹配发布包挂到/tools，在其中重建同路径/app/storage，再将重建出的宿主机storage目录绑定到正式容器的/app/storage。完整命令与前置条件见P5记录；禁止因此添加force或原地覆盖。
- 恢复中断必须保持停机，保留中断标记和部分目录供检查。不要删除标记后直接启动；重新恢复前先按明确的操作决定隔离残留目录。
- 恢复点之后的数据不由旧快照自动补回。核查RPO、任务及模型调用状态、账号会话和报告/文件一致性后才重新开放写入。

旧模型不能导入新系统；不通过清库或降级旧模型解决故障。普通停机使用stop或不带-v的down；不要删除数据卷。

## 7. 健康、失败与重试

```bash
docker compose --env-file .env logs --tail 100 app
docker compose --env-file .env ps -a
```

- /api/health是Web最小健康状态；联合健康检查还要求Worker心跳有效。单个ready文件不能证明Worker持续健康。
- unhealthy本身不会触发Docker重启。Web/Worker任一退出时，supervisor停止另一方并非零退出；由Docker重启整个容器，不在容器内单独拉起某一旧进程。
- SIGTERM转发到两个进程，Compose宽限100秒。未完成模型调用由租约恢复终止原任务，不自动重放；用户可按资格手工重试为新代次。
- 旧库/混合库/身份不符：停机排查，勿删表、修改checksum或复用旧上传协议。
- 401/登录不保持：检查HTTPS、Host/代理头、固定密钥与会话。仅可信反向代理环境开启TRUST_PROXY。
- OOM/137：检查共享资源、Worker并发和解析子进程；不能凭事务微基准认定生产容量。

## 8. 可复现隔离验收

使用P5的发布打包、容器、真实Web/Worker和浏览器脚本，均只操作自己的临时数据、端口及容器。命令及证据见 [P5验收记录](project-stage-report-p5-acceptance.md)。它们不是生产切换脚本，不复用现有卷或付费模型凭证。

第三方再分发须核验发布包中的许可，见 [第三方许可证说明](third-party-licenses.md)。

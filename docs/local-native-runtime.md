# 本机原生开发实例

本轮按用户授权修复后，本机 3000 端口的开发实例已切换到全新的原生运行目录。源码版本为 0.2.0（未发布）；没有迁移旧库，也没有覆盖已封存的 Docker 镜像或发布候选。

## 当前配置

- 数据库：`storage-native/runtime-f25b0a40/yanxing.sqlite`。
- 报告根：`storage-native/runtime-f25b0a40/reports`。
- 知识根：`storage-native/runtime-f25b0a40/knowledge`。
- Worker 心跳：`storage-native/runtime-f25b0a40/worker-heartbeat.json`。
- schema：`yanxing-native-p3`，checksum 为 `f25b0a40dbb64eade89c7c4bde332d3dd916635ad015e18ab63935ad28574f22`。
- Web：`http://localhost:3000`，使用 `next dev --webpack`；Web 产物目录为 `.next-dev`。
- Worker：原生 `worker/index.ts`；Web/Worker 从 `.env.local` 读取相同的数据库路径和稳定主密钥。
- 进程状态、日志仍由 `scripts/app-manager.mjs` 管理，位于 `storage/` 下。

`.env.local` 只更新了数据库、知识根和心跳路径，既有主密钥与模型环境配置保留。原 `storage-native/yanxing.sqlite`、原报告/知识目录及更早的 `storage/yanxing.sqlite` 均未覆盖。停止旧进程后的旧原生 SQLite SHA-256 与新实例启用后相同。

## 登录和操作

已用本机 `.env.native-admin` 中既有凭据重新创建 `admin` 管理员；密码不写入本文。新库没有迁入旧账号、课题、报告或任务，旧会话失效，请刷新并重新登录。

```bash
pnpm dev
pnpm status
pnpm stop
```

等价的启动器命令为 `node scripts/app-manager.mjs start --mode development`。`dev` 是 package script 名，不是启动器子命令。

## 本轮运行验证

- 未登录访问 `/` 返回 307 到 `/login`，这是正常鉴权行为。
- `/login`、`/api/health`、`/api/branding` 均返回 200；health 为 `{"status":"ok"}`。
- 管理员登录及 `/api/auth/me`、`/api/projects`、`/api/overview-stats` 均返回 200，验证会话随后退出。
- 联合 Web/Worker 心跳检查通过。运行验证没有创建报告或模型任务，也没有调用付费模型。

## 后续 schema 变更

本版本不提供历史兼容或数据库迁移。启动时只初始化空库，或校验与当前 schema 完全匹配的原生库；不匹配就拒绝，不改写旧数据。以后若再次改变 schema：停止 Web/Worker，统一构建代码，使用新的数据库和配套报告、知识目录，再初始化并启动。不要只切数据库却复用未知知识根；不要修改 checksum 绕过校验。

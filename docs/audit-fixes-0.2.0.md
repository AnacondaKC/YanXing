# 0.2.0 审查修复与验证记录

本轮按已核对的修复范围实施。不做历史数据库兼容、迁移或兼容 re-export；保留已有未提交改动，没有创建 Git 提交。源码版本更新为 0.2.0（未发布）。

## 已修复

| 项目 | 实施结果 |
| --- | --- |
| B-1 / S-2 | 确定的阶段、工作流、计划冲突可从 uncertain 收敛为 conflict；需重新读取令牌后才能确认。其它明确 HTTP 失败通过已有上传查询核对，已提交则使用原回执，终态失败解除上传阻塞，幂等键冲突且上传仍 ready 时进入重新确认。真正网络不确定或核对失败仍保留原 command/key，不重新上传。 |
| B-2 | 缺少显式设置主密钥时，活跃分析/洞察启动及重试入口返回 503 / SETTINGS_ENCRYPTION_KEY_MISSING；自动入队的延后记录保留该错误码，不创建付费调用。更新 .env.example，明确原生任务不接受 .settings-key 回退。 |
| B-6 | 任务响应提示改为中性的“任务状态已同步”，不把复用运行中任务误报为新入队。 |
| S-10 | 空知识记录和零知识分配时，陈旧未知知识文件及孤立 sidecar 不自动删除；dry-run 和实际执行均明确诊断。临时清理及其它对账继续，既有 active reservation、最近变更、正式/墓碑报告保护保留。 |
| F-2 | native 维护分支去掉首次冗余 usage 重建；保留最终过期预留过滤口径。 |
| S-11 | 各相关事务与 savepoint 的异常清理不再以回滚失败覆盖原错误；复用已有保护模式，不新增事务框架。 |
| P-3 | Worker poll 允许值与 healthcheck 对齐为 100–600000ms，越界沿用默认 1000ms。 |
| S-6 / S-7 | 验收等待器识别子进程 signal 退出；命令和停止等待的竞争超时计时器在结束后清理。 |
| S-4 / S-5 / R-1 | 旧 Docker smoke 改为破坏隔离 native_schema_identity checksum，日志匹配当前初始化/监督器输出；保留有意的 legacy 空表拒绝夹具。 |
| I-7 | 文档对齐当前 overview 的 120 次/分钟，不改变 API 限流策略。 |
| P-7 / P-9 / F-5 | retry 补根检查；备份错误码改 Object.hasOwn；审计前缀查询复用现有 BINARY 范围谓词。 |
| I-8 / R-4 / R-5 | 更新版本及破坏性变更说明；Next 构建重新生成正确的 next-env.d.ts 引用；README 备份命令统一 pnpm。 |

## 删除确认孤立的代码

- 旧 runAnalysisPipeline / AnalysisPipelineRepository / previousVersionId 接线；保留活 runAnalysisExecution 与实际评分展示。
- submission-task-handlers、stage-project-handlers 及 runtime 的闲置挂件。四套原工厂回归已改测真实 workspace handlers，保留授权、限流、请求体限制、版本冲突和任务复用验证。
- report-load-state、Dashboard 从未传入的加载/错误 props 和分支。
- 恒空 moduleStates 的 state → workspace → Dashboard → ResearchWorkbench 传参链，保留任务级进度和原界面布局。
- 旧事件解析/合并 helper、指定的 workspace 测试专用 wrapper、孤立的配置校验和用户查询 helper、readLockIdentity。
- EMPTY_WORKSPACE_CAPABILITIES 移入 test/helpers/workspace-capabilities.ts，无生产兼容导出；有意义的 selection/prepare/conflict 回归直接调用活 domain/reducer。
- usage_settled / usage_reconciled 闲置监听及对应死读分支。

没有删除仍在生产调用的 waitForRateLimit/peekRateLimit/RateLimitUnavailableError、ProjectMemberInvalidError；没有为清理枚举修改 schema CHECK，也没有恢复已退役的写入口。

## 本机运行恢复（S-1）

已停止原不匹配实例，将 .env.local 的数据库、知识根、心跳路径切到新目录，再初始化并启动现有 3000 端口的开发实例：

- 新目录：storage-native/runtime-f25b0a40/。
- schema：yanxing-native-p3，checksum=f25b0a40dbb64eade89c7c4bde332d3dd916635ad015e18ab63935ad28574f22。
- 原 storage-native/yanxing.sqlite 与旧文件保留；旧 SQLite 停服后和新实例启动后的 SHA-256 相同（81900f43371e3c7eed0f09849f04b2131be8f7eb09cda681650f13afc3c96619）。
- 使用 .env.native-admin 中原有本机凭据重新创建 admin；不迁移旧账号、课题、报告、任务或会话，需要重新登录。既有主密钥保留，不在本文展示。
- 未登录首页 307 到登录页，/login、/api/health、/api/branding 为 200；管理员登录、auth/me、项目列表、overview 均 200；联合 Web/Worker 心跳检查通过。

详见 [本机运行说明](local-native-runtime.md)。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| 全量隔离回归：YANXING_CHAT_COMPLETIONS_API_KEY='' node scripts/run-tests.mjs | 959/959 通过，0 失败、0 跳过 |
| 严格 TypeScript：source 配置 + noUnusedLocals/noUnusedParameters | 通过 |
| 根 tsconfig.json，构建后再次检查 | 通过 |
| git diff --check | 通过 |
| npm run build:runtime | 通过，生成 runtime 清单 1158 文件 |
| npm run build | Next.js 16.3.2 webpack 生产构建通过；使用临时隔离数据库/知识根 |
| 编译版 migrate.mjs 与 submission-index.mjs --database ... --storage-root ... --once | 临时新库通过，delivered/deferred/dismissed/claimed 均 0 |
| YANXING_NEXT_DIST_DIR=.next node test/helpers/native-browser-smoke.mjs --p5 | Chrome 验收通过，9 张主流程截图 + 10 张扩展截图，paidProviderCalls=0 |

浏览器验收使用生产 Web 产物、隔离的原生 Worker/数据库与合成账号，覆盖丢失确认响应后以相同身份重试、原文预览、冻结计划、历史/删除/回填、只读协作者、概览/报告库/洞察及移动端布局。截图与日志保留在 /tmp/yanxing-p5-browser-HqPLhr/。本机真实实例验证没有创建报告或模型任务。

当前 shell 未提供 pnpm 命令，因此验证使用现有 Node/TypeScript 二进制和 npm script；未安装新依赖。默认 worker/index.mjs 是常驻入口，--once 属于显式 submission-index.mjs 命令。

## 保留边界

未实施已判定为正常行为、误报或需要实际规模证据的扩建：阶段解冻、在线备份/恢复协调、额外 SSE 连接系统、healthcheck 自动强杀重启、抽样文件哈希或大规模缓存/分页重构。未运行完整 Docker 容器发布验收、未发布镜像/候选、未调用真实模型。保留原工作台视觉布局。

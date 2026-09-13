# Ponytail Audit：代码修改实施方案

> 状态：**已实施并验收**。逐项结果、验证证据和实际统计见[实施记录](ponytail-implementation-log.md)；不提交、不部署。下文基线表为方案编写时的历史记录，不代替本轮验收。
> 依据：[审计复核与合并清单](ponytail-audit-merged.md)。本文保留 M01—M23 编号，负责把确认项转换为文件级修改、实施顺序和验收门禁；不重新批准原报告中暂缓或否决的建议。

## 1. 目标、基线与硬约束

目标：在保持现有产品行为、安全边界和视觉交互质量的前提下，删除无效代码、收缩中间层、去掉确有等价替代的依赖。**不以删行数作为交付条件。**

本轮核验基线：

| 项目 | 结果 / 证明边界 |
|---|---|
| 仓库与 HEAD | `/home/zheye/VibeCoding/YanXing`，`ffe4e7a`；实施时应重新记录 |
| 开始时工作树 | `docs/ponytail-audit-merged.md` 已有用户未提交修改；以其当前内容为依据，不覆盖、不回退 |
| Node / 包管理约束 | 实际 Node `v24.20.0`；项目要求 `>=24.20.0 <25`、`pnpm@11.18.0`；本轮 PATH 未找到 pnpm，未安装依赖 |
| 本轮源码类型检查 | `node node_modules/typescript/bin/tsc --noEmit --incremental false -p tsconfig.source.json`，退出码 0 |
| 尚未执行 | 全量/定向测试、构建、数据库与 Docker 演练、浏览器截图及交互回归；不存在重构后的通过记录 |

实施规则：

1. 不改变 HTTP 契约、数据库 schema、租约/事务、权限、恢复机制、日志大小边界和进程归属判定。M16 只减少新 outbox 行中的内部冗余内容，不改列或历史行。
2. 前端允许等价重构 CSS/SVG/组件，但不改设计语言。布局、曲线、光晕、渐变、动画、响应式、焦点、反选、Escape/遮罩关闭和滚动行为均需保留。视觉验证不过，保留原实现。
3. 每次删符号前检查生产、测试、脚本、动态导入、再导出与框架入口；零静态引用不是独立 CLI 或部署能力可删的充分条件。
4. 不新增第三方依赖、不建通用请求/图表/维护框架。共用逻辑优先放原文件，只有实际跨文件复用才新增小型 helper/hook。
5. 每个风险项是独立可撤销补丁。先保护实际工作树，包括未跟踪文件；不使用 `git reset --hard`、`git clean` 或以 HEAD 覆盖用户修改。是否提交和发布另行授权。
6. 保留行为测试；只删除专门验证死路径的测试。涉及源码字符串断言时更新其指向，不以删除行为断言换取通过。

## 2. 批次与依赖

建议顺序为 **B0 → B1 → B2 → B3 → B4 → B5 → B6 → B7 → B8 → 总体验收**。这是合入顺序，不是要求把同批所有项目揉成一个补丁。

| 批次 | M 项 | 修改目标 | 风险 / 合入要求 | 原审计预计净删减 |
|---|---|---|---|---:|
| B0 | — | 记录源码、测试、构建与视觉基线 | 未取得对应基线，不实施高风险项 | — |
| B1 | M03、M04、M13、M14、M15、M19、M21、M22 | 清理旧声明、别名、包装与重复类型 | 低；逐项修改消费者 | 181 行 |
| B2 | M01 → M05 | 删除死解析缓存；收缩维护删除骨架 | M01 低、M05 高；分开验收 | 295 行 |
| B3 | M07 → M17 → M02 | 收缩单分析模块、事件、执行适配层 | 高；先锁定取消/ledger/发布行为 | 123 行 |
| B4 | M10、M16 | 标准库等待、outbox 内部载荷 | 中高；两个独立补丁，不混改 | 44 行 |
| B5 | M08 | 共用测试用容器角色扫描 | 高；真实容器隔离验收 | 35 行 |
| B6 | M12、M18、M09 | 空状态、组件桥接、请求守卫 | 中；视觉与异步交互验收 | 58 行 |
| B7 | M06 → M11 | 共用几何及相同 SVG 装饰 | 中；严格保持原渲染分支 | 60 行 |
| B8 | M20、M23 | 原生 SVG / 本地 CSS 替换两项依赖 | 中；先证明等价，再移除依赖 | 净行 0，少 2 个直接依赖 |

- **强关联**：M01 完成后 M05 仍保留历史 sidecar 清理；M02 删除 `AnalysisPreparedDocument`，不另做重复类型搬移；M13 不处理随 M01 删除的测试；M06/M11 共改总览文件，串行处理。
- **建议顺序而非技术依赖**：M07/M17 放在 M02 前，只为减少同一 pipeline 大改的审阅负担；M10 的 pipeline/worker 修改放在 B3 后。M08 与 B3 技术上可独立。
- `test/workspace-submission-ui.test.ts` 被 M04/M13/M18 共用；`package.json`、`pnpm-lock.yaml` 被 M20/M23 共用，避免并行编辑冲突。
- 原估算合计 **约净减 796 行、减少 2 个直接依赖**。新兼容代码及测试计入实际净值；锁文件、产物、文档不计。M22 为 0 行，M23 预计增加约 10 行；收益不成立时允许少删或不删。复核提示 M02 的端口迁移和 M10 的取消映射仍需替代代码，实际收益可能低于原估算；本轮未通过实施 diff 确认净值。

### 文件增删原则

- 预期删除：`modules/analysis/module.ts`、`components/dashboard.tsx`、`components/use-repository-entrance.ts`、`test/shared-abortable-task.test.ts`。均需先迁移消费者或确认测试只覆盖死路径。
- 可能新增的生产代码只限：`components/use-latest-request.ts`、`lib/sparkline-geometry.ts`；维护骨架和装饰组件优先留原文件。
- 测试共用扫描拟放 `scripts/proc-role-scan.mjs`；新回归优先扩展已有套件，仅几何/helper 无承接位置时增加对应的小测试文件。以上路径为方案建议，尚未创建。
- 依赖替换连带变更：`package.json`、`pnpm-lock.yaml`、`docs/third-party-licenses.md`。没有数据库迁移文件、部署拓扑或新配置项。

## 3. B0：实施前基线

1. 记录 HEAD、staged/unstaged diff、未跟踪文件和本批文件快照；保护现有审计文档。实施前重新搜索各项消费者，发现新消费者则缩小或暂停该项。
2. 在独立验证副本使用指定 Node/pnpm；不要复制 `.env`、业务 storage、数据库、密钥、运行日志或历史发布候选。构建与故障演练不能覆盖正在运行的应用产物或数据。
3. 运行第 12 节的严格类型检查、全量隔离测试、Next/Worker/CLI 构建，记录退出码与实际测试数量。失败基线单独记录，不宣称未来修改引起。
4. 对 B6—B8 的受影响页面取得同浏览器版本、DPR、视口、字体、数据、身份与 UI 状态的截图和关键交互记录；窄屏/宽屏、空/单点/长文本、加载/错误状态按第 11 节覆盖。
5. 本地 Next 为 16.3.2，修改页面边界时遵守仓库 AGENTS.md 与已安装 `node_modules/next/dist/docs/`，不得顺带把 Server Component 改为 Client Component。

## 4. B1：低风险静态清理

### M03：旧领域声明和死字段

- `modules/projects/domain.ts`：删除 `ProjectProgressStatus`、`ProjectStage`、`Milestone`、`Project`、`ProjectReportSummary`、`ProjectWithCapabilities`；保留 `ProjectMemberRole`。`test/frontend-ui.test.ts` 去掉旧类型导入和夹具注解，保留数据及“不编造协作者”断言；若推断不足，以现组件实际输入约束，而非重建旧领域模型。
- `modules/analysis/domain.ts`：只删 `AnalysisJob` 的 `requestedByUserId`、`availableAt`、`priority`、`admissionId`、`lastClaimedAt`、`lastRetryAt`、`lastRetryReason`、`lastWorkerId`、`lastErrorCode`、`lastErrorAt`、`terminalReason`、`terminalAt` 12 个死字段。不删活跃 `SubmissionTask` 的同名字段或调度语义。
- `modules/insights/domain.ts`：只删 `ReportInsight`，保留 `ReportInsightOutput` 与 section 类型；`modules/contracts/analysis.ts` 只删 `MAX_INSIGHT_REGENERATIONS` 及专属说明，保留当前任务操作次数限制。
- 验收：类型检查；`frontend-ui.test.ts`、`analysis-job-progress.test.ts`、`submission-task-repository.test.ts`。

### M04：收敛导入来源，不删除真实契约

| 当前中继 | 消费者改用 | 必须保留 |
|---|---|---|
| `modules/projects/stage-workflow.ts` 的常量、错误、验证器、类型再导出 | `modules/projects/stage-domain.ts`；`ReportSubmissionKind` 来自 `modules/reports/submission-domain.ts` | workflow 内部实际使用的导入、`planStageReportSubmission` 及其行为 |
| `modules/contracts/submission-workspace.ts` 的外来符号再导出 | `stage-project-contract.ts`、`contracts/report-submission.ts`、`reports/workspace-query.ts`、各类型实际定义文件 | 该文件自己定义的 workspace schema、API 路径与错误码；自身使用的类型 |
| `lib/workspace-submission.ts` 的相关中继、`getSubmissionDisplayLabels`、`formatStageLabel` | 真实契约；`submission-query.ts`、`workspace-query.ts` 的 `stageGroupLabel` | 其他仍服务 UI 的工具和真正被使用的 `WORKSPACE_API` 导出 |
| `beginSubmitCommit`、`ConfirmReceipt` | 测试直调 `reduceWorkspaceSubmit(phase, { type: 'commit_started', ... })`；无消费者别名直接删除 | `conflict + tokensReady=false` 不能进入 submitting；uncertain 重试继续保留原幂等键 |
| `lib/workspace-submission-client.ts` 的 `export { WORKSPACE_API }` | 无需替代 | 该文件自己仍使用的 WORKSPACE_API 导入 |

迁移范围包含 `lib/http/report-submission-handlers.ts`、`lib/workspace-submission-client.ts` 与所有受影响的生产/测试导入。消费者若混合导入真函数和再导出，拆分导入，不能整行删除。测试对 reducer 结果使用状态断言完成类型收窄，不用强制类型断言隐藏变化，也不重建生产中继。

验收：`stage-workflow.test.ts`、`submission-workspace-contracts.test.ts`、`workspace-submission-ui.test.ts`、`report-submission-handlers.test.ts`。原 UI 测试已有 tokensReady=false 的阻止提交断言，必须留下。

### 其余六项

| 项目 | 文件级修改 | 最小回归与保留边界 |
|---|---|---|
| M13 | `test/retryable-lazy.test.ts`、`test/workspace-submission-ui.test.ts` 删除两份 `deferred<T>()`；调用及 `ReturnType` 改指 `Promise.withResolvers<T>()` | 跑这两个测试文件；保留 resolve/reject、并发与乱序测试。只改 Node 测试，不把 API 引入浏览器生产代码 |
| M14 | `lib/auth/session.ts` 通过 type import 复用 `modules/users/domain.ts` 的 `SessionUser`、`ManagedUser`、`UserRole`、`UserStatus`；本地可用 `SessionUser as AuthUser`。更新外部纯类型消费者，不复制另一份对象定义 | `auth.test.ts`、`authorization.test.ts`、`user-management.test.ts`；不改登录、cookie、密码与鉴权逻辑，客户端不导入认证实现 |
| M15 | `lib/db/settings-repository.ts` 删除 `getAiModelRuntimeSnapshot` 和 `getAiPromptSettingsSnapshot`；`test/model-settings.test.ts` 改调 `getAiPromptSettingsSnapshotInDatabase(getDatabase())` | `getDatabase` 与 repository 均在设置测试环境后动态导入，不能提前绑定真实数据库；保留两个 InDatabase 活入口、`getAiModelRuntimeConfiguration`、`decryptChannelApiKey`。跑 `model-settings.test.ts`、`submission-admission.test.ts` |
| M19 | `scripts/p5-release-acceptance.mjs` 删除备份工具再导出块；`test/p5-release-acceptance.test.mjs` 拆分为从 acceptance 导入真函数、从 `scripts/p5-backup-restore.mjs` 导入备份函数 | 保留 acceptance 自身的 `runNativeBackupRestoreDrill` 导入与调用；跑 `p5-release-acceptance.test.mjs` |
| M21 | `lib/documents/report-storage.ts` 删除 `reportStorageRoot` 导入时快照；`test/fixtures/run-tests-probe.test.ts` 从 report-storage 动态导入并调已有 `getReportStorageRoot()`（保留现有再导出，不追加清理） | 跑 `run-tests.test.mjs`，由 runner 驱动 probe；保留数据库/知识/报告路径隔离及宿主文件哨兵断言 |
| M22 | `components/repository-loading.tsx` 用 `export type { OverviewLoadState as RepositoryDataState } from '@/lib/overview-loading'` 替换重复联合定义 | 现有消费者导入路径、渲染与状态合并逻辑不变；跑 `repository-loading.test.ts` |

## 5. B2：文档死链与存储维护

### M01：删除死缓存链，保留生产抽取

- 修改 `lib/documents/document-parser.ts`：删除 `SharedAbortableTaskEntry`、`createSharedAbortableTaskMap`、`pendingCachedDocumentExtractions`、`extractCachedDocumentText`、`readOrExtractCachedDocumentText`、`raceWithParserAbort`、`readExtractedTextCache`、`PROMPT_TEXT_OMISSION_MARK`、`fitTextToPrompt`，同步收缩失效 import。
- **修正审计区间的实施风险**：原 180—246 行中夹着仍被生产提取调用的 `throwIfParserAborted`（原 204—206 行），必须保留；按符号删除，不能整段剪掉。移除缓存后再核实 `randomUUID/readFile/rename/rm/writeFile` 等导入，`stat` 及活取消检查不删。
- 删除 `test/shared-abortable-task.test.ts`；在 `test/documents.test.ts` 中仅移除该缓存/裁剪旧入口的专属测试，保留真实文档提取、取消、字节上限、子进程与预算化提示词测试。
- 保留 `extractDocumentText`、`buildBudgetedDocumentPrompt` 和生产原文件抽取路径；已有 prepared document、PDF/DOCX worker、信号与安全校验不变。
- **不随 M01 批量删除磁盘上已有 sidecar，也不删其维护清理、备份或恢复兼容行为。**历史孤立 sidecar 仍按原维护规则回收。
- 验收：`documents.test.ts`、`parser-child-runtime.test.ts`、`prepared-report-files.test.ts`、`build-runtime.test.mjs`，并检查 Worker/CLI 构建仍能找到两个 parser worker。

### M05：共用两阶段骨架，而不是统一成无差别删除

修改 `lib/storage/maintenance.ts` 的 orphan 文件与 sidecar 清理区域；公共执行骨架留在本文件，不建立策略注册器、类层级或新的服务接口。

保留两类候选各自的识别/跳过逻辑，共用每类内部的“用传入快照初筛 → 在该类 unlink 批次前刷新保护路径/预留类型 → 复筛文件身份 → 删除/计数”骨架：

1. sidecar 以 `sourcePath` 对应的源文件作为保护键；源受保护或仍存在时两阶段均静默跳过，不增加 skippedProtected。普通文件同类保护命中仍计数。
2. 文件与 sidecar 各自的最新保护/预留信息刷新必须保留；不能提升到两类外部共用一次旧快照，也不改成每个候选重复全表查询。
3. 第一阶段：普通文件先做 report 类/安全路径排除，再 lstat、recent/size/inode、protected、reservation；sidecar 则在安全路径之后、lstat/recent 之前先检查源保护/存在。第二阶段保持保护/源存在 → reservation → 安全路径 → 文件身份/宽限顺序。保留既有无锁窗口的随机路径与最小宽限保证，不新增长事务。
4. 保留外层 dry-run、错误收集、ENOENT 容错、deleted 只在成功 unlink 后增加，以及两类计数汇总。
5. 若用统一 helper 需要大量 flag 或回调重建原分支，则保留两段循环，只抽实际相同部分；净减不足 45 行不是失败。

验收：`storage-maintenance.test.ts`。重点补齐或确认：源文件存在的 sidecar、源/sidecar 孤立组合、第一/第二次复查间新增引用或 reservation、替换 inode、宽限边界、dry-run、重复执行的幂等计数。清理演练只用临时目录，不指向真实 storage。

## 6. B3：分析流水线收缩

### M07：单模块不再保留可扩展接口

修改 `modules/analysis/module.ts`、`modules/analysis/modules.ts`、`modules/analysis/pipeline.ts` 及相应测试：

- pipeline 直接调用已有 `buildPageAnalysisTaskPrompt`，删除 `AnalysisModuleDefinition`、`moduleContext` 和 `buildPrompt` 投影，删空后移除 `module.ts`。
- `pageAnalysisModule` 只保留现有 `id`、`schema`、`schemaVersion`、`promptVersion`、`maxAttempts`；pipeline 自身版本常量不变；id 继续为 `'page_analysis'` 字面量，不扩大为任意 string。
- 保留冻结模型/提示词、评价上下文、重试 gateErrors 及 schema 校验。测试从检验包装层改为检验真实 prompt builder，内容断言不删。

### M17：事件只传实际消费的类型

`modules/analysis/ports.ts` 将 publisher 收窄为 `publish(type: AnalysisJobEventType): void`；同步 `modules/analysis/pipeline.ts` 的 `safePublish` 和所有调用、`worker/submission-executor.ts` 的洞察发布调用，以及 `worker/submission-pipeline-repository.ts` 的 publisher。

- 删除专供事件字段使用的 message/errors 等参数，不删除用于诊断、门禁错误、任务错误落库的真实数据。
- `tasks.recordProgress?.(claim, type)` 仍记录相同事件序列；publisher 与 safePublish 的租约/取消错误传播规则不变。`console.info` 的独立诊断保留。
- 不将此项扩大为删除 SSE 事件、任务进度或审计记录。

### M02：pipeline 直用 SubmissionTaskPort

修改 `modules/analysis/pipeline.ts`、`modules/analysis/ports.ts`、`worker/submission-pipeline-repository.ts`、`worker/submission-executor.ts`，按新端口调整测试替身。保留 claim-bound 的 `SubmissionTaskPort` 与底层 `SubmissionTaskStore`；只删 `createAnalysisExecutionRepository`、`toExecutionJob` 和失去消费者的执行接口/投影类型。

| 旧接口 / 适配语义 | 修改后落点 |
|---|---|
| `getJob(jobId)` | 状态/取消读 `port.getTask(jobId)`；调用预算另读 `port.getProviderCallLedger(jobId).completed`，不能用 attempts 代替 |
| `getPromptSettings` / `getJobEvaluationContext` / `getJobModelRuntime` | 从 `port.getFrozenSnapshots(jobId)` 获取 prompts/evaluationContext/modelRuntime；保留冻结值，不读实时设置 |
| `getLatestPartialSnapshotForJob` | `port.getLatestPartialSnapshot(jobId)` |
| 报告、prepared text、facts、artifact、module state、checkpoint 等 1:1 方法 | 直接调用 port 的现有同名方法，不新建转发层 |
| `updateJob` | `port.updateTask(jobId, { stage, stageIndex })`；原适配器没有转写 status/errorMessage，不借重构扩大更新范围。undefined 仍导致原租约失败行为 |
| `publishFinalSnapshot` 成功分支 | 仅在 `status==='completed' && publishAsCurrent` 时 `port.publishAnalysis({ snapshot, finalization })` |
| 非发布分支 | 先检查取消，取消仍抛原取消错误；否则 `port.failTask(jobId, 'QUALITY_GATE_FAILED')`，不发布失败快照为当前结果 |
| `isCancellationRequested` | 仍用绑定租约/任务身份的 port；取消后迟到结果核销不能改成普通 checkpoint |

显式将执行上下文的 `repository` 改为 `port: SubmissionTaskPort`；`recoverModelCalls` 改接收 ledger 的 completed 计数，不再依赖 `Pick<AnalysisJob, 'aiCallsCompleted'>`；`shouldSettleCancelledCall` 用原生任务状态/取消标志。删除 `AnalysisPreparedDocument`；使用已有 `SubmissionPreparedDocument`，不为即将删除的接口制造双向类型导入。`AnalysisFinalization`、`AnalysisSnapshotWrite`、`AnalysisCallCheckpoint` 等活契约保留。M03 之外的 `AnalysisJob` 收缩不擅自追加。

`Error('Analysis cancelled')` 是 executor 按 message 精确识别的取消哨兵，M02/M10 不得改名。端口内部的绑定 taskId/claim 校验、冻结 provider/model、openIntent、artifact 不可变与发布时 schema/质量复验原样保留。

定向套件：`submission-executor.test.ts`（含适配器直测，需改测 port/pipeline 实际行为）、`submission-task-repository.test.ts`、`submission-task-concurrency.test.ts`、`submission-worker-flow.test.ts`、`core-contracts.test.ts`。M07 的旧 buildPrompt 测试改为真实 builder 输入/输出对照；M17 验证分析及洞察两条事件调用。

**高风险验收门禁**：改动前先运行并补齐行为对照；不能仅把 fake 上的方法名改到编译通过。验证冻结配置、已有 ledger 预算、重试后计数、完成/质量失败分支、更新失败、取消前/调用中/响应后取消、迟到核销、租约丢失、旧 worker 不可发布、有效 checkpoint 恢复不重复调用 provider。

## 7. B4：标准库等待与 outbox

### M10：五处等待各自保留取消语义

目标文件：`lib/db/checkpoint-retry.ts`、`modules/analysis/pipeline.ts`、`lib/security/rate-limit.ts`、`lib/http/submission-task-events.ts`、`worker/submission-runtime.ts`。使用 `import { setTimeout as sleep } from 'node:timers/promises'`（局部已有 sleep 时另取名），保留每处已有函数名/边界和调用方策略，不建跨层 sleep 工具。

- 通用替换核心为 `await sleep(milliseconds, undefined, { signal })`；取消会 reject，因此不能机械替换。
- pipeline 的 `retryDelay` 保留指数退避、最大基数、Retry-After 与 jitter，AbortError 映射为 `Error('Analysis cancelled')`。
- `checkpoint-retry.ts` 的 `waitForCheckpointRetry`：保留退避计算，取消映射为 `Error('Analysis cancelled')`。
- `rate-limit.ts` 的局部 delay：取消映射为 `new DOMException('请求已取消。', 'AbortError')`，保留限流争抢/重试循环及中文错误文案。导入的标准库函数使用不同名字，避免与局部 delay 冲突。
- `submission-task-events.ts` 的 sleep 与 `submission-runtime.ts` 的 delay：取消原本正常 resolve；仅捕获可识别的定时器 AbortError 并正常返回，其他错误继续抛出。保留 SSE stop/连接清理，以及 worker `Promise.race` 完成后取消败出计时器的 finally，不能让取消变成循环失败。
- 保留预取消、等待中取消、无 signal、正常到期、`ms<=0` 的现有边界结果，以及 timer 是否维持事件循环的默认行为。
- 验收：`checkpoint-retry.test.ts`、`rate-limit.test.ts`、`core-contracts.test.ts`、`submission-executor.test.ts`、`job-events-stream.test.ts`、`report-submission-runtime.test.ts`；覆盖五个生产调用路径，而不只是测试 Node 自带 API。补充“SSE abort 不触发 onError”“worker 取消正常退出、race 无悬挂 timer”，以及“质量门禁失败与取消并发时不被记为普通质量失败”。

### M16：删内部冗余载荷，不删可靠投递

- `lib/db/report-submission-repository.ts`：新 outbox 行的 `payload_json` 写合法 JSON 字符串 `'{}'`，删除专为其组装的 workflow/events 冗余对象。
- `lib/db/report-submission-outbox.ts`：移除未消费的 payload 暴露、类型字段和 JSON.parse；任务调度依赖的 eventId/projectId/reportId 等标识保持不变。
- 不改 schema、不回写历史不可变 outbox 行，不删审计表、事件生成/记录、事务、租约、重试或自动任务准入；允许旧格式和新空对象行共同投递。
- `test/report-submission-repository.test.ts` 现有 payload.workflow 状态断言不能直接删除：改断言 `payload_json === '{}'`，并从实际 workflow/审计记录断言阶段状态，避免丢掉原业务覆盖。
- 验收：`report-submission-outbox.test.ts`、`report-submission-repository.test.ts`、`submission-worker-flow.test.ts`、`submission-admission-routes.test.ts`；新增/保留“新行确为 {}、旧行原文不变、双格式均可靠投递、失败后重试”的断言。

## 8. B5：M08 测试期 /proc 扫描去重

修改 `scripts/test-docker.sh` 与 `scripts/p5-package-container.mjs`，建议新增 `scripts/proc-role-scan.mjs` 承接共同扫描代码，由宿主测试脚本读入并在测试时注入容器执行。沿用容器内 `node --input-type=module -e` 注入方式，不新增 stdin/-i 要求，不在生产镜像增添测试入口。

- 共用 /proc 读取和角色识别，扫描结果由两端薄胶水消费：shell 保持 `YANXING_SMOKE_PROC_ROLE` / `YANXING_SMOKE_PROC_ACTION`、逐行 PID 和 kill/非零退出协议；p5 保持 `{ supervisor, web, worker }` JSON 输出。不增加 sed/正则转换 JSON 的第三套解析逻辑。
- 保留 shell 现有祖先检查、无 supervisor 时的既有分支、自身/PID<=1 排除及进程退出竞争处理；p5 当前只按 argv/进程标题列三类 PID，不能未经证明就叠加 shell 的祖先过滤。列表收集不触发 kill，kill 仍由原显式 action 控制。
- 不改 `scripts/docker-supervisor.mjs`、entrypoint 或 compose 部署结构，不以 net.connect 代替进程 socket 归属验证。
- 验收：`test-docker.test.mjs`、`p5-package-container.test.mjs`、`docker-supervisor.test.mjs`，以及真实隔离容器中的 web/worker 故障注入和整容器恢复；补充祖先/角色识别的最小测试，断言 helper 不进入最终 runtime manifest/镜像。Docker 不可用时该项保持未验收，不能用源码断言冒充。

## 9. B6：页面状态与桥接清理

### M12：空状态只返回被渲染的文案

`lib/insight-empty-state.ts` 只保留实际 UI 使用的 lead/description；删除从不渲染的 kicker/highlight/status/action 和无必要中转枚举。`components/insight-empty-state.tsx` 保留现有布局、文案、图标、按钮与分支；`test/insight-empty-state.test.ts` 改断言实际渲染信息，不能把真正的 UI 状态区别合并掉。

### M18：去桥接，不改 DOM 或页面边界

- `app/page.tsx` 直接导入 `components/workspace-app.tsx`，保留服务端入口函数，删除 `components/dashboard.tsx`；调整 `test/workspace-submission-ui.test.ts` 中源码指向断言。
- `components/knowledge-base.tsx`、`components/reports-repository.tsx` 直接导入并调用 `useWorkspaceEntrance`；调用参数和时机不变，删除 `components/use-repository-entrance.ts`。
- `components/workspace-navigation.tsx` 原使用处输出相同属性/className/children 的 `<aside>`，删除 `components/workspace-shell.tsx` 内 `WorkspaceSidebar` 和失效 import，不删其他 shell 组件。
- 验收：`workspace-submission-ui.test.ts`、`original-workspace-mount.test.ts`、`repository-loading.test.ts`；首页加载、水合、导航/选中态、入场动画、滚动位置和窄屏侧栏实际回归。

### M09：只抽“最新请求生效”守卫

拟新增 `components/use-latest-request.ts`。修改五个消费者：`components/admin/user-management-settings.tsx`、`components/knowledge-base.tsx`、`components/admin/model-settings.tsx`、`components/prompt-settings.tsx`、`components/notification-center.tsx`。

最小接口建议：`useLatestRequest()` 返回稳定的 `{ begin, invalidate }`；`begin(externalSignal?)` 返回本次 `{ signal, isCurrent, end }`。内部只持有当前 AbortController/请求代次；`isCurrent` 同时判代次及是否取消；`end` 幂等解除本次外部监听，并仅在 controller 身份仍匹配时清引用，不能把新请求的 controller 清掉。独立 invalidate 不自动发起请求；卸载 cleanup 失效当前请求。

如需 Node 单测，可在同一文件用一个实际供 hook 调用的小型守卫工厂承接这段逻辑，不再拆出类/适配器/缓存；React effect 生命周期仍须浏览器验证。

- 不把 fetch URL、返回数据、加载/错误 state、表单保存、通知轮询或重试策略搬入 hook；不返回统一 API envelope。
- 成功、catch、finally 更新状态前都使用本次守卫。即使底层忽略 abort、旧响应晚到，也不能覆盖新数据或关闭新请求 loading。
- user-management 保留 `fetchAllPages` 与每次 reload 的 loading；knowledge 额外保留 hasLoaded；model 的 applySavedSettings、prompt 的 save/restore 保留“只失效、不重拉”；prompt 的清 error 时机不变。Notification 保留 30 秒后台轮询与 showLoading 门控、外部 signal，以及 true=结果已应用的布尔返回值；`togglePanel` 仍仅在 loaded 成功后触发全部已读。
- 先迁移较简单消费者，再逐个迁移模型/提示词/通知，不五页同时“统一行为”。
- 验收：`settings-loading.test.ts`、`repository-loading.test.ts` 加真实页面交互；补一组可控 Promise 的乱序/取消用例，覆盖 A→B、旧 success/error/finally、预取消、卸载、失效但无新请求、保存与后台刷新竞争、外部 signal 和通知轮询。源码文本匹配不是异步行为验收。

## 10. B7—B8：渲染与依赖

### M06 + M11：共用几何与相同装饰，保留各图外观

- M06 修改 `components/overview-workspace.tsx`、`components/ui/repository-stats.tsx`，拟新增纯函数文件 `lib/sparkline-geometry.ts`。仅共用坐标、范围、点和直线路径基础计算，不引入统一 Sparkline React 组件。
- 几何 helper 只接收 points 与尺寸参数并返回 coords/直线/面积路径；原调用方保留这些不同分支：

| 图 | 尺寸 / pad | 少点与 hasData 语义 | 独有渲染 |
|---|---|---|---|
| MiniSparkline | 48×20 / 1.5 | 空→[0,0]、单点复制；some(value>0) | 无数据 dash 2 3、无面积/末点 |
| PanelTrendChart | 96×28 / 2 | 少点兜底；hasData=原 points.length>0 | 无数据 dash 3 3 |
| StatTrendSparkline | 96×28 / 2 | 原 points.length<2 直接返回 null | 保留原面积/末点，无新增虚线分支 |
| RepositorySparkline | 56×22 / 2 | 少点兜底；some(value>0) | 原 smoothLinePath 贝塞尔、平滑面积、r3.1/r1.7 双圆光晕 |

- 相同数值时 y=height/2、路径一位小数、线宽、title/aria、渐变和末点描边按原实现保留。仓库 smoothLinePath 留在原组件，只消费共享 coords，不能错误复用折线 areaPath。
- M11 在 `overview-workspace.tsx` 内只提取已核实重复的 `PanelDecoration reports ≡ StatCardDecoration versions`、两处 knowledge 图案及相同容器；quality/characters/success 独有图案、kind 映射、尺寸、className、层级均保留，不新建跨文件组件库。
- 为几何添加最小表驱动测试（可放 `test/sparkline-geometry.test.ts`）：0/1/2/多点、相同值、零值、升降序、各组尺寸；原图 markup/path 或 DOM 属性对照与截图并行验证，不只测新公式自己。

### M20：HeatmapRect → 原生 SVG

- 只替换 `components/research-visualization-card.tsx` 内 HeatmapRect 包装为同序嵌套 map；保留每格 rect/text/title、行列标签、配色、圆角、gap、内缩、居中、滚动与全屏逻辑。
- 已核实当前 @visx/heatmap 4.0.0 的 x/y gap 不对称：`x=xScale(ci)`，`y=yScale(ri)+gap`，`width=binWidth-gap`，`height=binHeight-gap`。gap=6，child 另内缩 2px。实施前再次核对锁定版本，按以下原式保留：

```text
cellX = labelWidth + ci * cellWidth
cellY = headerHeight + ri * rowHeight + 6
rect = (cellX + 2, cellY + 2, max(1, cellWidth - 10), max(1, rowHeight - 10))
textCenter = (cellX + (cellWidth - 6) / 2, cellY + (rowHeight - 6) / 2)
```

- 外层按 `data.rows`、内层按 `RESEARCH_METHODS` 顺序，缺格 `Number(cell?.value)||0`；保留原颜色 clamp、value>=55 的文字反色、0 值不画百分比文本，以及每格 title 与稳定 key。仅随包装删除专属 `heatmapData` useMemo、`HeatmapBin`/`HeatmapColumnDatum` 和 import，保留 heatmapColor/图例/标签裁剪。
- 在现有前端 SSR 套件通过组件实际输出断言普通模式首格 rect x=74/y=40/w=52/h=30/rx=6，以及 text 中心、title、反色、0 值无文字；不增加只为测试而暴露的生产包装。
- 同数据逐格比较替换前后的坐标、大小、标签、title、颜色与节点数量；覆盖 1×1、多行列、长标签、满分/零分、空数据和窄屏/全屏。
- 等价验证后删除 `@visx/heatmap` 直接依赖；保留 `@visx/hierarchy`、`@visx/wordcloud`。

### M23：tw-animate-css → 两处局部动画

- 修改 `app/globals.css`、`components/admin-settings.tsx`、`components/workspace-user-nav.tsx`；使用两个明确的局部 class，复用已有纯 fade 关键帧，仅补 fade+zoom95 所需 CSS；不要仿制整套 utility 动画库。
- 当前依赖源码默认 timing 为 **ease**、fill 为 **forwards**、delay=0、单次 normal。admin-settings 的是通知条：150ms、opacity 0→1，可复用 `yx-overview-fade`；用户菜单：100ms、opacity 0→1 + scale .95→1，保留 `origin-top-right`。通知条的 `-translate-x-1/2` 定位不变。实施前后核对 computed animation，不以名字相近的类替代。
- 检查普通模式和 prefers-reduced-motion；保留开关节奏与焦点行为，不借本项改现有无障碍策略。动画比较起始、中间、结束过程，不能只比较最终截图。
- 验证通过后删除 CSS 中依赖 import 和 `tw-animate-css` 直接依赖。

两项分别修改 `package.json`、由指定 pnpm 更新 `pnpm-lock.yaml`，同步 `docs/third-party-licenses.md` 当前直接依赖清单；不手改大段锁文件、不删除历史发布文档。确认不再有应用引用，并在干净验证副本执行 frozen-lockfile 安装及构建，避免旧 node_modules 掩盖漏引用。两项可分别保留或撤回，不能捆绑达成“−2 依赖”。

## 11. 前端视觉与交互验收矩阵

| 范围 | 必测状态 | 不退化的判定 |
|---|---|---|
| M06/M11 总览、仓库统计 | 宽/窄屏；无数据、1 点、2 点、多点、相同值、hasData=false | 坐标/曲线/光晕/虚线/填充/装饰、尺寸与排版保持；不能接受“看起来差不多” |
| M09 五页请求 | 首次加载、后台刷新、错误、连续切换、保存中、卸载、通知轮询 | 旧响应不写回；loading/error/disabled/表单与 toast、数据保留和刷新时机不变 |
| M12 洞察空状态 | 三类空状态及权限/任务状态的实际分支 | 实际可见文案、图标、布局和按钮不变 |
| M18 首页和侧栏 | 首次加载、水合、导航切换、入场动画、窄屏侧栏 | DOM 语义、选中态、滚动、焦点、键盘与服务端入口边界不变 |
| M20 热力图 | 空、1×1、多行列、长标题、极值；普通/全屏、宽/窄屏 | 每格坐标、gap、内缩、标签/title、色阶与滚动完全对应 |
| M23 设置通知条和用户菜单 | 打开/关闭、快速重复切换、键盘、减少动态效果 | 100/150ms、缓动、缩放、transform-origin、焦点还原与层级保持 |

固定测试样本、浏览器版本、DPR、视口、字体和身份；静态截图允许忽略的仅是可证明的环境渲染噪声，不允许通过扩大阈值隐藏布局/样式变化。动画另记录过程；测试结果应附前后图、关键 DOM/computed style 对比或录屏和操作结论。

既有 Node 测试中的静态 markup/源码/AST 断言可继续使用，但不能证明焦点、实际布局、动画或真实 effect 生命周期等价。现有 `test/helpers/native-browser-smoke.mjs` 支持裸 CDP 截图/点击/网络拦截，默认截图为 1440×1000，由 `pnpm run test:p5:browser` 启动生产测试环境，**不在默认 test 内**。它只保存截图，没有自动图像差异验收；需补上述状态、窄屏和人工前后对照。优先扩展此入口及 `test/helpers/p5-browser-checks.mjs`，不搭大型截图平台；没有浏览器证据的对应 M 项不能标为完成。

## 12. 执行命令与验收记录

以下是**实施时的命令**，不是本轮已完成结果。命令从仓库根执行，构建/依赖变更在独立验证副本进行；运行前确认 Node 版本以及指定 pnpm 可用。

```sh
# 不产生增量文件的严格源码检查
node node_modules/typescript/bin/tsc --noEmit --incremental false \
  -p tsconfig.source.json --noUnusedLocals --noUnusedParameters

# 定向测试示例：使用现有隔离启动器，不直接在真实数据环境跑 tsx --test
node scripts/run-tests.mjs test/storage-maintenance.test.ts
node scripts/run-tests.mjs test/core-contracts.test.ts test/submission-worker-flow.test.ts
node scripts/run-tests.mjs test/workspace-submission-ui.test.ts test/frontend-ui.test.ts

# 每批按其表格选择定向套件，所有批次后跑全量
node scripts/run-tests.mjs

# 在隔离验证副本构建；runtime 构建会重建自己的输出目录
pnpm run build
pnpm run build:runtime

# 依赖变更后的干净副本验证
pnpm install --frozen-lockfile
pnpm run check

# 检查补丁空白与实际改动范围
git diff --check
git diff --stat
```

- `run-tests.mjs` 会创建临时 workspace，并隔离数据库、知识库、报告存储与临时路径；可直接传 `test/*.test.ts` / `.mjs` 的具体文件，不绕过该机制。
- `pnpm run check` 只含 lint/test/Next build，**不含** runtime 构建、容器故障演练及视觉回归；这些仍是额外门禁。
- 测试、浏览器 smoke 或容器入口若有 skip/不可用，应记录为未验收，不能算通过。禁止对真实环境执行 kill、恢复备份或清理演练。
- 每项记录：M 编号、改动文件、运行命令/退出码/测试数量、保留行为的证据、视觉/容器附件（适用时）、实际净删增、是否保留依赖、未覆盖风险和回退方式。

### 完成与回退条件

1. 23 项逐项标记“已实施并验收 / 保留原实现 / 暂未实施”，没有静默跳过。
2. 严格编译、受影响行为测试、全量测试及 Next/Worker/CLI 构建通过；高风险项附存储并发、任务取消/租约/ledger 或容器真实演练证据；前端附视觉交互证据。
3. schema、外部 API、部署契约与历史发布产物不变；文档和实际依赖清单同步。
4. 发现任何语义/视觉退化，仅撤回当前 M 项的本轮补丁，恢复该项前的实际工作树快照；保留用户修改与已通过的其他项。涉及依赖时成组恢复组件/CSS、manifest 与 lockfile。
5. 不做数据库逆迁移：本方案没有 schema 迁移；M16 新写的合法空对象应在回退代码下仍可读取。
6. 验收结束再按实际 diff 更新审计状态/收益，不把原报告 796 行或本方案建议写成已兑现结果。

## 13. 明确不纳入本次实施

以下保持原审计裁决，不能在执行中顺手做：

- MultiSelect → CustomSelect：保留选中后菜单不关闭及再次点击可清空；没有等价交互证据不替换。
- 七套 argv 整体替换、原生 dialog、URL 状态改路由 API、174 exports 批量去导出。
- 删除 `test-production.mjs`、supervisor 改 compose 双服务、删除运行期日志轮转、net.connect 替代 socket 进程归属。
- HTTP 小文件、milestone-presets、freeze 类型的纯搬移；不将搬家计算为删除。
- 删除 `decryptChannelApiKey`、改历史 outbox/schema、删除侧车历史清理、减少质量门禁或取消/租约/安全校验。

**建议的第一步**：获准实施后先完成 B0，再执行 B1；B2 的 M05、B3 的 M02、B5 的 M08 和全部前端变更均须过各自门禁，不一次性提交 23 项混合大改。

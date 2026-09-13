# Ponytail Audit：复核与合并清单

## 审查边界与计数口径

- 对照当前工作树，复核用户新增的 33 条建议，并与上一轮 12 条清单去重。只审查过度工程和复杂度，不实施代码修改。
- 本轮仅维护审查报告；业务代码、测试和部署配置均未改动。
- 净删减是扣除替代代码后的保守估算，计入确属死路径的专属测试，不计锁文件、第三方源码、构建产物和本报告。搬移函数或类型不能把原文件全部行数算作删除。
- “合并”表示静态调用关系及保留现有行为的简化方向已核实，不表示重构已实施或回归已完成。无法证明等价、涉及产品契约变更或收益未经证实的项目不计入净值。
- 安全、租约/事务、数据恢复、进程归属、日志上限、现有 UI 与交互行为必须保留；不能用更弱的机制换取删行数。

## 前端实施硬约束：视觉与交互质量不退化

- 用户要求的是“不劣化现有外观与交互质量”，不是禁止修改 CSS、SVG 或组件实现。允许等价重构，但本轮不是视觉改版，不擅自改变现有设计语言或交互语义。
- 布局、间距、排版、配色、边框、阴影、层级、图表细节、文字可读性、响应式适配及各状态的视觉完整度必须保留；不得为删代码移除渐变、光晕、曲线、装饰或动画效果。
- 鼠标与键盘操作、焦点顺序及还原、Escape/遮罩关闭、选择与反选、滚动位置、加载/错误/禁用反馈、动画节奏与流畅度不得退化；既有无障碍和减少动态效果行为也必须保留。
- 实施前记录受影响页面的基线：固定浏览器、视口、数据与 UI 状态进行截图，并记录关键交互。实施后在同样条件下比较，包括相关窄屏/宽屏、空数据、单点图表、长文本及加载/错误状态；动画另验证过程，不只看结束帧。
- M06/M11/M20/M23 等样式与渲染重构，以及 M09/M18 等可能影响状态或 DOM 行为的重构，必须通过对应视觉和交互回归；类型检查和“功能能用”不能替代这一验收。
- “确认清单”只确认简化方向，不预先批准视觉差异。无法证明符合以上约束的项目不实施；验证出现退化则撤销该项改动或保留原实现，不以“差不多”作为通过标准。
- 视觉与交互质量优先于减行数和依赖数。允许增加必要的兼容代码、保留依赖、少删甚至不删；随实际结果下调净收益估算，不能为了达成 −796 行/−2 依赖而降低质量。
- 本次需求澄清不等于授权立即实施重构；当前仍仅更新报告，尚无重构后的视觉验证结果。

## 验证记录

- 使用文件读取及全仓符号搜索，覆盖应用、组件、库、领域模块、worker、脚本及测试消费者。
- 当前基线类型检查通过：`node node_modules/typescript/bin/tsc --noEmit --incremental false -p tsconfig.source.json`，退出码 0；未生成增量构建文件。
- `pnpm` 不在当前 PATH，首次启动命令退出码 127；随后直接使用已安装的 TypeScript 编译器完成检查，未安装依赖。
- 未运行部署、数据库或浏览器回归；未实施任何拟议重构，因此基线类型检查不能证明未来重构后的行为等价。

## 新增 33 条建议的逐项判定

编号严格对应用户新增清单的原顺序；M 编号对应下面的去重清单。

| # | 原建议 | 判定 | 复核结论 / 必须保留的边界 | 合并去向 | 证据位置 |
|---|---|---|---|---|---|
| 1 | AnalysisExecutionRepository / 适配器 −130 | 修正后合并 | 接口实际为 21 个方法；getJob 的 ledger 投影、publishFinalSnapshot 的质量失败/取消分支、updateJob 的投影均不是 1:1 转发。pipeline 可直接使用 SubmissionTaskPort，但这些语义必须显式保留。适配层取 −71，连同 #17 保守合计 −75；不是 −130。 | M02 | modules/analysis/ports.ts:65–87；worker/submission-pipeline-repository.ts:181–215,317–336 |
| 2 | 删除 test-production.mjs −126 | 不采纳 | 零引用和 126 行均属实，但它是独立 CLI：隔离工作区后串起 migrate、create-user、next start、worker、smoke、verify 和 healthcheck。现有 Docker 冒烟及零散脚本不能等价替代裸机端到端生产冒烟；无 npm script 不等于死代码。 | 不计 | scripts/test-production.mjs:9,107–117 |
| 3 | 七个 argv 解析器 → util.parseArgs −110 | 暂缓整体替换 | 标准库方向有候选价值，但不批准这一批量删减：现有重复参数拒绝、--key=value、缺值、未知参数、错误输出及 help 短路行为并不一致。现场验证：原 worker 对 --help --unknown 提前返回帮助，parseArgs 却报错；--once 重复原先拒绝而原生覆盖；--database=x 原先拒绝而原生接受。3 处较简单解析器可另做保留语义的试改，但尚未证实包装后的净减；备份 CLI 和 create-user 更不能直接替换。 | 不计 | worker/submission-index.ts:10–28；scripts/native-backup.ts:57–119；scripts/create-user.ts:11–35；scripts/p5-package.mjs:27–56；scripts/p5-package-container.mjs:89–113 |
| 4 | multi-select → CustomSelect searchable −410 | 暂缓，需交互确认 | 当前文件实际为 415 行，唯一调用者确实只保留一个 ownerId；但现组件选择后保持菜单打开、再次点击可清空，CustomSelect 选择后关闭且不能反选。按 AGENTS.md，不能把这两项交互变化视为无问题替换。本次质量要求不授权改变这两项行为；须先补齐并验证等价能力，再重新估算是否纳入。 | 不计 | components/ui/multi-select.tsx；components/ui/select.tsx:286–295；components/workspace-project-edit-dialog.tsx:124 |
| 5 | 删除 174 个 export | 暂缓，数量未确认 | 未提供逐符号清单；本轮静态扫描未复现 174/64/110 的口径，且存在命名空间与动态导入。文件内使用、外部导入、专属测试和再导出必须逐名区分；不能批准批量去 export。已核实的具体桥接在下方单独计数。 | 不计 | lib/storage/；lib/db/；modules/reports/；modules/contracts/ |
| 6 | supervisor → compose 双服务 −600 | 不采纳 | 与已发布的单容器及 docker run --init 契约冲突。当前还保证任一子进程退出时整容器重启、联合健康检查、迁移门禁和共享心跳。拆服务属于部署方案变更，不是等价清理，不能用删掉监督职责计算 −600。 | 不计 | scripts/docker-supervisor.mjs；scripts/docker-entrypoint.sh:12–16；docs/releases/v0.1.2.md:5,11–20,64 |
| 7 | 旧 Project/Milestone 等六类声明 −30 | 合并，修正估算 | 当前 domain.ts 共 44 行；仅 ProjectMemberRole 仍有生产消费者。其余旧类型只互相引用或被 frontend-ui 测试夹具注解引用，可删除注解并保留夹具行为；保守计 −43。新阶段领域及评价上下文 milestone 不在删除范围内。 | M03 | modules/projects/domain.ts:1–44；test/frontend-ui.test.ts:14,36 |
| 8 | 五套请求守卫 → useAbortableFetch −125 | 修正后合并 | 只抽取 request-sequence/AbortController/过期结果判定的重复守卫，fetch 体及各页加载、错误、轮询策略保留。必须保留外部 signal、主动失效和布尔返回语义。扣除约 35–45 行共用 hook，保守净减 −30，而不是把 fetch 体也删掉的 −125。 | M09 | components/admin/user-management-settings.tsx:31–63；components/knowledge-base.tsx:81–112；components/admin/model-settings.tsx:39–73,94–95；components/prompt-settings.tsx:60–83,116–122；components/notification-center.tsx:49–87,110–120 |
| 9 | 四个 sparkline → 一个组件 −70 | 修正后合并 | 只共用几何计算，不统一图形外观。RepositorySparkline 使用贝塞尔曲线和双圆光晕，其余使用直线；少于两点、hasData、虚线、尺寸均有差异。四处几何共用保守计 −40；替换旧清单“三折线 −45”，不是再加 −70。装饰 SVG 的 −20 另计。 | M06、M11 | components/overview-workspace.tsx:144–249,316–346；components/ui/repository-stats.tsx:65–138 |
| 10 | 原生 dialog.showModal −70 | 暂缓 | useDialogFocus 除 Dialog 外还服务洞察和图表的原地全屏展开，不能整体删除。原生模态框的 top-layer、backdrop、对齐、全高面板及层级顺序尚未证明与现有交互等价；仅迁 Dialog 也不能按整套 hook 的 −70 计数。 | 不计 | components/use-dialog-focus.ts:1–76；components/ui/dialog.tsx；components/insight-workspace.tsx:54；components/research-visualization-card.tsx:49 |
| 11 | URL 状态 → next/navigation −65 | 不采纳 | workspace-url.ts 的解析、归一化、参数保留规则是有测试的应用逻辑，换路由库仍需保留。同步 history 状态更新与 router.replace 导航也不等价，导航代次、滚动和渲染边界需要独立迁移验证，不能直接删 −65。 | 不计 | lib/workspace-url.ts:1–73；components/workspace-app.tsx:175–179,322–357；test/workspace-url.test.ts |
| 12 | 删除日志轮转看门狗 −70 | 不采纳 | 这是裸机服务运行期间唯一的轮转机制。服务持有日志 fd 时使用 copytruncate；启动期 rename 轮转不能代替它。删除会失去运行期日志大小边界；转交外部 logrotate 是职责迁移而非免费删除。 | 不计 | scripts/app-manager.mjs:26–65,167–202,265–275 |
| 13 | socket-inode 归属 → net.connect −66 | 不采纳 | 两者回答不同问题：现代码确认“受管 PID 子树拥有这个监听 socket”，net.connect 只能确认“端口有人监听”。自家进程不监听而外部进程占端口时，替代方案会误判实例健康/启动成功。 | 不计 | scripts/app-manager.mjs:130,156,509–582 |
| 14 | 两份 /proc 角色扫描去重 −60 | 修正后合并 | 可共用测试期注入的扫描代码，不需要将测试辅助代码放进生产镜像。保留 supervisor 祖先检查、防误杀、role/action 输入、三类 PID 输出、自身与 PID≤1 排除；扣除共用实现和两端胶水，取保守 −35。 | M08 | scripts/test-docker.sh:24–106,207–222；scripts/p5-package-container.mjs:350–378 |
| 15 | AnalysisEventPublisher 富载荷 −35 | 修正后合并 | 生产确实只将 event.type 交给 recordProgress，独立诊断日志不依赖这些字段。可收窄载荷，但大部分调用原本就在一行内，删字段只减少字符；按物理行净减约 −13，不能计 −35。 | M17 | modules/analysis/ports.ts:89–98；worker/submission-pipeline-repository.ts:168–176；modules/analysis/pipeline.ts:245–252 |
| 16 | AnalysisModuleDefinition 单实现 −40 | 与旧项去重合并 | 仅删接口约 −9；旧清单范围更完整：pipeline 直调 buildPageAnalysisTaskPrompt，删除 moduleContext、buildPrompt 投影和整个 module.ts，pageAnalysisModule 仅留 metadata 常量并保持 id 字面量类型。该完整范围源码约 −42，计入测试调用调整后继续保守取旧值 −35，只计一次。 | M07 | modules/analysis/module.ts；modules/analysis/modules.ts:4–19；modules/analysis/pipeline.ts:11,80,89 |
| 17 | AnalysisPreparedDocument 重复 −5 | 与适配层合并 | 独立合并需增加 type import，净约 −4；执行 #1 后唯一消费者位于被删接口内，直接删除定义即可，不必制造双向 type-only import。已在 M02 统一计入保守 −4。 | M02 | modules/analysis/ports.ts:57–61,73；modules/reports/submission-task-ports.ts:37–41 |
| 18 | 四个工作台别名/包装 −24 | 修正后合并 | ConfirmReceipt 无消费者；其余仅作为测试中继。测试改调用原始 getSubmissionDisplayLabels、stageGroupLabel 和 reduceWorkspaceSubmit，保留令牌不足时不能进入 submitting 的行为断言；扣除调整后约 −17。 | M04 | lib/workspace-submission.ts:1,65,269–271,472–480,506 |
| 19 | ReportInsight / snapshot / decrypt −31 | 部分合并，否决 decrypt 删除 | ReportInsight 与 getAiModelRuntimeSnapshot 已在旧清单，仅去重保留。decryptChannelApiKey 不是死代码：settings-repository.ts:573 的 getAiModelRuntimeConfiguration 仍调用它，model-router.ts:23 的非冻结路径仍使用该入口；不能随 snapshot 包装删除。 | M03、M15；decrypt 不计 | modules/insights/domain.ts:6–18；lib/db/settings-repository.ts:541–547,562–573,603–613；lib/ai/model-router.ts:23 |
| 20 | client 再导出 WORKSPACE_API −1 | 合并 | 只有 client 的再导出无消费者；保留 contracts/工作台模块中实际被导入的原定义与导出。 | M04 | lib/workspace-submission-client.ts:19 |
| 21 | reportStorageRoot 快照 −1 | 合并 | 仅 runner probe 测试使用；删除导入时快照，probe 改用已有 getReportStorageRoot()，不动存储路径解析和隔离机制。 | M21 | lib/documents/report-storage.ts:18；test/fixtures/run-tests-probe.test.ts:12,18 |
| 22 | AuthUser/SessionUser 等重复 −30 | 修正后合并 | 两组字段相同。共用 modules/users/domain 的类型，服务端用 type import/别名，并调整原消费者；扣除必要导入，保守约 −15，不能把两份都删除却不保留一份定义。 | M14 | lib/auth/session.ts:17–34；modules/users/domain.ts:1–17 |
| 23 | OverviewLoadState/RepositoryDataState −1 | 修正后合并，净行 0 | 联合类型确实相同。保留 lib/overview-loading.ts 的定义，repository-loading.tsx 改为 type 再导出别名即可共享定义而不增加混合 value/type 消费者的导入行。这里是去重复定义，不再声称净删 1 行。 | M22 | lib/overview-loading.ts:1；components/repository-loading.tsx:1 |
| 24 | getAiPromptSettingsSnapshot 包装 −3 | 与旧项去重合并 | 仅测试消费；测试走 getAiPromptSettingsSnapshotInDatabase(getDatabase())。旧清单设置包装的 −14 已含这 3 行，不再累加。 | M15 | lib/db/settings-repository.ts:302–304；test/model-settings.test.ts:17,172 |
| 25 | 三个 HTTP 小文件合并 −16 | 可选组织整理，不计收益 | 16 行就是三个文件的总长度；函数都实际被调用，移动到其他模块仍需保留日志、408/413 响应和时间戳校验。没有指定承接模块及扣除新增代码的方案，不能把搬家当作 −16。 | 不计 | lib/http/public-error.ts；lib/http/json-body-response.ts；lib/http/optimistic-lock.ts |
| 26 | milestone-presets 并入 overview-trends −5 | 可选组织整理，不计收益 | dateWeeksFromNow 的 5 行逻辑仍需存在；直接合并仅省少量 import/空行，不是删除日期运算。保留本地日期/DST 语义，不能用毫秒加法偷换。 | 不计 | modules/projects/milestone-presets.ts:1–7；lib/overview-trends.ts |
| 27 | freeze.ts 并入 runtime-options −16 | 可选组织整理，不计收益 | AiChannel、ModelProfile 与推理强度类型均有消费者，移入 runtime-options 后定义仍需存在。可移除同义别名/少量导入，但 −16 是毛文件长度，不是净减少。 | 不计 | lib/ai/model/freeze.ts:1–16；lib/ai/runtime-options.ts |
| 28 | dashboard 跳板 −5 | 合并，限定最小范围 | page.tsx 保持现有服务端入口函数，只将 import 直接指向 workspace-app，删 dashboard.tsx 5 行并更新源码断言。不附带把 page 改为 client/re-export 的边界变更。 | M18 | components/dashboard.tsx:1–5；app/page.tsx:1；test/workspace-submission-ui.test.ts:547–549 |
| 29 | use-repository-entrance 别名 −3 | 合并 | 两处调用直接导入 useWorkspaceEntrance，保持 hook 调用和参数不变，删除纯再导出文件。 | M18 | components/use-repository-entrance.ts:1–3；components/knowledge-base.tsx；components/reports-repository.tsx |
| 30 | WorkspaceSidebar → aside −4 | 合并 | 唯一使用处直接保留原属性、className、children 输出为 aside；删除零样式透传函数及无用导入。 | M18 | components/workspace-shell.tsx:12–14；components/workspace-navigation.tsx:186,308 |
| 31 | p5-release 再导出桥 −16 | 修正后合并 | 16 行是毛桥接块；测试需拆分导入，从 p5-backup-restore 取实际定义，同时保留从 acceptance 模块导入的其他真函数。扣除新导入行，保守 −11。既有 docs 中的 B5 计划不是已实施变更，也不另算一份。 | M19 | scripts/p5-release-acceptance.mjs:31–48；test/p5-release-acceptance.test.mjs:12–30 |
| 32 | HeatmapRect 保留依赖再删 −24 | 采用旧方案，互斥去重 | children 仍承担 rect/text/title 绘制，保留依赖不能把整个 24 行块删掉。采用旧清单的原生 SVG 嵌套 map 替代，完整保留 gap、内缩、标签、标题和配色，净约 −10 且移除 1 个直接依赖；两方案不得相加。 | M20 | components/research-visualization-card.tsx:766–824；package.json:39 |
| 33 | tw-animate-css 两处用途 −0/−1依赖 | 修正后合并，增加少量 CSS | 不是死依赖：两处 fade/fade+zoom 仍在用。复用已有 fade 关键帧并补齐 95% 缩放的等价 CSS，保留 100/150ms 时长与缓动；删除依赖接入。为保守计数，预留 12 行 CSS、扣除 2 行接入，记净增加 10 行、减少 1 个依赖；不宣称零代码成本。 | M23 | app/globals.css:2,1680–1683；components/admin-settings.tsx:144；components/workspace-user-nav.tsx:85；package.json:50 |

## 去重后的确认清单（按预计净删减排序）

M01. **delete:** 删除无生产调用的文档 sidecar 缓存链、共享取消包装、fitTextToPrompt 及其专属测试（G9）。无需新增替代；生产继续使用 extractDocumentText/buildBudgetedDocumentPrompt，遗留 sidecar 的维护清理仍保留。 **约 −250 行**。[`lib/documents/document-parser.ts:19–80,180–246,446–465；test/shared-abortable-task.test.ts；test/documents.test.ts:208,334`]

M02. **yagni:** 移除 AnalysisExecutionRepository 中间接口与适配器，让 pipeline 直接接收 SubmissionTaskPort（G12）。保留并迁移 ledger 计数读取、质量失败/取消分支、状态更新语义；随后直接删除失去唯一消费者的 AnalysisPreparedDocument，不新增循环 type import。 **约 −75 行**。[`modules/analysis/ports.ts:57–87；worker/submission-pipeline-repository.ts:181–215,317–336；worker/submission-executor.ts:69`]

M03. **delete:** 删除旧 Project/Milestone 等六类声明、AnalysisJob 的 12 个死字段、无人引用的 ReportInsight 和 MAX_INSIGHT_REGENERATIONS（G9）。保留 ProjectMemberRole、新阶段模型、ReportInsightOutput 和当前任务操作次数限制；旧夹具去掉过时类型注解。 **约 −71 行**。[`modules/projects/domain.ts；modules/analysis/domain.ts:18–29；modules/insights/domain.ts:6–18；modules/contracts/analysis.ts:34–35`]

M04. **delete:** 删除领域/工作台的多余再导出和测试中继（G12/F4）。调用方直达 stage-domain、stage-project-contract、stageGroupLabel、getSubmissionDisplayLabels、reduceWorkspaceSubmit 等实际定义；保留令牌不足时不能提交的断言及真正的 WORKSPACE_API 导出。 **约 −54 行**。[`modules/projects/stage-workflow.ts:27–46；modules/contracts/submission-workspace.ts:17–37；lib/workspace-submission.ts:1,65,269–271,472–480,506；lib/workspace-submission-client.ts:19`]

M05. **shrink:** 共用孤立文件/sidecar 删除的两阶段骨架（G5）。保留 sourcePath 保护键、源存在时静默跳过、两次最新保护/预留信息读取、原计数优先级、宽限、inode 校验和 dry-run，不能简单拼成无差别删除循环。 **约 −45 行**。[`lib/storage/maintenance.ts:516–656`]

M06. **shrink:** 四个 sparkline 共用坐标、范围与路径基础计算（G5）。保留仓库图的 smoothLinePath/双圆光晕，以及各图少于两点、hasData、虚线和尺寸分支；不建立改变外观的统一组件。 **约 −40 行**。[`components/overview-workspace.tsx:144–249,316–346；components/ui/repository-stats.tsx:65–138`]

M07. **yagni:** 删除单模块接口、未消费的 moduleContext 字段和 buildPrompt 投影层（G12）。pipeline 直接调用 buildPageAnalysisTaskPrompt；pageAnalysisModule 只保留 id/schema/版本/重试常量，并保持 id 的字面量类型。 **约 −35 行**。[`modules/analysis/module.ts；modules/analysis/modules.ts:4–19；modules/analysis/pipeline.ts:11,80,89`]

M08. **shrink:** 共用两套测试用 /proc 角色扫描（G5）。以测试期注入的共用代码替代重复脚本，保留 supervisor 祖先约束、防误杀、role/action 及 PID 列表协议，不把测试辅助代码打进生产镜像。 **约 −35 行**。[`scripts/test-docker.sh:24–106；scripts/p5-package-container.mjs:350–378`]

M09. **shrink:** 五处页面请求共用“最新请求生效”的取消/代次守卫（G5）。仅抽守卫 hook，fetch 与 UI 状态策略留在原页；外部 signal、主动失效、加载开关和返回值行为保持不变。 **约 −30 行**。[`components/admin/user-management-settings.tsx:31–63；components/knowledge-base.tsx:81–112；components/admin/model-settings.tsx:39–73；components/prompt-settings.tsx:60–83；components/notification-center.tsx:49–87`]

M10. **stdlib:** 五处手写可取消等待改用 node:timers/promises.setTimeout(ms, undefined, { signal })（G12）。取消时抛出的错误须映射回原语义；原本正常结束的等待仍须正常结束。 **约 −30 行**。[`lib/db/checkpoint-retry.ts:26；modules/analysis/pipeline.ts:419；lib/security/rate-limit.ts:159；lib/http/submission-task-events.ts:66；worker/submission-runtime.ts:155`]

M11. **shrink:** 去重总览面板与统计卡片中的相同装饰 SVG 和共同容器（G5）。同一图案只保留一份，kind 映射保留独有图案、尺寸和样式。 **约 −20 行**。[`components/overview-workspace.tsx:82–116,275–314`]

M12. **delete:** 删除三组洞察空状态中从未渲染的 kicker/highlight/status/action 及无必要的中转枚举（G9）。直接返回 UI 使用的 lead/description，更新仅验证死字段的测试。 **约 −16 行**。[`lib/insight-empty-state.ts:1–38；components/insight-empty-state.tsx:25–31`]

M13. **stdlib:** 两份 deferred<T>() 改为 Promise.withResolvers<T>()（G12）。不重复计入 M01 已整体删除的 shared-abortable-task 测试。 **约 −15 行**。[`test/retryable-lazy.test.ts:5–13；test/workspace-submission-ui.test.ts:1029–1034`]

M14. **shrink:** 用户身份、角色、状态及管理用户对象只保留一套类型定义（G5）。共用 modules/users/domain，服务端按需 type import/别名，客户端不引入认证实现。 **约 −15 行**。[`lib/auth/session.ts:17–34；modules/users/domain.ts:1–17`]

M15. **delete:** 删除 getAiModelRuntimeSnapshot 死入口和仅供测试使用的 getAiPromptSettingsSnapshot 包装（F4）。复用 InDatabase 入口；decryptChannelApiKey 仍有其他调用，明确保留。 **约 −14 行**。[`lib/db/settings-repository.ts:302–304,603–613；test/model-settings.test.ts:17,172`]

M16. **delete:** 删除 outbox 无消费者的 workflow/events payload 构造、暴露和反序列化（G9）。新事件的 payload_json 写合法空对象字符串 {}，不改历史不可变行或 schema；保留调度标识、审计表、租约和可靠投递。 **约 −14 行**。[`lib/db/report-submission-repository.ts:318–332；lib/db/report-submission-outbox.ts:10,88–91`]

M17. **yagni:** AnalysisEventPublisher 只接收实际被使用的事件 type（G12）。删除不落库也不被消费的 jobId/stage/moduleId/message/errors 载荷，独立 console.info 诊断仍保留；其余单行载荷删字段只算字符，不重复计行数。 **约 −13 行**。[`modules/analysis/ports.ts:89–98；worker/submission-pipeline-repository.ts:168–176；modules/analysis/pipeline.ts:245–252`]

M18. **yagni:** 删除 dashboard 跳板、use-repository-entrance 别名及 WorkspaceSidebar 零样式透传（G12）。分别直引 workspace-app、useWorkspaceEntrance 和原样输出 aside；保留 page.tsx 的服务端入口函数。 **约 −12 行**。[`components/dashboard.tsx；components/use-repository-entrance.ts；components/workspace-shell.tsx:12–14；app/page.tsx:1`]

M19. **delete:** 删除 p5-release 的备份工具再导出桥（G12）。测试从 p5-backup-restore.mjs 导入定义，acceptance 的真函数及其自身 runNativeBackupRestoreDrill 导入仍保留。 **约 −11 行**。[`scripts/p5-release-acceptance.mjs:31–48；test/p5-release-acceptance.test.mjs:12–30`]

M20. **native:** 用原生 SVG 嵌套 map 替换仅计算规则网格的 HeatmapRect（G12）。完整保留 rect/text/title、gap/内缩/居中/配色，移除 @visx/heatmap；保留 hierarchy 和 wordcloud。 **约 −10 行，−1 依赖**。[`components/research-visualization-card.tsx:766–824；package.json:39`]

M21. **delete:** 删除仅测试读取的 reportStorageRoot 导入时快照（G9）。probe 改调已有 getReportStorageRoot()，不改变存储路径解析或隔离。 **约 −1 行**。[`lib/documents/report-storage.ts:18；test/fixtures/run-tests-probe.test.ts:12,18`]

M22. **shrink:** 加载状态只保留一份联合类型定义（G5）。repository-loading.tsx 以 type 再导出引用 OverviewLoadState，保持现有消费者的导入；减少重复定义但不宣称减少物理行。 **净行 0**。[`lib/overview-loading.ts:1；components/repository-loading.tsx:1`]

M23. **native:** 用少量本地 CSS 替代 tw-animate-css 的两个真实用途（G12）。复用既有 fade 关键帧并补齐 fade+zoom95，保持时长/缓动；预留 12 行 CSS，扣除 2 行依赖接入，保守记净增加 10 行，换取减少 1 个依赖。 **约 +10 行，−1 依赖**。[`app/globals.css:2,1680–1683；components/admin-settings.tsx:144；components/workspace-user-nav.tsx:85；package.json:50`]

## 去重与暂缓规则

- 本轮确认清单共 23 项；M22 是零行数的类型去重，M23 是增加少量 CSS 换掉依赖。后续实施时以实际 diff 和回归结果修正估算。
- 原清单“总览三折线 + 装饰”约 −65，改为四处共用几何 M06 −40 加装饰 M11 −20，合计 −60；不再叠加新增建议的 −70。原清单其他保守项保留。
- 模块定义/上下文的完整收缩 M07 只计一次；单删接口的 −9 与完整范围的 −35/−42 不相加。
- AnalysisPreparedDocument 随适配层 M02 删除，不另加 −5，也不新建无消费者的 type import；AnalysisFinalization、AnalysisSnapshotWrite、SubmissionPreparedDocument 等活契约继续保留。
- ReportInsight、两个 settings 包装、getAiPromptSettingsSnapshot 均已落在 M03/M15；新增同名条目不再加算。decryptChannelApiKey 明确保留。
- WORKSPACE_API 只删 client 的无用再导出；真正的契约导出保留。p5-release 的旧计划 B5 只是同一发现的历史记录，不是另一份删减收益。
- Heatmap 只采用 M20 的原生 SVG 方案；与“保留依赖删子节点”的建议互斥。总共只计算两个直接依赖，不推测传递依赖还能删多少。
- 暂缓 MultiSelect 的约 410 行；选中后是否关闭和反选行为不得擅自改变。仅在有经验证的等价替代、符合前端质量硬约束并重新估算后才考虑纳入，它不在本次总量内。
- argv 统一、原生 Dialog、路由迁移、supervisor 拆服务、移除轮转和 TCP 探活替换、174 exports 批量收缩、小文件搬移均未计入。不能把未知行为变化、职责转移或仅移动代码计成安全删减。
- M05 落地时必须保留存储维护的计数、遗留文件保护和两阶段复查测试；M02/M07/M17 必须保留任务取消、质量门禁和 provider ledger 的行为测试；M06/M09/M11/M12/M18/M20/M23 需要对应 UI/异步行为回归，并满足前端质量硬约束。

net: -796 lines, -2 deps possible.

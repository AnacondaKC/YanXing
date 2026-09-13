# 简化审查修改与完善方案

> 状态：**D0、A1—A7、B1—B4，以及 C 中“分析/洞察原文件抽取回退”单项已实施**。该 C 单项完成后严格编译、971/971 测试及隔离 Next/Worker/CLI 构建通过；B5 与其余 C 项未实施。未提交或部署，浏览器/容器验收未执行。原批次结果见[审查报告 §11](simplification-review.md#11-本次实施记录d0ab1b4)，本次单项结果见[§12](simplification-review.md#12-分析洞察原文件抽取回退单项实施)。
> 依据：[原审查报告](simplification-review.md)及本会话两轮独立复核。本文是执行计划，不替代[工程设计](project-stage-report-engineering-design.md)中的业务与安全决策。

## 1. 目标与范围

目标是移除已经失去消费者的代码、旧模型表示和多余执行模式，同时修正审查报告的证据与复现方法；不以删除行数为验收目标。

复核结论：原报告第 4 节的 **7 项删除全部成立：4 项上一轮已发现，3 项上一轮遗漏，0 项误报**。三个遗漏是 reportFileContentType、INITIAL_AI_SETTINGS_VERSION、comparisonFor。“已发现”不等于“已修复”。

建议后续按 **D0 文档修正 → A 七项删除 → B 已确证完善 → 集成验证** 推进。每次只处理一个所有权边界；遇到新消费者、行为差异或失败基线，暂停当前批次，不扩大删除范围。

- A 为优先项；B1—B4 为建议追加项，B5 为低收益可选项。
- C 为暂缓/需确认项，不自动纳入后续实现；仅“分析/洞察原文件抽取回退”已获单项授权并完成，其他条目不变。
- 不顺带修改视觉布局、导航、权限、持久化格式或公开 HTTP 响应。
- 不新增依赖、不建立通用重构框架、不批量删除 export 关键字。
- 不修改历史发布快照以制造“旧产物已匹配新源码”的假象。

## 2. 已有证据与实施前基线

方案生成前核验：

| 项目 | 已知结果 | 证明边界 |
|---|---|---|
| 当前 HEAD | dcf6f23194c2a9d547c82928ce22aa59713eac83 | 未提交审查的起点 |
| v0.1.2 对应提交 | 6660fda531ba8cc68fb3ad98a9a2c1ad51786ace | 原报告的历史比较基准，与 HEAD 不同 |
| 未提交路径 | 355（git status --porcelain=v1 -uall；不含本方案新增文件） | 路径清单，不是生产文件数；不能与折叠目录的 status 行数直接比较 |
| 当前树严格 TypeScript / 全量隔离测试 | 上一轮通过；963/963 | 剪切前基线，不证明剪切后仍正确 |
| 七项同时虚拟删除后的编译 | 编译器内存覆盖 7 文件，严格检查 0 diagnostics、exit 0 | 未写源码；包含 bound 状态和 comparisonFor 两个导入的删除；未运行剪切后的完整测试 |
| git diff --check | 方案生成前通过 | 只证明当时 diff 的空白规范 |
| 原报告自述的隔离副本 963/963 | 作为历史记录保留 | 本次未重新取得其剪切后运行结果 |

真正实施前重新采集上述基线，不能把当前记录直接复制为新的验收结果。

### 工作树与恢复保护

1. 记录 HEAD、staged/unstaged diff 及完整未跟踪清单。
2. 使用 mktemp -d 创建唯一私有目录，按本批文件白名单保存**实际工作树内容**，包括未跟踪文件；记录文件原本是否存在及哈希。仅 git diff 无法备份未跟踪实现。
3. 不将 .env、业务 storage、主密钥、现有发布候选和日志复制进验证副本；隔离副本需包含测试/构建依赖的源码及配置。
4. 改动前再次比对快照。发现用户或运行进程更新同一文件时先核对，不覆盖新工作。
5. 不使用 git reset --hard、git clean 或从 HEAD 整文件恢复现有未提交实现。后续是否 commit/push 仍需用户授权。

## 3. D0：完善原审查报告

修改对象：[docs/simplification-review.md](simplification-review.md)。保留原审查经过和自身错误记录，在相应段落添加/更新复核裁决，避免形成两份相互矛盾的当前结论。

| 原报告位置 | 修改要求 | 验收标准 |
|---|---|---|
| 第 0、4 节 | 明确七项均成立，标注“4 重合、3 上一轮遗漏”；加入精确消费者与保留边界 | 不把遗漏写成误报，不把建议写成已应用 |
| 第 1.1、3 节 | 将“重命名且 tsc 通过是无外部消费者的充分条件”改为“在当前编译范围内未发现静态引用断裂”；另列运行时、脚本、框架约定及外部消费者核验 | 不再以 tsc 单独证明全仓不可达；private 包也不意味着不存在框架或运行时契约 |
| 第 4、5 节 | 补充 getAiPromptConfiguration 删除后的同文件死调用链；区分历史副本结果、本次虚拟编译和未来实际改动结果 | 每层验证注明来源、状态和范围；最终删除量从实际 diff 重新计算，不承诺固定 -44 行 |
| 第 6 节 | 不以“方法名零重名”证明行为不重复；缺乏消费者/行为对照的结论标为未充分核验 | 方法名称统计只保留为线索，不作为关闭候选的证据 |
| 第 6.1、附录 | 保留 R15 不作为缺陷的结论，纠正“两个谓词在任何可达状态都不分歧” | 加入 TTL 过期窗口及正确的维护顺序解释，见下文 |
| 第 7、10 节 | 将“未分提交所以技术阻塞”改为“保护未提交工作、按边界实施和记录差量”；提交本身仍需授权 | 能区分权限决定、工作组织与真正技术阻塞 |
| 第 9 节 | 删除用 git show HEAD 恢复未跟踪文件的命令，改用唯一临时快照；示例失败立即停止 | workspace-query.ts 不存在于 HEAD 时不会被重定向截断；不复用或清空固定 /tmp/yx-verify |
| 第 8、10 节 | 将 out/ 历史产物清理与源码删除分离，记录保留/清理决定 | 不篡改已封存验收身份，不把生成物残留误报为源码消费者 |

R15 建议替换表述：

> 知识预留 TTL 到期但尚未释放时，state='active' 与 state='active' AND expires_at>t 可以不同。这不是已发现的配额计数缺陷：已核查的正常生命周期中，该窗口的计数路径保留 active 预留；maintenance 则在同一事务、同一时间戳下先释放过期的非上传预留，再重建计数，报告上传预留使用持久化到期哨兵。正确证据是相关生命周期的账本与计数一致，而不是两个谓词普遍等价。未来新增写入点应重新验证该不变量。

“生产 storage_reservations 仅两个 INSERT 点”可保留，注明核验范围和时点；11 条历史 fuzz 样本不能被描述为穷尽所有状态。

## 4. A：落实七项已确认删除

以下均为高置信、低风险的小边界；表中测试是定向验证，不能代替最后的集成门禁。七项不必合成一个混合提交。

| 编号 / 所有权 | 修改与连带收尾 | 明确保留 | 最小验证（test/ 下） |
|---|---|---|---|
| A1 上传 UI | components/ui/file-dropzone.tsx 删除 reportFileContentType | FileDropzone、REPORT_FILE_ACCEPT、isAllowedReportFile、大小校验、键盘可访问性；现有上传使用 file.type | report-upload-field.test.ts |
| A2 初始化 | lib/db/initial-ai-settings.ts 删除 INITIAL_AI_SETTINGS_VERSION；其原消费者 migrations/index.ts 已退役 | seedInitialAiSettings、原生 schema 身份/校验、现有设置不被覆盖的规则 | model-token-defaults.test.ts、native-bootstrap.test.ts |
| A3 提示词设置 | lib/db/settings-repository.ts 删除 getAiPromptConfiguration，并删除仅由它调用的 getAiPromptConfigurationInDatabase；复查失去用途的导入 | getAiPromptSettingsSnapshotInDatabase、getPublicAiPromptSettingsInDatabase 等活入口；getDefaultAiPromptConfig 若仍在其他路径使用必须保留 | model-settings.test.ts、submission-admission.test.ts |
| A4 上传存储 | lib/documents/report-storage.ts 删除 parseContentLengthHeader | 新处理器/服务的长度校验、流式大小上限、文档真实性检查、取消和写入 fencing | documents.test.ts、report-submission-handlers.test.ts |
| A5 HTTP runtime | lib/reports/server-runtime.ts 删除 bindSubmissionServerRuntimeForTests、bound 声明和 if(bound) 分支 | host 惰性单例、create/get runtime、runSubmissionRoute、native-schema 503 映射 | submission-workspace-routes.test.ts、jobs-cancel-route.test.ts |
| A6 旧报告类型 | modules/reports/domain.ts 删除 ReportHistoryEntry；后续旧模型整体收尾见 B1 | 此步保留仍有消费者的 ReportSource，不仅因文件变短就删整个文件 | 严格类型检查、workspace-reports.test.ts、report-insight.test.ts |
| A7 查询中继 | modules/reports/workspace-query.ts 删除 comparisonFor，移除该文件中的 resolveSubmissionComparison、ComparisonSubmission 两个失效导入 | SubmissionComparison 类型；modules/reports/submission-query.ts 的真实比较实现及仓储调用 | report-submission-query.test.ts、report-history-replacement.test.ts、submission-workspace-contracts.test.ts |

每项完成后：检查精确符号及其导入来源，区分真正消费者、负向测试和历史文档；不能为了得到零搜索命中而删除历史证据。

## 5. B：已确证的进一步完善

### B1. 旧报告模型及测试收尾

- 在 A6 基础上，从 modules/reports/domain.ts 删除 ReportVersion、ReportParseStatus、ReportDeliveryType，保留 ReportSource。
- 从 lib/workspace-reports.ts 删除 selectActiveReportAfterDeletion；保留 parseHiddenProjectIds、toggleHiddenProjectId。
- components/report-history-view.tsx 的 reportHistoryStatus 收紧为当前报告卡片契约，删除 parseStatus/latestJobStatus/hasCompletedFullAnalysis 旧输入分支。按 capabilities 与实际评分维持当前展示结果，不借此重新设计状态标签。
- test/workspace-reports.test.ts 删除专属于死选择器的夹具/用例，保留隐藏课题及登录行为测试；light-theme、report-insight 使用当前契约夹具。
- 若旧选择器测试表达的用户行为仍有效，应确认其由当前 workspace-report-deletion 等测试承接，不能仅删除断言。
- **验收**：workspace-reports、light-theme、report-insight、workspace-submission-ui、workspace-report-deletion 测试通过；只有洞察不代表分析完成，隐藏课题与报告选择行为不变。
- **净效果**：退役旧模型表示和测试负担，无公开 API 或数据库格式变更。仅 typecheck 通过不足以证明 UI 行为保持。

### B2. 测试启动器单一执行模式

- scripts/run-tests.mjs 删除 testFileGroups、恒空 preloadModules 机制、多组循环及退出码聚合。
- 只解析一次参数、启动一个子进程；继续转发用户的 Node/test 参数，不把自有 preload 删除误做成禁止原生命令行参数。
- 保留空测试集的安全行为、隔离目录、环境隔离、退出码/信号语义、监听器释放，以及“等待子进程退出后清理”。
- **验收**：test/run-tests.test.mjs 现有三类测试通过；补空文件集、文件选择/参数转发和启动失败清理的缺失场景，不重复已有断言。
- **净效果**：移除多组运行这个已无实际配置的模式，而非重写进程管理。

### B3. 比较值只保留查询来源

- modules/analysis/pipeline.ts 删除 previousOverall 注入参数、buildAiScore 的对应参数/字段；modules/contracts/analysis.ts 收窄 AiScore。
- 保留读时 resolveSubmissionComparison、评分为 0 的合法性、缺失比较不伪造 0 的规则。
- 不删除“旧 previousOverall 不得影响展示”的负向测试；夹具可经变量或最小局部扩展类型携带多余字段，不用 any 绕过契约。
- **验收**：submission-executor 中快照不含 previousOverall 的断言不弱化；workspace-submission-ui 的旧字段忽略、零分/零差值、无基准场景通过。
- **净效果**：去掉把动态比较冻结进分析快照的无主入口；不迁移数据库、不改写既有快照。

### B4. 原生任务解密入口收窄

- lib/db/settings-repository.ts 保留显式主密钥缺失检查，使用已有 decryptSecretWithSecret(encrypted, Buffer.from(configuredSecret, 'utf8'))。
- lib/db/settings-crypto.ts 删除仅由原生路径调用的 decryptSecretFromDatabase、getSecretBytesForDatabase、readMainDatabaseFilePath，清理只为这条链存在的参数、类型和常量。
- **不得删除**共享设置仍在使用的 getSecretBytes/readLocalKeyBytes/decryptSecret 路径；不得改 scrypt、AES-GCM、v2 格式、缺钥 503 或错钥诊断。
- **验收**：缺钥失败、错钥失败、有效密钥成功，Web/Worker 使用相同主密钥；model-settings、submission-admission(-routes)、submission-worker-flow、native-backup 定向通过。
- **风险**：证据明确，但涉及密钥入口，必须独立成批；先建立保留语义的失败用例，再删除不可达回退。仅编译通过不算完成。

### B5. 低收益可选收尾

仅在相应模块本来就被整理时实施，不为这些项目新建抽象或拆更多文件：

| 项目 | 切除/替代 | 保留与验证 |
|---|---|---|
| 前端测试中继 | lib/workspace-submission.ts 的 beginSubmitCommit、formatStageLabel：测试直接验证 reducer 的 commit_started 事件与 stageGroupLabel | 保留无新令牌不能提交、uncertain 必须沿用幂等身份的断言；保留运行时代际隔离 |
| 死类型/再导出 | ConfirmReceipt、无消费者的 getSubmissionDisplayLabels 再导出、workspace-submission-client 的 WORKSPACE_API 再导出 | 保留真实定义与活消费者，精确核对 import 来源 |
| 设置旧入口 | getAiModelRuntimeSnapshot；可选清理仅测试使用的 getAiPromptSettingsSnapshot 包装 | 保留准入使用的 InDatabase 实现和冻结副本语义；测试改用活入口 |
| 备份验收中继 | scripts/p5-release-acceptance.mjs 的 p5-backup-restore 再导出桥；测试直接导入实现模块 | 不删除备份 CLI 黑盒验收本身；p5-release-acceptance.test.mjs 通过 |
| 存储根快照 | reportStorageRoot 常量及无人使用的再导出；run-tests-probe 改用 runtime-roots 的 getter | 不改变实际根解析规则；run-tests.test.mjs 继续验证数据路径隔离 |

## 6. C：暂缓项与不可删除项

| 项目 | 当前决定 | 解除条件 / 必须保留 |
|---|---|---|
| WorkspaceReportDetail.job 别名 | 暂不删除，属于已输出的 HTTP 字段 | 确认库外消费者及 API 变更许可；任务响应自身的 job 主字段不在此候选内 |
| 分析/洞察原文件抽取回退 | 已按单项授权实施，不并入 B3 | 删除分析侧恒被禁用的原文件抽取分支及开关；洞察测试迁为正文输入后删除 file 入口。保留分析的 repository.getDocumentText 准备正文兜底、documentText 可选与 needsModelCall 分支；accepted-artifact 恢复不读正文/不发模型。恢复、缺失正文及真实 DOCX Worker 定向 58/58、全量 971/971 通过；详见审查报告 §12 |
| BEGIN IMMEDIATE 包装统一 | 暂缓，不能直接复用 client.inImmediateTransaction | client 的 BEGIN 在 try 内，仓储的在 try 外；补嵌套事务、BEGIN 失败及外层事务存续测试。改 client 回滚语义应另列行为修复，不混入无行为变化清理 |
| R14 三处回收护栏去重 | 可选、低优先、单独评估 | 同时覆盖 report-upload-recovery 的 claim/requireLease、submission-storage-audit 的候选查询及相关测试；保留二进制区间、防删除正式文件语义；不为省数行增加通用查询框架 |
| R15 配额计数 | 不立代码修复项，仅 D0 更正文案 | 未发现正常生产生命周期中的计数缺陷；未来新增预留/到期时间写入点后重验不变量 |
| 阶段行映射器、跨运行时恢复标记格式 | 暂缓 | 先证明共享后的依赖与运行时成本更低；不能只因形似就合并 |
| out/、.runtime、.next-p5-qa 历史产物 | 不自动清理、不覆盖 | 区分可重建缓存与保留供审阅的候选证据，确认清理路径；新版本应生成新产物并记录身份 |

明确保留：跨 await 的权限重验、事务内确认复检、Store/Port 租约边界、claim/lease/fencing/cancel、SSE 撤权检查、备份 HMAC/写栅栏/恢复中断标记、路径防护、数据库约束、退役写接口拒绝和 CLI 墓碑。工作区文件长不是拆分理由，业务模型调整不是视觉改版授权。

## 7. 验证与验收

### 7.1 每批必做

1. 基线可区分：确认定向测试在剪切前通过；失败时记录，不能把原有失败当作改动证据。
2. 残留检查：定义、调用、导出、同文件依赖及注册/动态消费逐项分类；若删除后留下新死调用链，继续在同一边界收尾。
3. 定向测试：按 A/B 对应条目运行，保留能证伪错误删除的边界断言。
4. 严格编译、diff 审查；不接受无关样式、依赖、schema 或配置变更。

本机若没有 pnpm，可直接调用已安装的 Node 工具，不必安装或升级依赖：

```bash
node node_modules/typescript/bin/tsc --noEmit --incremental false -p tsconfig.source.json --noUnusedLocals --noUnusedParameters

# 示例：A7 的定向测试，其他批次替换为对应文件
YANXING_CHAT_COMPLETIONS_API_KEY='' node scripts/run-tests.mjs test/report-submission-query.test.ts test/report-history-replacement.test.ts test/submission-workspace-contracts.test.ts

git diff --check
```

测试必须经仓库 runner 进入隔离临时目录；不把单测命令替换成对真实业务库的操作。

### 7.2 集成验证，逐层单独记录

| 层次 | 命令/方法 | 通过条件 |
|---|---|---|
| 类型与 lint | 上述严格编译命令；pnpm 可用时对应 pnpm lint | 0 diagnostics |
| 全量测试 | YANXING_CHAT_COMPLETIONS_API_KEY='' node scripts/run-tests.mjs | 无失败；删除专属于死功能的用例后数量可变化，必须说明减少的用例及存活行为的承接，不硬凑 963 |
| 生产构建 | 在隔离源码副本运行 node node_modules/next/dist/bin/next build --webpack（对应 pnpm build） | 新构建成功，不覆盖运行实例的 .next，不带入私密 .env 或业务根 |
| Worker/CLI 构建 | 在同一副本运行 node scripts/build-runtime.mjs | 受影响的 Worker/CLI 入口可编译；不以历史 .runtime 成功代替当前结果 |
| 运行产物/容器 | 如要声称部署可用，在隔离副本且 pnpm 可用时按 package.json 的 build:docker 流程重新装配；随后执行选定的隔离 P5 容器/发布验收 | 同版本 Web/Worker/CLI 一致，使用新数据根、受控模型和自有容器；不复用现有卷，不发布镜像、不部署正式实例 |
| UI 行为 | B1 或其他展示相关改动后，复用现有隔离浏览器脚本检查历史状态、DOCX、删除后选择及键盘操作 | 既有布局/交互不变；说明哪些脚本使用 mocked API，不冒充真实全链路 |

构建可能写入 next-env.d.ts、AGENTS.md 等受管理文件，均在隔离副本核对，不把这些副作用带回真实工作树。未执行的层明确标为未验证；类型或单测通过不等于生产/浏览器/容器验收完成。

### 7.3 每批完成记录

在原审查报告的实施记录中简要追加：范围与批次、剪切前基线、实际变更文件、退役的概念/状态、保留契约、准确命令与结果、未验证层、剩余不确定项及回退快照位置。不要另建重复的全仓审查报告。

## 8. 回退与完成标准

- 测试失败时先区分基线失败和本批引入的问题；不得删除失败测试或弱化安全断言来让简化通过。
- 仅撤销本批差量。工作树未再变时，可从批次前快照恢复相应文件；若有后续用户改动，先对比并反向应用本批片段，不能整文件覆盖。
- 原本未跟踪的文件也是待保留工作，不从 HEAD 恢复；不删除整个源码目录、storage 或历史验收目录。
- 本方案不含数据迁移、密钥轮换、产物发布或部署，源代码回退无需数据库恢复。实施中若出现此类副作用，停止并另定方案。

完成条件：D0 的结论/证据/命令自洽；本轮明确选择的 A/B 批次没有遗留无主调用链；活接口、安全保护和 UI 契约保持；每项有可证伪检查；每个验证层如实报告；未提交的原有工作完整保留；C 项不会被悄悄实施。

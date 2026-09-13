# YanXing v0.1.2 之后变更：全面修改方案

> 状态：M01–M14已实施；严格检查、全量回归、隔离候选、真实Web/Worker、Chrome、容器和同路径备份恢复验收通过。
> 本轮修改业务代码、fresh native schema、测试和文档；未访问或迁移任何真实运行数据。

## 1. 目标、基线与实施原则

### 1.1 范围

基线为 origin/main v0.1.2 / 6660fda531ba8cc68fb3ad98a9a2c1ad51786ace，审查时 HEAD 为 dcf6f23194c2a9d547c82928ce22aa59713eac83。包括领先提交及全部暂存、未暂存和未跟踪实现，不能只取 HEAD 的代码。

审查记录为145个已跟踪变更路径、179个未跟踪文件；实施开始时重新生成清单。本方案新增的文档不属于上述原始审查计数。

来源：上轮 review.md 的 R1–R11、风险 P-A–P-F，以及 supplemental-review.md 的 S1–S5、低优先级项和误报纠偏。下面重新编为工作包 M01–M14，避免不同报告的 H1/M1 等编号冲突。

### 1.2 必须保持的安全和产品契约

1. 不迁移 v0.1.2 旧库；旧库、混合库、身份不符库继续拒绝。不得删 marker、修改库中 checksum、自动初始化空文件来绕过保护。
2. 活跃用户全局可读；报告写入限实际负责人/admin；editor 保留配置/计划编辑权，不扩大报告写权限。
3. 正式确认仍原子提交报告、阶段、配额、回执和自动分析意图；保留 actor/project/key/digest、版本令牌和上传 fence。
4. 自动分析意图保证建立一次尝试，不保证无限付费重试；已有手动失败/取消尝试可以满足该意图。
5. 保留lease token、generation、取消和发布fencing；已经开始但尚未写入完成检查点的模型调用不自动重放。
6. 正式/墓碑报告文件、正文、成功成果和审计历史不自动物理删除；不能用提前释放配额掩盖清理失败。
7. 备份仍停写、保留数据库/文件一致性 fence、明确且匹配的密钥、同绝对路径恢复、目标不存在及中断标记。
8. 保持现有布局、导航、视觉样式和交互结构。仅修复必要状态提示、重试入口与加载行为；不重做工作台，不恢复旧写 API。
9. 不引入新的 ORM、全局缓存框架、通用状态管理库、通用事件总线或另一套任务队列。
10. 不提供历史数据库兼容或迁移。为简化当前fresh native模型，直接修改业务表、约束、必需索引和NATIVE_SCHEMA_CHECKSUM；旧native checksum继续fail-closed，不通过运行时DDL或放宽身份校验兼容。

### 1.3 本轮不应变成修复任务的误报

不为“新旧处理器双完成”“generation 无锁竞争”“claim/renew 不看取消”“released 配额二次消费”“SSE 终态必然占满20连接”写所谓补丁；这些指控已排除。

不恢复 editor 报告写权，不给 outbox 任意设置丢弃次数，不删除已公布 GET 路由，不把 projects.status 再同步成第二套权威状态，不因报告日期格式器使用浏览器时区就修改整个应用时区。

## 2. 推荐决策与待确认项

| 决策 | 推荐方案 | 未确认时处理 |
|---|---|---|
| 通知可靠性 | 沿用当前 confirm 路径的“尽力通知”，失败不撤销业务；业务审计仍可靠且不可变 | 采用该最小方案；如果要求必达，再另立持久通知投递方案 |
| 分页响应 | 报告列表保留正式契约 reports，课题列表保留 projects；去掉额外 items | 不把所有客户端改成 items；对额外字段移除写发布说明 |
| 数据库结构 | 用户已确认无需历史兼容；直接收敛fresh native表/约束/必需索引 | 删除projects.status，提交后清空upload重复正文，将source_key索引纳入核心schema并更新checksum；旧库拒绝而非迁移 |
| 分析/洞察成功次数 | 用户已确认每种操作分别总成功3次（初次成功+最多2次重新生成） | 保持共享上限3；失败/取消不计额度，活动任务复用 |
| 真正 unknown 的提交 | 保留原 key/command，通过原上传状态及同键重放恢复 | 不允许以关闭弹窗、切课题或网络超时自动换键重提 |
| 旧测试实现 | 先删除完全孤立簇；有测试依赖的旧栈分批归档或删除 | 先保留且明确隔离，不能以降低测试数替代原生覆盖 |
| 大文件重复哈希 | 首批保留完整性保证，单独量化成本 | 不默认上 size/mtime 缓存，不删 HEAD/Range 哈希门禁 |

分析和洞察次数已经用户明确确认：每种操作分别总成功3次。通知仍为best-effort；不提供跨版本数据库/API兼容，当前schema变化以全新运行目录部署。

## 3. 工作包总表及依赖

| 包 | 覆盖问题 | 工作内容 | 依赖/优先级 |
|---|---|---|---|
| M01 | R11，含备用 Worker | 统一显式数据库写入口安全边界 | 第一批，发布阻断项 |
| M02 | R10、环境说明 | 修复备份 CLI 环境加载 | 可与M01并行 |
| M03 | S1、替换弹窗导航边界 | 可恢复提交失败与真正未知结果分离 | 第一批；和M04统一前端状态 |
| M04 | R3 | 同报告读取排序、写操作失效和任务/成果防倒退 | M03可并行设计，同文件顺序实现 |
| M05 | R4、S2、D2 | 终态/删除刷新、可见错误及不可达回执UI | 依赖M04；列表优化后做集成压测 |
| M06 | R1、R2、P-B、P-C | 轻量DTO、批量列表、查询与详情解耦 | 第一批后立即推进，性能主线 |
| M07 | S4 | 概览聚合与GET限流 | 聚合可先做；卡片复用依赖M06 |
| M08 | R5、R9 | 通知错误隔离、重放去重、all参数修复 | 独立小修；仓储文件与M06/M07串行合并 |
| M09 | R6、R7 | 完整维护接线、回收前缀查询优化 | 依赖M01，复用现有存储安全机制 |
| M10 | S3、S5 | 配置错误码与成功次数契约统一 | 错误码独立；次数已确认每种操作总成功3次 |
| M11 | R8及全部修复 | 行为回归、真实入口测试与性能门禁 | 从第一天开始，不等到最后补测试 |
| M12 | 死代码、失效配置、无效引用 | 按可达性清理及文档统一 | 核心修复稳定后进行 |
| M13 | P-A、P-D、P-E、P-F等 | 防御补齐及有风险项的验证/处置 | 小型防御可提前；大改需单独门槛 |
| M14 | 整体发布质量 | 隔离构建、集成/恢复演练与交付 | 所有发布门禁通过后执行 |

## 4. M01：统一显式数据库入口安全边界

### 修改位置

- scripts/recover-report-uploads.ts。
- worker/submission-index.ts。
- lib/storage/native-restore-guard.ts、lib/db/native-schema.ts、lib/db/client.ts：复用已有能力，必要时提取一个很小的 existing-only 打开函数。
- 对应 CLI/原生 schema/恢复标记测试及运行说明。

### 实现方案

入口按以下顺序执行：

    解析显式绝对路径及只读/写入模式
    → 检查恢复未完成标记
    → 验证数据库已经存在且路径合法
    → 只校验原生身份/结构/绑定存储根
    → 校验通过后才设置写入连接参数、创建运行时并执行任务
    → finally 关闭本入口持有的连接

1. 复用 assertNoIncompleteRestore(databasePath) 和 assertNativeSchema({ database, storageRoot })。后者已有，不需要再复制 checksum/表清单校验。
2. CLI 不调用 ensureNativeDatabase；它可能初始化空库。备用 Worker 和回收命令只处理显式且已初始化的原生库。
3. marker 检查必须早于可写打开及 journal_mode 等可能持久写入的操作。需要先用只读连接校验再换写连接时，写连接上再确认身份/根绑定，避免使用过期校验结论。
4. 原有 marker 检查不是允许“服务运行时并发恢复”的锁。恢复仍要求所有写者停止，不能宣称检查一次就解决恶意并发替换文件。
5. 普通回收 dry-run 也遵守身份及恢复隔离约束；若以后需要救灾只读诊断，建立明确诊断模式，不给 apply 留可绕过开关。
6. 只修改活入口；旧 relocate-paths 测试代码不被算作第三个生产入口。

### 测试与验收

- 有效 marker 下，回收 apply/备用 Worker once 均非零退出；outbox.attempts、storage_usage.revision、任务/调用记录不变，marker 保留。
- 不存在的路径不创建 SQLite 文件；空文件、旧库、混合库、错 checksum、缺必需触发器、错 storageRoot 均拒绝。
- 正确原生库可正常 dry-run/apply/once，重复执行保持既有幂等和回收保护。
- TS 源入口与编译后的 .runtime 入口各覆盖一次。
- 当前依赖“旧共享表+P3表”的CLI测试夹具改用真实fresh native初始化，至少覆盖test/report-upload-recovery.test.ts的CLI用例与test/submission-worker-command.test.ts；后者确实spawn备用Worker，不能漏改。不能为了旧夹具通过而放松入口校验。优先复用test/helpers/native-backup-fixture.ts或现有native helpers，不替换所有单元测试共用的旧夹具。

## 5. M02：备份 CLI 的环境加载与密钥边界

### 修改位置

scripts/native-backup.ts、lib/config/load-env.mjs（复用，不另写加载器）、相关 native-backup 测试、docs/local-native-runtime.md、docs/docker-deployment.md、.env.example。

### 实现方案

1. 最小改法是在 runNativeBackupCli 执行备份/恢复前调用现有 loadYanXingEnv。已核对 settingsEncryptionKey 是实时getter，当前不需要为了此缺陷重排全部静态import。只有发现其他相关配置被模块顶层缓存时，才将那部分值导入移到加载之后；不得假设普通函数调用能改变ESM静态import求值顺序。
2. 复用启动器已有 .env/.env.local 查找和环境变量覆盖规则；不为备份创建第二套 dotenv 解析器，不按数据库路径猜测环境文件位置。
3. 明确命令执行工作目录。管理员在其他目录执行时，使用显式环境变量或 key-file；文档给出从项目根运行的例子。
4. 保留现有优先级：显式key-file > 已有进程环境 > 环境文件，测试二者同时存在及不一致时的现有处理。key-file按原始字节读取，不能trim、去换行或转成另一把密钥。
5. 不回退 .settings-key，不生成新主密钥，不打印密钥，不把密钥放进归档或运行根。
6. 不改变停写、目标不存在、HMAC、同路径恢复和中断标记策略。

### 验收

只有临时 .env.local 提供合成固定密钥时可按约定运行；显式进程环境和 key-file 场景正确；缺密钥、错误密钥、错误 key-file 字节和目标存在时明确拒绝。用完全隔离的运行根及归档目标，不能拿真实备份试错。

## 6. M03：修复提交失败恢复与导航边界

### 修改位置

lib/workspace-submission.ts、lib/workspace-submission-client.ts、components/workspace-app.tsx、components/workspace-submit-flow.tsx、完成报告替换相关组件；必要时补充现有响应类型，但不创建通用客户端任务框架。

### 状态处理表

| 条件 | 目标状态 | 允许动作 |
|---|---|---|
| 首次确认明确返回未提交的领域拒绝，如 UPLOAD_EXPIRED | 可恢复 failed | 查看原因、重新选择/准备、放弃这个未提交草稿 |
| 已确认旧请求未提交的 plan/workflow/completion 冲突 | conflict | 拉取最新令牌，用户重新确认后生成新身份；此前unknown或IDEMPOTENCY_KEY_REUSED先核对原回执/command |
| 请求超时、连接中断、无法解释的5xx | uncertain | 保留原 key、command、uploadId；同键重试/查询状态 |
| 之前已有 unknown，本次又401/403/404 | 仍 uncertain，或转登录后的待确认状态 | 重新认证/恢复权限后查询，不认定前次未提交 |
| 同键返回成功回执，含 replayed | 已成功 | 固定 receipt，结束待确认流程；刷新失败只影响视图 |
| 上传权威状态 committed 且返回 reportId | 已成功恢复路径 | 沿用现有 committed 恢复分支，读取报告/回执，不重传 |
| 同账号/课题下上传权威状态 failed/reclaiming/reclaimed，且现有状态机保证不能再 commit | 可恢复失败 | 复用现有GET状态，先测试该终态/fence保证；允许重新准备，但不提前释放仍在清理的配额 |
| 上传仍 receiving/parsing/ready | 保留准备/待确认 | 不用“当前没回执”推断永远不会提交；不能靠浏览器时钟判定服务器已过期 |

### 实现要点

1. 为确认阶段增加commit_failed/rejected事件，优先复用现有failed相位和现有“重选/重试解析”UI，不另建重复弹窗。该事件只从submitting接受；进入failed后不得保留可重发的旧upload/command/key，保留file、stageId、reportKind和错误信息。重新准备生成新的上传和请求身份。
2. 分类需要错误码、请求阶段及“此前是否出现过不确定结果”，不能只看HTTP status。此前不确定标记是客户端状态，不混入服务端command/digest。可安全终止的错误码建立白名单，未识别错误和来源混合的UPLOAD_ABORTED仍保守unknown。401/403/404或“这次事务回滚”不能证明前次未知请求没提交；不存在/无权限也不等同于可安全换key。
3. 普通提交和完结替换共用确认入口/分类。复用并测试已有submitPhaseRef的同步单飞保护，不再造第二套确认锁；冲突刷新handleConflictRefresh补独立single-flight/序列校验，防双击把过期tokens标为可提交。重复确认重试仍必须同key、同command。
4. 对真正 unknown，不增加直接丢弃 key 的“强制放弃”按钮。若未来必须立即安全撤销仍 ready 的 unknown，需要服务器在写事务内解析回执或 fence 掉旧上传，属于独立协议，不用一个 reset 假装完成。
5. 现有 apiFetch 收到401会跳转登录，仅保留 React state 不够。建议在发出确认前保存最小待确认定位信息到 sessionStorage：actorId、projectId、uploadId、idempotencyKey、原 command、协议版本。不得保存正文、File、认证令牌、模型密钥。
6. sessionStorage 仅用于同标签页重新登录/刷新后的恢复提示；做结构验证和长度限制，绑定当前账号。成功或确定不可提交后清理；不按一个客户端 TTL 自动删除仍 unknown 的身份。
7. 恢复时先查询原上传/同键回执，不自动重新上传或启动分析。存储不可用时明确不承诺跨导航恢复，不能因此把当前 unknown 当作失败。
8. 切课题时，纯配置/未提交草稿可关闭或提示放弃；submitting/uncertain 仍归属原课题，不能套用新课题令牌。浏览器前进/后退及完结替换走相同约束。
9. UI沿用既有弹窗布局，只补准确文案和重新准备/恢复入口。不要让“报告可能已保存”出现在明确已拒绝且可重新上传的情况。

### 必测场景

过期后能重新提交；首轮403/400明确拒绝能退出；丢响应但已提交后同键重试只产生一个报告；unknown后403不能换键；登录跳转后恢复原请求；双击确认；切课题/后退；替换完结报告；刷新失败不重发确认；恶意或损坏的sessionStorage不被当成授权数据。

## 7. M04：读取排序及任务/成果防倒退

### 修改位置

components/workspace-app.tsx、components/workspace-submission-state.ts、lib/workspace-submission.ts；尽量扩展现有 helper，不新增全局 store。

### 实现方案

1. 每次报告读取捕获导航身份、reportId、请求序列和该报告的 mutation epoch；读取完成时统一检查。loadProject 内携带 selectedReport 的路径也必须经过同一规则，不能只保护轮询。
2. 启动/重试/取消任务之前或接受写响应时，明确废弃此前读取；AbortController 用来节省资源，epoch/身份检查负责保证迟到回调不能写状态。
3. 同一报告的定时轮询和SSE刷新合并为单个 in-flight read，期间新事件只设置“还需再读”标志。避免请求耗时超过3秒时不断发新请求，导致所有返回都因 latest-issued 判断失效而永久不显示。
4. 按 operation 区分 analysis/insight；较小 generation 不能覆盖较大 generation。同一 generation 的 taskId 不一致视为异常，重新读权威状态，不混合两份数据。
5. 同一任务的终态不可被旧非终态覆盖；取消请求不能被旧响应清除。但不能把 queued/running 简单排成只升不降的状态序列，租约恢复可能有合法运行态变化。
6. 任务与成功成果身份分开：新一代 queued/running 时继续显示前次成功成果，不清空它；但旧 snapshot/history/score/comparison/capabilities 也不能随陈旧详情倒退。
7. 没有足够版本信息判断时，丢弃整份陈旧详情并发起去重重读；不要只保留新 task 却接受旧 capabilities。权限以服务端为准，不从旧卡片重新构造写权限。
8. 清理卸载/切报告的abort、timer和请求身份记录。SSE仍是失效通知，不能直接把事件payload当最终分析成果。
9. setState函数式updater和render必须保持纯计算，不在里面发送刷新GET或toast；React StrictMode可能重复调用。终态dirty标记/刷新在提交后的effect或明确的应用成功路径触发，并按任务身份去重。

### 验收

用可控 Promise 或浏览器响应延迟，验证 A先发后到/B后发先到、启动新代次后旧完成返回、同代终态回退、analysis与insight交错、合法lease恢复、切课题、取消后迟到完成、新任务失败仍保留旧成功结果。测试实际 helper/组件，不在测试里复制一个“正确合并器”。

## 8. M05：刷新协调、删除后恢复与回执UI清理

### 修改位置

components/workspace-app.tsx、components/workspace-native-dialogs.tsx、components/workspace-submit-flow.tsx，复用M04的读取规则。

### 实现方案

- 统一一个局部刷新流程，按原因标记课题详情、课题摘要、报告库、概览的 dirty 状态；只刷新受影响的资源。
- 任务首次到达终态时，以 taskId + generation 去重，触发一次相关投影刷新。每个 progress 事件只刷新当前任务/详情，不拉整库。
- dirty 资源进入视图时刷新，不能导航只是 setView 后永久显示旧缓存。迟到的列表读取也需有自己的请求序列/失效代次。
- 删除成功后用既有原生选择规则更新detail.selected/selectedReport、组内卡片、reportView、insight及URL；仅清reportView并不能保证URL里的旧reportId消失。删除非当前报告时不清空当前选择。权威详情暂时不可得则展示安全空态/刷新态，再独立刷新相关资源。用Promise.allSettled或等效逐项捕获处理每项失败，不能让第一个失败跳过其余刷新。
- 现有refreshStats/refreshLibrary有捕获后返回boolean的路径：allSettled中的fulfilled(false)仍是失败，不能只看rejected。先统一或明确各helper的返回契约，再决定dirty是否清除和提示内容。
- “业务成功”和“刷新成功”分开：显示“报告已删除，但部分视图刷新失败”，提供重试刷新；不重新执行删除/提交/分析。
- 失败资源保持dirty；下次进入视图或手动重试补齐，不能失败也标记clean。优先用新详情更新对应课题摘要/卡片，或标脏非当前视图；当前fetchAllPages会拉全量列表，不能每个任务终态都无条件重新下载所有分页。重复错误提示去重。
- start/cancel等mutation响应丢失时只做权威重读，不自动重发mutation；提示“执行结果暂未确认”。不能因本地请求报错就忽略服务端可能已入队的任务。
- 为持续轮询/SSE失败增加明确状态及有界退避；正常SSE暂断不报严重失败。保留可验证的poll兜底，先不为减少请求而直接关闭它。
- 当前成功回执面板 acknowledged 立即被 idle 覆盖。推荐保留已有“关闭弹窗+notice”的交互，删除不可达展示和 refreshError 死分支；成功回执作为数据仍用于去重和恢复，不能连同安全状态一起删掉。

### 验收

任务成功/失败/取消后切总览和报告库立即看到正确评分与能力；分析和洞察同刻完成不触发重复全量刷新；删除成功后详情GET故障仍刷新其他列表；刷新失败有可见提示且可重试；刷新失败不再次调用 mutation；离开页面后无遗留timer/连接。

## 9. M06：列表投影与详情解耦，消除查询及响应膨胀

### 修改位置

lib/db/submission-workspace-repository.ts、lib/db/submission-query-repository.ts、modules/reports/workspace-query.ts、modules/contracts/submission-workspace.ts；必要时调整 lib/workspace-submission-client.ts 及对应路由测试。

### 9.1 查询职责

| 入口 | 应读取的数据 | 不应执行 |
|---|---|---|
| 全局报告库/课题报告分页/阶段报告分页 | 当前页报告基础字段、阶段标签、课题信息、能力所需摘要、比较基准 | getReportDetail、全课题逐报告装配、全量结果JSON |
| 课题列表 | 当前页课题聚合、当前阶段、提交/完成数量、最新提交轻量卡片 | 每课题全部报告详情 |
| 单报告详情 | 报告/阶段/课题元数据、该报告任务与成功成果、必要比较基准 | 为一份详情重建整课题所有卡片 |
| 课题详情 | 一次性批量阶段/卡片、至多所选报告完整详情 | 每个卡片再次调用详情，所选报告重复重建课题 |
| 概览 recent/activity | 去重后的至多16个报告ID的批量卡片 | 每张卡片一次 assembleProject |

### 9.2 批量装配步骤

1. 短只读快照内先完成 actor 校验、过滤、稳定排序、count及LIMIT/OFFSET，再按返回ID集合批量取辅助事实。读事务内不得 await/做文件I/O，也不需要 BEGIN IMMEDIATE 写锁。
2. 批量获取涉及课题的成员角色/工作流、每报告每操作最新task、成功次数/首次成功、最新成功成果标量摘要；最新task查询也只取必要列，不SELECT *把frozen_json/提示词/正文搬到JS再丢弃。继续调用现有领域能力策略，不复制一套SQL权限规则。
3. 使用 generation 确定任务/成果代次，不用墙钟时间替代；不为每个报告独立 SELECT history/result。
4. 最新提交必须在完整课题的有效提交中求得，不能把“当前页第一条”当 latest，否则会错误开放历史重跑或删除能力。
5. 比较基准按当前领域规则选择：同课题、较小 submission_sequence 的最新未删除提交；wasFirstStageSubmission 为 true 时不比较。不能擅自增加同阶段筛选或从 stageVersion 推导首次标记。
6. 按当前页和所需基准ID投影分数/完整度。保持 kind、payload结构、数值类型、0–100范围和缺失值校验；0分是合法结果，不得转换为undefined。
7. DTO按字段白名单构造，复用 reportCard 纯投影；禁止 getReportCard 返回 detail，也禁止 spread detail 或类型断言冒充裁剪。
8. 报告列表只输出 reports + total/limit/offset/hasMore，去掉额外 items。现有 WorkspaceReportListResponse 与 fetchPage 的 collectionKey 都要求 reports；课题列表保持 projects。
9. optionalCard 只能有意识忽略明确不存在/已删除的竞态；SQL、JSON结构及程序异常不能伪装为空卡片。普通分页尽量通过统一快照避免 total/items不一致。
10. 去掉 selectedCard as WorkspaceReportDetail 兜底。缺详情就明确未加载/不存在，不能伪造 history/progress。

### 9.3 不偷偷改变的协议边界

WorkspaceHistoryResponse.groups 与课题详情 stages 当前包含分组卡片；保留这个含义时，输出本身仍是 O(课题报告数)。本批先把它改成一次线性批量装配，消除反复装配和正文下发，不宣称这些响应变成常数大小。

若后续规模要求真正分页历史组，需另行改契约、逐个迁移消费者，并在原布局加入加载更多；不能把groups悄悄截成一页或直接删除公开history/阶段/课题GET接口。全局列表客户端目前也用fetchAllPages，服务端按页优化不代表一次前端操作只发一页请求；必须量化完整前端动作的总请求量/下载量，保留安全页数上限并明确超限错误。

### 验收与建议预算

- 同一20卡片fixture在课题报告数100/500/5000时，prepare计数不随课题历史线性放大；建议硬门禁每页不超过30次，超出必须逐条说明。
- 列表/概览卡片不包含 snapshot、insight全文、history、job/frozen上下文；通过序列化实际响应验证，而非只检查TS类型。
- 上轮20个64KiB成果fixture的列表响应由5,343,526字节降到建议128KiB以内；该数是拟定验收预算，需实现后实测，不是当前成绩。
- 同硬件对照记录延迟、SQL、JSON解析字节和heap峰值；时间指标以改善趋势为准，不设容易受CI负载影响的任意毫秒硬断言。
- 权限、0分、缺分数、当前完结保护、首次/历史报告、软删基准变化、重分析替换有效成果、同时间戳分页稳定性全部保持。

## 10. M07：概览聚合与GET防护

### 修改位置

lib/db/submission-workspace-repository.ts、lib/overview-trends.ts、app/api/overview-stats/route.ts、现有限流helper及概览测试。

### 实现方案

1. 将任务状态、报告/知识数量和字符数改成SQL COUNT/SUM/GROUP BY，不把全部行搬到JS再过滤。
2. 分数仅投影必要数值，路径为 snapshot.payload.aiScore.overall，完整度为 snapshot.payload.reportCompleteness.overall；保留 kind=analysis、JSON数值类型及范围检查。不读取完整 payload_json 到JS。
3. 窗口内按日聚合；窗口前返回sum/count或累计值基线。runningAverageValues 的首点必须包括窗前历史，不能只查最近7天。
4. 在TS沿用当前日期/时区规则生成日界并参数化传SQL；不要用SQLite默认UTC分组替代现有localDayKey，或把created_at擅改为completed_at。
5. 保留当前各指标的已删除报告、全部任务尝试、未完成任务分母等口径。用冻结时间的旧/新实现对照测试发现差异，统计含义调整另立需求。
6. recent/activity卡片合并ID后复用M06批量路径；映射回各自排序和限额。
7. 保留overview按已认证用户120次/分钟的防护，复用现有限流helper，返回429及Retry-After。不要误伤SSE/poll接口，也不把GET所有请求全局放进一个计数器。
8. 不先加Redis或跨请求大缓存。SQL仍可能扫描全历史JSON，标量投影解决JS搬运/堆内存，并不自动变成O(1)CPU；如果目标容量压测不达标，再评估专用分数摘要和schema演进。

### 验收

相同数据集旧/新统计和趋势完全对齐；覆盖窗前基线、日期边界、未来时间、0分、缺分数、软删、重复成功代次。增加100/1000/10000结果容量阶梯测试，观察JS传输量随统计输出而非正文大小增长；API端到端报告P50/P95、事件循环延迟及heap，不用简化SQL探针冒充生产GET。限流覆盖两个用户相互隔离及窗口恢复。

## 11. M08：通知错误隔离与参数归一化

### 修改位置

lib/db/submission-workspace-repository.ts、lib/http/submission-workspace-handlers.ts、对应通知/工作区路由测试。

### 推荐实现

1. 在所有 recordActivity 调用的共同边界隔离通知失败，采用明确的尽力通知语义；创建/编辑课题、删除、任务启动/取消/重试都覆盖，不能只包一个HTTP入口。
2. 业务事务提交后，通知收件人批次用短的独立事务；中途失败回滚整批并记录一次结构化日志，避免部分收件人收到、部分没有。不把网络或文件操作放进该事务。
3. 只捕获通知部分，不吞业务校验、权限、配额或主事务错误。日志复用现有入口，包含action/业务ID/错误码，不包含全文、密钥或整个请求体。
4. confirmReport 已有通知异常隔离，保留它；确认结果 replayed=true 时不再发“新提交”通知。任务准入 reused=true 时也不重复发送“新建任务”通知。
5. 尽力通知允许业务提交后进程崩溃导致未通知；业务事实和审计不会因此丢失。若产品要求必达，必须另做稳定事件ID+可靠投递，不能宣称加try/catch就实现exactly-once通知。
6. markNotificationsRead 保持 all=true 优先：忽略 ids，仅绑定实际SQL占位参数；all=false时按现有上限校验并去重IDs。WHERE仍限定当前recipient。

### 验收

在第一个及中间收件人注入通知INSERT失败，业务仍成功且只写一次，通知批次无半成品，有日志；确认同键重放不重复通知；复用任务不重复通知；all=true与非空ids组合不500，all=false/空ids/非法输入/其他用户通知均正确处理。

## 12. M09：恢复完整维护调度并优化回收查询

### 12.1 完整维护接线（R6）

位置：worker/runtime.ts、worker/submission-runtime.ts、lib/reports/submission-processing-runtime.ts、lib/storage/maintenance.ts、相应配置和测试。

1. 保留 ReportUploadRecovery 的上传TTL/fence回收；它不代替知识库和公共tmp孤儿文件维护。
2. 复用现有完整维护实现及间隔配置，显式传入本运行时数据库和根路径。不能在显式CLI/测试运行时偷偷落回 getDatabase() 打开默认业务库。
3. 推荐默认主Worker明确注入并启用完整维护回调，额外显式Worker不默认启动第二个完整清理器；不能仅新增一个默认false开关，让普通部署继续没有维护。部署文档和app-manager明确单例所有权，多主部署需要专门协调，不以进程内Promise冒充分布式互斥。
4. Worker.run 的循环可能仍有 running 任务，不能在里面直接 await 长时间同步扫描/哈希并假设没有活跃lease。维护到期时应通过明确维护窗口或独立受管执行单元处理；不在本进程有活跃模型任务时执行会阻塞心跳的完整维护。
5. 首选最小调度：到期后暂缓新claim，等待本进程任务自然结束/取消，再执行完整维护，结束后恢复领取。不能强制取消正常模型调用来清磁盘；持续繁忙也不能导致维护永远不执行。
6. 当前完整维护不是可随意截断的批处理：不完整扫描必须fail-closed，不能按“只看前100文件”重建全局账本。较大存储根若超出可接受维护窗口，则改为独立单例运维作业，并真实接入部署调度，不仅写一句“请定时手工执行”。
7. 保留active reservation、孤儿宽限期、缺失/不可访问根、符号链接、最近变更文件及正式/墓碑报告保护；不提前释放文件未确认删除的配额。
8. 维护失败记录码/耗时/文件数量/下次重试时间，按间隔重试，不退出Worker、不紧密自旋。停止信号到来时不再启动新维护；不把中断扫描当作完整结果继续删文件。用假时钟测试间隔，真实小库测试维护后恢复领取；多Worker测试必须覆盖另一进程仍在写时的锁等待和安全性。
9. 不接回旧 pruneJobEvents；新审计表不可删，见M12。

### 12.2 回收前缀检查（R7）

位置：lib/db/report-upload-recovery.ts 的 claim 和 requireLease 两处，及report-upload-recovery测试。

设计复核发现：唯一source_key索引在report_uploads上，report_submissions.source_key并没有索引。因此仅把substr改成range仍会SCAN正式表，不能作为已完成的性能修复。

**推荐：保留对正式报告表的独立保护，增加非约束性能索引，再改范围谓词。**

    CREATE INDEX idx_report_submissions_source_prefix
    ON report_submissions(source_key);

    r.source_key >= u.id || '/'
    AND r.source_key < u.id || '0'

范围以“id/”为下界，以末尾ASCII斜杠的后继字符“0”为上界，不是给整个ID加一。默认BINARY下等价，不能搬到NOCASE等不同排序规则。索引必须覆盖全部正式/墓碑行，不能是排除deleted_at的partial index，也不是新的UNIQUE约束。

**实施方式：**用户明确不需要历史兼容。索引直接写入fresh native核心SQL、必需索引清单和NATIVE_SCHEMA_CHECKSUM，不提供运行时安装模式。任何缺索引或旧checksum的数据库由assertNativeSchema拒绝；不得通过补DDL、改身份记录或放宽校验原地采用。

恢复查询使用BINARY等价范围谓词；测试覆盖特殊ID及EXPLAIN内层SEARCH。备份只恢复同一checksum的数据库，因此无需恢复后另装索引。

不得为了沿用report_uploads的索引而只查committed uploads：正常提交链虽双写一致，现有独立报告引用保护还覆盖账本/上传关联异常。没有证明所有损坏状态都等价之前，不能以牺牲防误删能力换速度；审计在事后发现差异也不能挽回被删文件。

必须保持u.report_id IS NULL、状态/过期条件、claim及complete前的lease复核，以及任意正式/墓碑报告引用该目录即不可回收。不能只查report_id外键，不能用带通配符的LIKE。

测试下划线、连字符、大小写、共享前缀、目录边界、同目录不同文件、墓碑、未知兄弟文件、上传关联异常和租约丢失；有索引时EXPLAIN应对内层r做SEARCH。测试无索引的正确性fallback、重复安装、错误同名索引、marker下拒绝安装、备份恢复保留索引。外层候选排序及每批账本重建另记录成本，不把一个内层优化宣传成整个回收过程恒定耗时。

## 13. M10：模型配置错误与次数契约

### 13.1 配置错误（S3）

位置：lib/ai/submission-admission.ts、modules/reports/submission-task-domain.ts、lib/http/submission-workspace-handlers.ts、活跃前端工作区及测试。

- 未选模型、渠道缺key分别使用明确领域错误，如MODEL_NOT_CONFIGURED、MODEL_CREDENTIALS_MISSING，推荐409；所有实际使用的start/retry路径映射一致。
- PROJECT_CONTEXT_INCOMPLETE已是409，保留具体补充要求，不改成通用失败。
- 只在已知缺配置处抛业务错误，不把解密失败、损坏快照、DB异常等所有Error都包装成409。
- admin可得到现有设置入口提示；普通负责人提示联系管理员，不给无权限用户跳转管理页面，也不暴露渠道密钥/完整冻结运行配置。
- 实际修改workspace-app的处理流程，不修已死use-analysis-job-actions hook。
- outbox遇配置错误仍pending延迟重试，记录稳定错误码；不新增最大次数后丢弃意图。
- 发布烟测补充发现并修复限流桶串扰：`/api/jobs/:id/retry`保留4次/15分钟的严格独立`task-retry`桶，不再消耗`insight`新建额度；两桶各自达到上限仍返回429。

测试真实handler的未选模型、缺key、上下文缺失、队列满、无权限、未知内部异常；断言配置失败不创建任务或模型调用。新增中文文案不是代替错误码。

### 13.2 次数契约（S5）

用户已确认：分析和洞察各自总成功最多3次，即初次成功+最多2次重新生成；保留 MAX_REPORT_OPERATION_SUCCESSES=3，不扩大为4。

失败/取消不计入成功额度，活动任务仍复用；历史报告第一次成功后的限制不改变。UI能力与真实handler并发start/retry测试分别覆盖两种操作，达到3次后API拒绝且保留既有成果。

## 14. M11：行为测试、失败回归与性能门禁

### 先修已红门禁

test/report-stage.test.ts:44 不再检查组件源码必须出现 report.labels.compactLabel。把阶段标签/版本徽标语义覆盖迁到现行原生组件和投影：自定义阶段名、重命名、重排后稳定ID、更新/完结/替换、空课题、软删历史。

结合 test/repository-loading.test.ts 的现有展示约束，避免两组测试互相要求相反源码写法；不为了正则通过加注释或无意义引用。旧Milestone helper测试若仅验证退役模型，按M12归档/删除，而不是修改新UI去迎合它。

### 回归矩阵

| 组 | 最低覆盖 | 层次 |
|---|---|---|
| T01 入口保护 | marker、缺库、空库、旧/混合、错身份、错根、正确库、编译CLI | 子进程+临时真实native库 |
| T02 环境/备份 | env.local、显式env、key-file字节、缺/错key、中断标记 | CLI+隔离归档 |
| T03 提交恢复 | 确定拒绝、丢响应已提交、unknown后拒绝、双击、重新登录、切课题、替换 | reducer+真实handler+浏览器 |
| T04 读取竞争 | 同报告乱序、新generation、同代终态、取消、旧成果保留、导航 | controlled Promise+浏览器拦截 |
| T05 刷新故障 | terminal去重、删除后GET失败、部分刷新失败重试、不重复mutation | 状态/客户端集成 |
| T06 卡片投影 | 字段白名单、0/缺分数、权限、最新提交、比较基准、软删、稳定分页 | repository+序列化响应 |
| T07 概览 | 旧新黄金对照、窗前基线/日界、任务分母、结果缺失、限流 | SQL+handler |
| T08 通知 | 批次故障、业务不回滚、重放/复用去重、all+ids、跨用户隔离 | 故障注入+handler |
| T09 维护 | 到期间隔、活任务心跳、失败退避、无默认库旁路、多入口归属 | 假时钟+临时文件系统 |
| T10 回收 | 前缀范围等价、索引计划、正式/墓碑保护、lease竞争 | SQL+既有文件恢复测试 |
| T11 AI准入 | 模型/密钥/上下文/队列/权限/成功上限，零真实付费调用 | 真实handler+stub provider |
| T12 构建防护 | storage-native、env/key/DB不入包；retired库仍拒绝 | 装配测试+候选包检查 |
| T13 用户闭环 | 创建→准备→确认→分析→取消/重试→洞察→替换→删除→历史/概览 | 隔离生产候选+浏览器 |

优先扩展现有 submission-workspace-routes、workspace-submission-ui、workspace-report-deletion、submission-task-concurrency、report-upload-recovery、storage-maintenance、native-backup、report-operation-limit 等测试。只在缺真实行为承载点时新增小测试文件，不再建另一套测试框架。

审查脚本 reproduce.mjs / reproduce-operations.mjs / checks.mjs 的assert是在证明旧bug存在，不能原封不动接入长期CI；提取fixture与场景，改成修复后的预期断言。

## 15. M12：死代码、失效配置与文档清理

### 15.1 分批清理

A批：完整孤立的六文件，可作为单独提交删除（约1778行）：

- components/workspace-dialogs.tsx。
- components/report-stage-assignment-dialog.tsx。
- components/project-management-dialogs.tsx。
- components/project-progress-dialog.tsx。
- components/report-delivery-flow.tsx。
- components/use-analysis-job-events.ts。

B批：无消费者声明。删除 retryWorkspaceTask/fetchWorkspaceStages/fetchWorkspaceHistory、beginSubmitPrepare、IDEMPOTENCY_KEY_PATTERN、WorkspaceNavProject、三项未用stage常量、getBrandingStorageRoot、selectionBadge、displayedSnapshot、sameWorkspaceIdentity、WorkspaceOutboxStatus、SubmissionExecutionTask。删声明后检查是否留下新的unused import。

components/workspace-types.ts只删旧ReportWithProject/OverviewStats及连带旧类型导入，保留KnowledgeItem。FirstReportDraftState保留。

C批：测试耦合旧栈。先把旧handler、旧repository/worker、dashboard-state、analysis-job-actions、workspace-plan-form、submission-task-progress、report-stage/progress/history-policy、relocate-paths的测试逐项映射到原生能力。可替代者迁移后删除；确需保留历史回归者放到明确test/legacy区域并排除生产打包。

createStageProjectHandlers/createSubmissionTaskHandlers等过渡运行时挂件，确认生产route不再使用后移除构造及返回字段；不要删活workspace handlers。usage_settled/usage_reconciled的旧预算监听和专用分支，确认无公开事件承诺后清理对应合成测试。

取消洞察时无效的 generating={false} 类prop，按实际需要删除，或给既有UI明确“停止请求中”状态；不能为解决一个无效prop新增另一套任务状态。

### 15.2 不删除的内容

保留活的modules/analysis/pipeline、原生任务/策略、提示词上下文预算、parser子进程、真实CLI入口、公共GET/history/retry API。清理依据包含动态import、字符串spawn、构建入口和测试引用，不只grep静态import。

按已确认的fresh-only决策删除projects.status；正式确认把正文写入report_submission_documents后在同一事务将report_uploads.document_text清NULL，上传行仍保留回执、文件身份与恢复状态。新审计表和正式/墓碑正文继续保留；更新并断言新的NATIVE_SCHEMA_CHECKSUM，旧checksum拒绝。

### 15.3 文档/环境

- README说明当前浅色界面，删除仍可明暗切换的现行承诺，但不篡改历史CHANGELOG。
- .env.example统一固定显式主密钥的部署要求，解释部分旧运行时回退与备份/原生模型执行要求的不对称，删除“依赖隐式.settings-key即可完成本原生部署”的误导；不声称代码中仍存在的遗留回退已被删除。
- YANXING_STORAGE_MAINTENANCE_INTERVAL_MS在M09后明确真实消费者、最小间隔/执行窗口和单例所有权。
- YANXING_JOB_EVENTS_RETENTION_DAYS删除或明确标为不适用于原生审计；不要让配置看似控制一个永不清理的表。
- 对解析器资源参数补单位、默认、取值范围、实际消费者、是否需重启；所有数值从现有代码读取，不复制过时报告里的默认值。
- 对成功次数、备用CLI安全边界、备份环境查找、停写及故障恢复形成一套当前说明。
- 子代理/旧审查的“测试全绿906”等记录只作为历史证据；新验收报告记录新实际数量，测试数下降需说明删除了什么覆盖。

## 16. M13：防御性补齐及暂不强改项

| 项目 | 本批动作 | 升级条件/不能做的事 |
|---|---|---|
| Docker装配漏拦storage-native | 同步末端私有路径规则及forbidden roots，增加混入DB/env/key时拒绝的测试 | 不声称已有生产泄露；不只依赖上游trace排除 |
| 打包失败残留目标 | 错误输出保留现场路径及新目标重试方法 | 不自动递归删除未知目标 |
| restore演练保留根未显示 | 报错中输出-pre-restore目录、marker及恢复步骤 | 不覆盖部分恢复目标，不自动清marker |
| 大文件HEAD/Range全哈希 | 记录文件大小×请求模式×并发成本；保留完整性测试 | 达容量问题后设计可证明的不可变文件身份/校验复用，不简单信mtime |
| 大库audit/apply双审计 | 量化窗口、去掉明确重复的非安全性查询 | 不默认提供跳过校验选项 |
| 同一编辑session就地更新 | 相关组件修改时改为不可变更新，覆盖管理员异步成员加载 | 不把未复现的StrictMode崩溃当发布阻断项 |
| 提交对话框跨课题 | 在M03/M05浏览器测试中确认，修复草稿归属及关闭行为 | 不清掉原课题unknown请求身份 |
| 双正文/永久审计/陈旧status列 | 记录容量和权威字段，暂保持 | 要清理需正式schema/留存/备份策略，不作为本轮小修 |
| SSE无onerror/重复鉴权 | 做失败可观测性与合并请求；保留有效鉴权及终态close | 不称其必然泄漏；不删跨await的安全复核 |

## 17. M14：实施顺序、提交组织与发布验收

> 实施状态：已完成。所有写入型验收均使用临时根、合成密钥和唯一候选/容器标识，未接触当前服务。

### 17.1 分阶段推进

阶段A：建立基线与失败用例；M01/M02/M03优先，M11修复红色行为门禁。先封恢复旁路、让用户能从确定失败恢复。

阶段B：M04/M05前端一致性与M06/M07查询投影两条主线推进；M08/M10做小型服务端修复。

阶段C：M09维护/回收、安全防御M13、M12清理及文档；M09不要绕过已完成的入口保护。

阶段D：整套验收与候选包，确认次数契约，再由用户授权部署。不得边运行真实业务边改包或恢复目录。

### 17.2 文件所有权与并发上限

建议最多4个实现子代理，并严禁嵌套，总子代理始终不超过5：

- 存储/CLI轨：M01/M02/M09。
- 前端轨：M03/M04/M05及M10的UI文案。
- 查询/API轨：M06/M07/M08/M10服务端，同一个仓储文件由一人串行维护。
- 验证/文档轨：补测试/候选包/文档；测试夹具变更和实现轨先约定文件归属。

M12大规模删除不得与前三轨同时修改同一组件/仓储；放在接口稳定后独立提交。不要为了凑并行度让多个代理同时写workspace-app或submission-workspace-repository。

### 17.3 提交建议

按边界组织小提交：安全入口、备份环境、提交状态、读取排序、刷新协调、轻量DTO、概览聚合、通知、维护/回收、AI错误/次数、孤立代码删除、测试耦合清理、文档/构建防护。每个逻辑提交包含对应回归，不把全部改动堆成无法定位的一次提交。

实施前保留用户当前工作区。仅创建branch/worktree不能自动带上179个未跟踪实现；只保存git diff也不包含它们。隔离副本必须基于完整受审文件清单构建，排除真实运行根、凭据和构建垃圾。不得未经授权git add -A、reset、clean或替换用户修改。

### 17.4 验证命令及环境

本轮按以下顺序执行，并逐项检查退出码；首次发布烟测和浏览器烟测发现的问题均先定位修复，再从新候选复验：

    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm lint
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm test

随后仅在包含全部目标源码的隔离副本、合成环境和全新输出目录中执行现有构建：

    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm build:runtime
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm build

读取脚本usage后按其要求生成/装配候选，再运行已有test:p5:contention、test:p5:browser、test:p5:container、test:p5:release。release验收必须显式给--release-root或--artifact-path，不能只敲脚本名就称已覆盖发布包；备份恢复模式也需显式选择。

- 不在当前服务使用的.next/.runtime上直接build:docker；容器装配在隔离副本中进行。
- 读取当前node_modules/next/dist/docs相关指南再改Next代码；遵守AGENTS.md的界面保留要求。
- 浏览器验证目标是隔离YanXing候选，不是DSH GUI，也不替换当前正在使用的服务。
- 所有故障注入、SIGKILL、多进程、恢复演练使用可识别的临时根和合成key，绝不使用真实报告/运行库。
- 每条命令记录退出码；若失败先调查，不用后面的成功命令掩盖前面的失败。耗时/性能报告区分微基准和完整API。

### 17.5 发布通过条件

- [x] M01两条旁路全部封住，TS和编译入口均拒绝marker/不兼容库且不写库。
- [x] 确定失败可重新准备；真正unknown不会自动换键，登录/导航恢复边界符合说明。
- [x] 同报告旧响应不能覆盖新任务和能力；前次成功成果不会被新任务清空。
- [x] 终态及删除后各视图一致，部分刷新失败可见可重试，不重复mutation。
- [x] 列表字段白名单/查询/响应预算达标；概览趋势等价，GET限流生效。
- [x] 通知故障不把已完成业务伪装成失败；all+ids及重放去重正确。
- [x] 完整维护有真实调度者，正式/墓碑保护及lease心跳测试通过。
- [x] 模型配置错误可行动；成功次数契约有明确选择且代码/文档/测试一致。
- [x] 当前红色门禁变绿，全量lint/test通过，无为通过测试新增的skip或无意义源码字符串。
- [x] 保留公开API和角色契约；删除测试有覆盖迁移说明，无新的静态/动态无效引用。
- [x] 私有运行数据不入包，生产候选通过真实Chrome、双Worker进程租约争用、非root只读容器及隔离同路径恢复验收。
- [x] 本文记录测试/性能/产物/schema身份及部署回滚边界；最终回复给出主要源码清单。

### 17.6 回滚和数据兼容

本批已改变核心schema身份且不提供数据库迁移：部署必须使用全新运行目录。旧native库、旧备份和新候选不兼容；应用回滚也只能回到与目标数据库checksum完全一致的候选及其配套备份，不能把6660fda或本批之前的应用直接指向新库。

保留各候选的源码/产物、schema checksum和独立备份。绝不靠放宽assertNativeSchema、运行时补DDL或重写数据库身份让旧库“看起来兼容”；需要保留旧数据时必须另立经过验证的导出/导入项目。

## 18. 完成定义与本轮交付

完成不是“没有TODO”“编译通过”或“删了很多行”。完成定义是：每个确认问题有修复、真实路径回归、受影响协议说明和可重跑证据；未修的风险有明确边界、负责人/触发条件，而非混在已解决项中。

当前已实施M01–M14。最终门禁：严格TypeScript lint通过；原生测试964/964通过；git diff --check通过；Next production与1158文件compiled runtime构建通过。查询预算为61份报告/21个课题下library不超过10次prepare、projects不超过11次、overview不超过23次，300k字符成果不进入列表。

隔离候选实际通过Web/默认Worker崩溃恢复、PDF/DOCX、成功/失败模型桩及同路径HMAC备份恢复；schema为yanxing-native-p3，checksum为f25b0a40dbb64eade89c7c4bde332d3dd916635ad015e18ab63935ad28574f22。真实Chrome通过主流程9张加扩展10张截图，0付费供应商调用；唯一标签非root只读容器通过，镜像摘要sha256:f575b2b5609c6c50e6b549c6b7c50963d1463de3d6f95ba0f71020523db6f9d7。所有候选、容器和临时数据已清理，未对真实业务库写入或迁移。

测试数从清理前1067降至964：删除的103项只覆盖已删除legacy repository/migration/worker栈或源码正则伪契约；native初始化、旧库拒绝、并发租约、知识库、解析器和当前API行为已迁移/保留。实现期间使用四个互不重叠的直接子代理且禁止嵌套，未超过用户限制。

# 课题—阶段—报告实施记录

## 1. 实施依据

- 依据：docs/project-stage-report-engineering-design.md 中 BR-01—BR-23 和用户修改后的第19节。
- 用户已补充确认：新项目，不做历史兼容。不开发存量迁移、旧字段回填、旧上传协议适配或双模型双写。
- Q-01 报告上传、删除、分析/洞察写操作统一限管理员/课题负责人。
- Q-02—Q-05、Q-07 按已批准取值实现。
- Q-06 逻辑删除、不恢复、活动任务终态后删除；正式报告文件物理保留期限未确定，不新增其自动物理删除；准备文件回收单独管理。
- P0—P5已完成代码接入与隔离发布验收；本文的906项数字是当时快照。post-v0.1.2修复后的同源Web/Worker/运维工具、容器、964项回归和同路径恢复也已通过；当前证据见docs/post-v0.1.2-remediation-plan.md。两轮均未改写当前业务数据库或切换实际运行实例。

## 2. 阶段进度

| 阶段 | 本轮状态 | 交付边界 |
| --- | --- | --- |
| P0 | 规则与提交协议已编码 | 拒绝旧 deliveryType/version、强制显式阶段和类型、并发令牌与幂等键契约 |
| P1 | 基础模块与隔离验证已完成 | 新阶段/报告实体、纯状态机、统一能力、关系约束；不包含 API/Worker 切换 |
| P2 | 后端项目写入与恢复机制已收口；运行切换待联动 | 项目/成员/阶段事务、计划并发与审计、准备/确认、配额、outbox、文件回收与对账均已实现并联测；旧旁路关闭随P3/P4整体切换 |
| P3 | 原生任务与独立Worker后端交付完成 | 真实分析/洞察流水线、冻结准入、独立成功历史、检查点恢复、取消/租约/发布保护、动态查询、维护调度和显式运行命令 |
| P4 | 代码接入与隔离验收完成 | 原生 API/页面/按钮权限/通知/默认选择/阶段内提交展示及默认 Worker；实际部署未切换 |
| P5 | 隔离发布验收完成；正式切换暂缓 | 同源候选、真实Web/Worker/浏览器/容器、SIGKILL与并发、事务测量、编译版同模型备份恢复；不操作当前实例 |

## 3. P0 已冻结契约

modules/contracts/report-submission.ts 定义严格确认请求：

- uploadId、stageId、reportKind(update/completion)。
- expectedPlanRevision、expectedWorkflowRevision、expectedCompletionRevision：非负安全整数。
- expectedCompletionReportId 必须显式传 null 或报告 ID；缺省不等同“首次提交”。
- 禁止额外字段，尤其不能用 force、sourcePath 或旧 version 绕过服务端确认。
- Idempotency-Key 为 16—128 位字母/数字/下划线/短横线请求标识，与报告版本号、文件 hash 无关。
- 用户/课题归属、文件解析就绪、请求摘要及版本冲突须在 P2 的确认事务中再验证；schema 校验不替代事务授权。

## 4. 本轮代码边界

新领域使用 ReportSubmission，不扩展旧 ReportVersion 作为兼容层。正式报告不存在上传失败状态：receiving/parsing/ready/failed/committed/reclaiming/reclaimed 属于准备记录。正式提交是否成功与后续 AI 任务状态分离。

统一能力策略接受服务端解析的 actor/project membership，只允许 active 管理员或该课题实际 owner。旧报告的分析与洞察分别使用自己的成功历史；已合法入队的活动任务复用，不因变旧中断。

查询纯策略使用课题提交序列解析最新与前序比较，不用阶段版本推断新旧；首份标记稳定，删除后自动回溯，缺失评分不当零。

新结构安装器与新状态机已由 native bootstrap 显式组合：完全空的新运行目录可初始化原生结构，旧/混合数据库则拒绝并保持不变；不执行历史数据迁移、回填或自动清理。排期字段随状态机保留，风险在后续查询层基于排期派生，不在状态机内另写 at_risk 状态。P4 已替换默认生产入口；旧纯模块仅在显式测试夹具中回归，不提供双模生产运行。

## 5. 验证记录

- 改动前：类型检查通过；报告显示、历史权限、删除选择相关 11 项基线测试通过。
- 新增验证：44 项通过（提交协议/能力10项、比较/标签7项、阶段状态机13项、SQLite约束10项、领域与SQL联测4项）。
- P0/P1 检查：npm test 全量672项通过。
- P2 新增37项通过：文件准备9、事务仓储10、HTTP/服务8、上传schema3、outbox4、真实文件组合联测1、跨进程并发2。
- 本轮项目写入/恢复新增20项通过：项目事务与HTTP8项、文件恢复/配额/CLI12项。
- P2最终检查：npm run lint 通过；npm test 全量729项通过，0失败、0跳过；git diff --check 通过。
- P3新增55项通过；P3交付时全量784项通过，0失败、0跳过；npm run lint、runtime构建、编译后Worker帮助命令和git diff --check均通过。
- 已验证：真实DOCX落盘/子进程解析、SQLite文件关闭后重开回执重放、两个独立进程争抢同库、确认接替冲突、审计/outbox/配额故障引发整体回滚、调度租约恢复与陈旧持有者隔离。
- 文件恢复已通过残留文件构造、删除后故障、连接重启、实际流写入暂停和解析晚到测试；CLI验证只在临时新库中运行。
- P2任务交接使用SQL测试消费者；P3已使用真实完整分析/洞察代码和受控provider网络响应联测，验证两个真实Worker子进程争抢、取消/迟到响应及恢复。未调用付费模型。物理断电、吞吐/锁等待和正式发布演练仍待后续验证。
- P4最终检查：npm run lint、runtime构建、隔离生产Web构建通过；npm test 843项（777原生+66离线夹具）通过，0失败、0跳过。浏览器完成响应丢失后关闭/重开同键重试、阶段推进、Range读取与移动布局验证，0付费模型调用。
- 以上 P0—P3 记录保留各阶段交付时状态；P4 已完成关键浏览器端到端验收，实际部署切换仍未执行。

## 6. P0/P1 主要输出

| 文件 | 作用 |
| --- | --- |
| modules/contracts/report-submission.ts | 严格提交协议与幂等键边界 |
| modules/projects/stage-domain.ts | 阶段/排期实体、初始化、计划冻结与数据不变量 |
| modules/projects/stage-workflow.ts | 跳阶段、完结/补交、序号分配、并发令牌与领域事件 |
| modules/reports/submission-domain.ts | 新报告提交身份及权限/操作契约 |
| modules/reports/submission-policy.ts | 管理员/负责人权限、删除保护、分析/洞察资格 |
| modules/reports/submission-query.ts | 全课题最新、动态前序比较、阶段内标签 |
| lib/db/stage-report-schema.ts | 仅用于新结构的显式SQLite安装器，不含迁移/兼容逻辑 |
| test/report-submission-policy.test.ts、test/report-submission-query.test.ts | 提交协议、能力和查询验收 |
| test/stage-workflow.test.ts、test/stage-report-schema.test.ts | 状态机及真实SQLite约束验证 |
| test/stage-report-foundation-integration.test.ts | 状态机输出与SQL约束兼容、接替与回滚联测 |

公共状态机入口为 modules/projects/stage-workflow.ts。P4 已挂接 app/api、根页面与默认 Worker，并通过隔离新数据库和生产构建验证；现有运行进程未重启，不能把代码状态等同于部署状态。

## 7. P5 隔离发布验收

1. 已用独立临时根、测试密钥和管理员验证原生初始化，不迁移或覆盖当前库。
2. 最终out/p5-verified-candidate中的Web、默认Worker、解析器和运维CLI已完成一致发布及独立Docker验收。
3. 906项回归、15张浏览器截图、真实SIGKILL/并发、BEGIN IMMEDIATE测量、编译版同路径恢复均通过。事务样本不冒充吞吐或生产SLO。
4. 实际切换依用户选择暂缓。完整身份、证据和操作手册见docs/project-stage-report-p5-acceptance.md。

## 8. P2 后端内核交付

### 8.1 主要输出

| 文件 | 作用 |
| --- | --- |
| modules/reports/upload-domain.ts | 准备记录、回执、文件及配额端口、结构化错误 |
| lib/db/report-upload-schema.ts | 准备记录、解析正文、幂等回执、审计、outbox 的原子安装器与约束 |
| lib/db/report-submission-repository.ts | 阶段初始化、实时授权、准备状态、确认事务和回执重放 |
| lib/documents/prepared-report-files.ts | 独立根目录、持久化、受限解析、大小/hash校验、仅清理自身文件 |
| lib/documents/report-storage.ts | 复用并保留原有流/ZIP/PDF防护；新增显式根目录及文件/目录fsync |
| lib/storage/submission-quota.ts | 复用公共全局/用户/课题配额，在同一事务内预留、消费与释放 |
| modules/reports/submission-service.ts | 在短事务外准备/校验文件；冲突不删除已准备文件 |
| lib/http/report-submission-handlers.ts | 已认证的准备、状态与确认处理器；严格参数、16KiB确认体限制及无敏感路径响应 |
| lib/db/report-submission-outbox.ts | 持久化租约、过期恢复、失败延迟重试；任务入库与投递确认同事务 |
| lib/reports/submission-runtime.ts | 显式组合上述组件，不导入默认数据库实例，不自动挂载路由 |

### 8.2 提交边界

1. 准备前从数据库再次确认管理员/负责人身份，预留现有配额，创建 receiving 记录；此时不分配正式版本、不改变阶段。
2. 网络接收和基础解析不持有写事务。文件创建、至多64KiB的块写以及最终重命名/同步，通过独立的小范围数据库mutation fence防止回收后恢复写入。文件与目录fsync后才允许ready；这些文件操作不是可随SQLite回滚的原子文件系统事务。
3. 确认先校验严格契约，并查询原请求回执。命中同一请求时直接返回原回执，不受当前阶段变化、准备TTL或临时文件离线影响；重用键但请求摘要不同则409。
4. 新确认在写事务外校验来源文件的regular-file、无符号链接、大小与SHA256；BEGIN IMMEDIATE内重新校验权限、归属、准备状态、过期、幂等与阶段令牌。
5. 同事务写入报告、解析正文、阶段/课题计数和成果指针、配额消费、准备提交状态、审计、outbox和不可变回执。任一环节失败全部回滚；不在事务内调用AI。
6. 同一准备记录不能通过另一个幂等键再生成报告。确认冲突保留ready文件，须获取新令牌明确重试；不会自动force或覆盖原成果。
7. outbox的enqueue回调只允许同步数据库任务入库，并与delivered状态原子提交；禁止把AI/网络调用放入该回调。P3已通过原生任务外键和独立Worker完成该消费链路，P4已将默认Worker切到同一原生组合。

### 8.3 HTTP 挂接约定

处理器已通过原生 server runtime 挂接 app/api，规范路径见 P4 切换记录：
- prepare：原始文件流，查询参数fileName，Content-Length可选；成功201并返回准备ID与解析摘要。
- status：仅准备记录本人且仍有报告写权限可查询，不暴露正文、文件键或配额预留ID。
- confirm：JSON与Idempotency-Key；新提交201，回执重放200，令牌/幂等冲突409。

宿主必须传入新结构数据库、私有存储根目录及可信会话解析器，并保留现有认证、CSRF/来源校验。app/api 已整体挂接新处理器；原生 client 只对完全空的新库初始化，旧/混合业务库拒绝且不自动迁移或改写。

本轮已收口P2的项目写入与文件恢复机制：repository.createProject/editPlan、runtime.projects及runtime.recovery已经组合；项目/成员/阶段/审计同事务，准备回收采用持久状态与租约隔离，对账保留知识库等公共账目。恢复命令默认只读，显式--apply才处置，详见 docs/project-stage-report-p2-recovery.md。

新增主要输出：modules/projects/stage-project-contract.ts、lib/http/stage-project-handlers.ts、lib/db/report-upload-recovery.ts、lib/documents/fenced-upload-writer.ts、lib/documents/upload-recovery-files.ts、lib/storage/submission-reconciliation.ts、lib/storage/submission-storage-audit.ts、scripts/recover-report-uploads.ts。

P3已完成真实Worker及准备文件维护调度。P4已完成页面和默认启动器接入，旧上传/改归属/原地替换入口以明确410/409关闭。原生启动边界拒绝旧/混合数据库且不改写当前业务库；没有在当前业务库上执行数据切换，也没有自动物理删除正式报告的任务。


## 9. P3 原生任务与执行 Worker

详细设计、命令、故障语义及验证范围见 docs/project-stage-report-p3-worker.md。

| 主要输出 | 作用 |
| --- | --- |
| modules/reports/submission-task-domain.ts、submission-task-ports.ts | 原生任务、冻结快照和中立执行契约 |
| lib/db/submission-task-schema.ts、submission-task-repository.ts | 版本化fresh schema、准入/代次、独立账本、调用检查点、取消/租约、成功发布与人工对账 |
| lib/ai/submission-admission.ts | 队列/提示词/洞察次数保护，显式DB冻结 |
| worker/submission-executor.ts、submission-pipeline-repository.ts | 完整分析/洞察执行、质量校验、已验收结果恢复，不伪造旧ReportVersion |
| worker/submission-runtime.ts、submission-index.ts | outbox消费、并发、心跳、退避、安全退出、P2维护与独立运行命令 |
| lib/db/submission-query-repository.ts、lib/http/submission-task-handlers.ts | 独立成功历史、动态前序比较和无敏感字段的注入式HTTP边界 |
| lib/reports/submission-processing-runtime.ts | P2/P3显式组合与schema检查，无默认库初始化 |

共享执行层作最小提取：modules/analysis/ports.ts、pipeline.ts及lib/ai/report-insight-agent.ts接收持久化正文/中立执行端口。P3交付时尚未切换默认路径；P4已完成默认路径切换，旧纯模块隔离回归，不新增历史协议兼容。

新增55项验证：快照/准入19、执行器16、任务事务12、真实DOCX及provider协议4、跨进程1、命令1、schema2。P3交付时总计784项通过。

## 10. P4 代码接入与隔离验收

详细路由、保留策略、配置和部署边界见 docs/project-stage-report-p4-cutover.md。

- [x] 原生 schema、server runtime、空库初始化与旧/混合库非破坏性拒绝。
- [x] WORKSPACE_API 全量挂接；可信会话、CSRF/来源保护与原生错误边界。
- [x] 根页面使用 WorkspaceApp；阶段分组、阶段内版本、当前成果、全局最近提交、历史与完整报告库。
- [x] 准备/显式确认、严格幂等重试；旧单步上传、改归属和原地替换关闭。
- [x] 原生文件读取、通知、独立分析/洞察任务、取消/重试、命名 SSE 与轮询。
- [x] 默认 Worker、runtime build 和维护入口原生化；正式及墓碑报告均保留，配额归属 submitted_by。
- [x] 隔离空目录、稳定测试密钥、私有根、管理员和编译后默认 Worker 启动验证。
- [x] 生产 Web 构建、类型检查、全量回归及桌面/移动浏览器关键流程。
- [x] P5隔离发布、事务性能样本、物理故障及同模型备份恢复演练。
- [ ] 正式环境切换：用户明确暂缓，未执行。

浏览器验证包含：登录、创建课题、两阶段计划、DOCX 准备、完结提交、服务端提交成功后人为丢弃响应、原命令/原幂等键重试且仅生成一份报告、推进后刷新仍默认空的当前阶段、Range 文件读取和当前完结报告删除保护。测试使用独立 Web/Worker/Chrome 子进程并在结束后关闭，不调用付费模型。

## 11. P5 交付

- scripts/p5-package.mjs与p5-package-container.mjs：新目标独占打包、产物身份、只操作自有容器、超时及凭证脱敏。
- scripts/p5-release-acceptance.mjs、p5-backup-restore.mjs：真实编译Web/Worker/解析器、受控模型成功/失败、原路径备份恢复、任务及模型调用状态一致性。
- scripts/native-backup.ts及lib/storage/native-backup*.ts：强制HMAC、独立密钥、写栅栏快照、数据库绑定文件hash/大小、无覆盖恢复。
- lib/storage/native-restore-guard.ts：按运行根隔离的持久中断标记；默认启动和备份拒绝半成品，不自动清除。
- test/p5-fault-acceptance.test.ts与scripts/p5-contention-benchmark.ts：真进程死亡/竞争、未完成调用不自动重放和实测BEGIN IMMEDIATE。
- components/workspace-report-board.tsx与research-workbench.tsx：按容器宽度布局，明确“查看最近提交”语义。
- README.md及Docker/P5指南：去掉旧库迁入、密钥隐式回退和不明旧镜像标签建议；本轮非正式上线。


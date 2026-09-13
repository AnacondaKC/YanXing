# P3：原生报告任务与 Worker

## 交付边界

本轮完成新 `ReportSubmission` 的真实分析/洞察执行链路，不把旧 `ReportVersion` 伪装成新报告，不写 `analysis_jobs`、`report_versions` 或旧洞察结果表。没有迁移、回填、双写或旧协议适配。

新运行组合为 `createSubmissionProcessingRuntime({ database, storageRoot, resolveActorId })`。它组合 P2 项目/上传/恢复能力、原生任务仓储、查询、注入式任务 HTTP 处理器和独立 Worker。数据库由宿主显式提供并初始化；版本/任务表不完整时拒绝启动。

当前未挂载 Next.js 新路由、未替换页面或旧默认 Worker 入口，也未操作当前业务数据库。P4/P5 整批切换前，不应把新 Worker 接到旧提交协议的运行库。

## 持久化与事务

- `submission_tasks`：报告、操作、代次、入队快照、阶段、取消请求、租约及终态；同一报告/操作最多一个 queued/running 任务。
- `submission_task_calls`：网络调用前写 started 意图，响应后记录 completed。保留调用身份、模型及起止时间，用于恢复与迟到响应隔离，不记录 token 用量。
- `submission_task_data`：事实、模块状态、各次 artifact 和部分快照；不写正式文件旁的 `.content.json`。
- `submission_task_results`：每次成功独立且不可覆盖；分析和洞察成功历史独立。新成功结果、首次成功标记、任务完成及审计同事务提交。
- `submission_task_dispatches`：outbox 事件与任务绑定；入队和投递确认同事务。

形式提交/阶段推进先于 AI。配置、模型、质量门禁和 Worker 失败均不得回退课题进度。失败重跑保留前次成功结果，首次成功标记不可重置。

## 入队与执行

1. 管理员或实际负责人可以写；每次新任务/手工重试重新验证身份及公共资格策略。相同操作的活动任务复用，不重复入队。
2. 最新提交可再次执行；历史提交按该操作自己的首次成功历史判断。分析成功不妨碍历史报告首次生成洞察。合法入队任务变旧后继续执行，Worker 不重复应用“最新才可再次入队”的限制。
3. 入队冻结提示词、评价上下文、模型运行参数及 API 密钥密文。保留提示词长度/上下文适配、全局/用户/课题队列限制；分析和洞察分别最多总成功 3 次（初次成功 + 最多 2 次重新生成），失败/取消不占成功额度。
4. 未选模型返回 MODEL_NOT_CONFIGURED，缺 API key 返回 MODEL_CREDENTIALS_MISSING，缺完整评价上下文保持 PROJECT_CONTEXT_INCOMPLETE，均为 HTTP 409；解密失败、损坏配置和未知数据库异常保持 HTTP 500。配置失败时 outbox 保持 pending 并退避，不新增最大次数丢弃意图，也不建立付费任务重试。已有阶段规划允许缺少排期/描述，但 AI 仍需完整评价上下文，不能由 Worker 猜测补齐。
5. P3 使用密文时必须显式设置 `YANXING_SETTINGS_ENCRYPTION_KEY`。入队和实际解密都失败关闭，不回退到默认库旁的本地密钥文件。运行时不读取新的可变模型/提示词来替换已冻结配置。
6. 需要调用 provider 时，先验证绑定根目录下正式文件的大小/hash及安全文件身份，再读取准备阶段已保存的不可变正文。分析执行完整页面模块、结构校验、质量门禁和重试；洞察执行现有真实生成器及内容校验。
7. 已验收的检查点可在重启后直接完成发布，不重新解析文件、解密配置或调用 provider。发布仍重新验证身份、质量和任务租约。

共享执行契约中 `reportVersionId` 字段只承载报告身份，值为原生 report ID；不构造旧 ReportVersion 实体，不落旧任务/结果表。比较不写入新分析的 `previousOverall`，而由查询即时计算。

## outbox 的含义

一次正式提交产生一次自动分析意图，含义是至少建立一次分析尝试，不是保证成功或不断重新生成。若用户已经手动启动过分析，事件绑定该尝试，即使它已失败/取消，也不暗中再启动一次付费请求。后续重试由用户显式发起并再次准入。

配置暂不可用时，事件保留 pending 并延迟重试。已逻辑删除的报告可以明确记为 REPORT_DELETED 后结束投递，不建立新任务。正式提交回执不会因此被撤销。

## 取消、失联与重试

- queued 可以立即取消；running 先记录 cancel_requested，仍阻止报告删除，直到 Worker 确认或租约回收将其置为终态。
- claim/renew 使用短事务、单一时间点和 token fencing；续租不能复活过期/取消任务，也不缩短已有有效租约。
- 无悬空调用且可恢复的任务按有界退避重新排队；已知质量失败直接终止。
- started 但没有完成响应检查点的调用标记为 AI_CALL_INCOMPLETE，不在同一任务中自动重复 provider 请求。
- 取消/过期后得到响应，只按原始调用身份记录完成，不能发布 artifact、复活任务或改写成功结果。
- 若进程永久丢失响应，原任务保持失败；用户可按正常业务资格手工重试，创建新 generation，原调用和成功历史保持不变。

## 查询与 HTTP 组合

`SubmissionQueryRepository.detail` 在一致读事务中返回阶段标签、公共能力、最新任务、独立成功历史、投递状态和动态比较；只加载当前/前序/最新三个相关报告身份，不扫描全课题的分析历史。

首份阶段提交永远不比较。其他报告选择前一个未删除的课题提交，不跨过“无评分”报告；没有评分就不返回差值，不按 0 计算。分析重跑失败时仍使用前次成功评分。

注入式处理器提供 start/retry/cancel/status/detail。响应不暴露冻结密钥、文件路径、sourceKey 或 leaseToken。逻辑删除继续由同一个领域删除策略保护；正式物理文件没有新增自动删除。

## 运行命令

必须先在独立的新运行目录，由宿主建立公共鉴权/设置/配额 schema，再显式安装 stage-report、report-upload、submission-task schema。安装器是 fresh-only，不是升级脚本，不会自动处理当前业务库。

```bash
node scripts/build-runtime.mjs
node .runtime/worker/submission-index.mjs --help
node .runtime/worker/submission-index.mjs \
  --database /absolute/new-data/yanxing.sqlite \
  --storage-root /absolute/new-data/reports \
  --once
```

命令拒绝缺省数据库、不存在的数据库及非 P3 schema；已绑定根目录必须一致。`--once` 处理一次有界批次（最多当前并发数），不是清空所有队列。去掉该参数才持续轮询；持续模式同时每分钟调用一次 P2 准备文件恢复。SIGINT/SIGTERM 停止领取并等待在途任务安全退出。

运行过程遵守现有 `YANXING_WORKER_*` 并发、租约、轮询及恢复退避配置。此轮只在临时新库运行一次性命令，没有启动常驻进程或付费请求。

## 验证

- P3 新增 55 项：准入/快照19、执行器16、任务事务12、真实文件与受控 provider 协议联测4、跨进程争抢1、命令1、schema2。
- 全量 784 项通过，0失败、0跳过；类型检查、runtime 构建及 `git diff --check` 通过。
- 已覆盖真实 DOCX 落盘/解析、outbox 到完整分析/洞察链路、冻结设置、质量重试、调用完成记录、取消/租约迟到、恢复不重复调用、手工新代次重试、动态比较和两个真实子进程争抢同一任务。
- provider 网络响应由测试控制：验证真实请求/响应协议和处理代码，不等于调用真实付费模型，也不等于物理断电、吞吐、浏览器或部署验收。后者仍在 P4/P5。

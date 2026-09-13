# P4 原生阶段—报告切换说明

> **当前状态：P4 原生接入与隔离验收已完成，实际部署未切换。** 本文记录原生接口、启动边界、关闭的旧协议与验证范围；它不是历史数据迁移指南，也不是 P5 发布完成声明。

本文中的“原生”指 project_report_state、project_stages、report_submissions、report_uploads 和 submission_task_* 这一套模型。默认 Web `getDatabase()` 与默认 Worker（`worker/index.ts` → `worker/runtime.ts`）已切到该 schema；显式 CLI 仍是 `worker/submission-index.ts`。根页面与 canonical HTTP 路由已挂接原生模型。

## 1. 运行与数据边界

- 本说明不停止或重启任何现有 Web/Worker 进程。
- 本说明不切换当前运行中的 YANXING_DATABASE_PATH，也不对现有数据库或文件执行改写、回填、删除或搬迁。
- 当前业务数据尚未切换到原生模型。不要把原生 Worker 指向仍含旧报告结构的数据库；旧数据库应保持原状，另行准备新的空运行目录。
- 原生 API 必须通过可信会话解析 actor；客户端提交的 projectId、角色、source path、阶段状态和并发令牌都不能代替服务端事务校验。
- 本轮已完成类型检查、生产构建、全量回归与关键浏览器端到端；包括提交成功后丢失响应的受控验证。尚未执行目标环境部署、完整性能/物理故障与备份恢复演练。

## 2. 新的 canonical API map

接口名称和路径以 modules/contracts/submission-workspace.ts 的 WORKSPACE_API 为准。所有路径参数应按 URL 组件编码；分页参数是 limit、offset，offset 默认 0，超过允许范围返回分页错误。除文件流外，错误响应统一为 JSON：error、code，必要时附带 details。

### 2.1 课题、研究计划和查询

| 方法与路径 | 请求 | 成功响应 |
| --- | --- | --- |
| GET /api/projects | query: limit、offset；默认 100，最大 100 | WorkspaceProjectListResponse：projects、total、limit、offset、hasMore |
| POST /api/projects | JSON StageProjectCreate：title、objective、description、ownerId、可选 collaboratorIds、stages[]；每个 stage 的 id/title 必填，description/plannedStartAt/plannedEndAt 在传输契约中可选；AI 分析准入另要求完整评估上下文 | 201，WorkspaceProjectDetail |
| GET /api/projects/:projectId | 可选 query: stageId、reportId、source；source 为 current_stage、latest_submission、stage_completion、explicit | 200，WorkspaceProjectDetail |
| PATCH /api/projects/:projectId | JSON WorkspaceProjectSafeEdit：expectedUpdatedAt，以及可选 title/objective/description；仅允许这些课题字段 | 200，更新后的 WorkspaceProjectDetail |
| PUT /api/projects/:projectId | 不接受旧的整对象写入 | 409，PROJECT_FIELD_RETIRED |
| DELETE /api/projects/:projectId | 无 | 409，PROJECT_RETENTION_REQUIRED；当前版本不提供课题删除 |
| GET /api/projects/:projectId/stages | 无 | 200，WorkspaceStagesResponse：workflow、stages、latestSubmissionReportId、currentCompletionByStage |
| PATCH /api/projects/:projectId/stages | JSON StagePlanEdit：expectedPlanRevision、nextStages[]；nextStages 使用阶段对象，不使用 milestones | 200，WorkspaceStagesResponse |
| GET /api/projects/:projectId/stages/:stageId/reports | query: limit、offset；默认 50，最大 100 | 200，WorkspaceReportListResponse |
| GET /api/projects/:projectId/reports | query: limit、offset；默认 100，最大 100 | 200，WorkspaceReportListResponse，按 submissionSequence 查询 |
| GET /api/projects/:projectId/reports/history | query: limit、offset；默认 20，最大 100 | 200，WorkspaceHistoryResponse：groups、timeline、currentStageId、latestSubmissionReportId、currentCompletionByStage 及分页字段 |

POST /api/projects 的 canonical stages 至少有一个阶段；阶段 id、标题、日期和描述按 modules/projects/stage-project-contract.ts 校验。创建请求中 ownerId/collaboratorIds 只用于初始化成员；之后成员变更走现有管理员成员接口，计划变更走 /stages。

### 2.2 文件准备、确认和报告查询

| 方法与路径 | 请求 | 成功响应 |
| --- | --- | --- |
| POST /api/projects/:projectId/report-uploads | 原始文件流；query 必须有 fileName；Content-Length 可选，Content-Type 用于文件类型边界 | 201，WorkspaceUploadStatus：id、projectId、status、fileName、createdAt、expiresAt、可选 reportId/errorCode/preview |
| GET /api/projects/:projectId/report-uploads/:uploadId | 无 | 200，WorkspaceUploadStatus；不得暴露 source_key、绝对路径或配额预留 id |
| POST /api/projects/:projectId/reports | JSON ReportSubmissionCommand，且必须有 Idempotency-Key 请求头 | 新确认 201，WorkspaceConfirmResponse：receipt、replayed=false；同一幂等请求回放 200、replayed=true |
| GET /api/projects/:projectId/reports | 无额外 body；使用 2.1 的项目报告列表契约 | 200，WorkspaceReportListResponse |
| GET /api/reports | query: limit、offset；默认 20，最大 100 | 200，WorkspaceReportListResponse；只列出未逻辑删除提交 |
| GET /api/reports/:reportId | 无 | 200，WorkspaceReportDetail：阶段/提交标签、能力、比较、分析/洞察任务与独立历史 |
| GET /api/reports/:reportId/file | 无 | 原生报告源文件的二进制响应；服务端通过 report_submissions.source_key 和绑定的私有根解析，不接受客户端路径 |

ReportSubmissionCommand 的字段必须恰好为：

- uploadId、stageId、reportKind（update 或 completion）。
- expectedPlanRevision、expectedWorkflowRevision、expectedCompletionRevision，均为非负安全整数。
- expectedCompletionReportId 必须显式传 null 或报告 id；缺省不表示首次提交。
- Idempotency-Key 必须匹配 16—128 位字母、数字、下划线或短横线。
- 请求体只允许上述字段；不得添加 force、sourcePath、旧 version 或其他绕过字段。

准备和确认是两个阶段：准备阶段只创建 receiving/parsing/ready/failed 等 report_uploads 状态，不创建正式报告；确认阶段在短事务内再次校验 actor、课题归属、文件状态、幂等摘要、阶段和并发令牌，成功后才创建 report_submissions、正文、配额消费、审计和 outbox。

### 2.3 报告删除、分析和洞察任务

| 方法与路径 | 请求 | 成功响应 |
| --- | --- | --- |
| DELETE /api/reports/:reportId | JSON { reason: string }；reason 长度 1—500，额外字段拒绝 | 200，{ ok: true, reportId }；执行逻辑删除 |
| PATCH /api/reports/:reportId | 任意旧归属修改 body 均不接受 | 409，REPORT_STAGE_IMMUTABLE |
| PUT /api/reports/:reportId | 任意源文件替换 body 均不接受 | 409，REPORT_SOURCE_IMMUTABLE |
| POST /api/reports/:reportId/analyze | 无 body | 新任务 202，{ job, reused:false }；活动任务复用 200，{ job, reused:true } |
| POST /api/reports/:reportId/insight | 无 body | 新任务 202，{ job, reused:false }；活动任务复用 200，{ job, reused:true } |
| GET /api/reports/:reportId/insight | 无 | 200，{ insight, generating, job } |
| GET /api/jobs/:jobId | 无 | 200，{ job, analysisTask, insightTask, progress } |
| POST /api/jobs/:jobId/cancel | 无 | 200，{ job }；运行中先请求取消，终态前不能删除报告 |
| POST /api/jobs/:jobId/retry | 无 | 200，{ job }；按原生任务代次重新准入 |
| GET /api/jobs/:jobId/events | 可选 after query 或 Last-Event-ID 请求头 | text/event-stream；事件来自 submission_task_events，最多 30 分钟，每个用户最多 20 条并发流 |

分析和洞察是两个独立的 submission_tasks operation。它们分别拥有准入、活动任务、generation、成功时间戳和 submission_task_results 历史；提交报告不会隐式把两者合成一个旧 job，也不会写 report_insights。旧报告是否已经成功分析，不会替代该报告的洞察成功历史，反之亦然。

### 2.4 通知和总览

| 方法与路径 | 请求 | 成功响应 |
| --- | --- | --- |
| GET /api/notifications | query: limit、offset；默认 40，最大 100 | WorkspaceNotificationList：notifications、total、unreadCount、limit、offset、hasMore |
| PATCH /api/notifications | JSON { all?: boolean, ids?: string[] }；ids 最多 100；all 与 ids 遵循现有标记规则 | 200，{ marked } |
| GET /api/overview-stats | 无 | WorkspaceOverview：native submittedReportCount、completedStageCount、jobStats、trends、recentReports、activityReports、recentKnowledge |

通知、用户、成员、知识库、存储配额和 AI 设置仍使用保留的共享表与接口；它们不能重新引入旧报告链路或旧项目计划字段。

## 3. 已关闭的 legacy protocols

以下不是兼容输入，不应再由页面、脚本或 API 调用：

1. **单步原始上传已关闭。** 对 /api/projects/:projectId/reports 发送二进制并携带 X-File-Name、X-Milestone-Id、X-Report-Delivery-Type 的请求返回 410、UPLOAD_PROTOCOL_RETIRED。该路径现在只接收 JSON 确认；必须先 POST report-uploads，再 POST JSON 确认。
2. **旧计划字段已关闭。** milestones、milestones_json、milestoneId、deliveryType、progress、stage、status、reportIds 不能作为旧计划或旧项目状态写入。创建计划使用 stages，计划编辑使用 StagePlanEdit.nextStages 和 expectedPlanRevision。
3. **报告归属修改已关闭。** PATCH /api/reports/:reportId 不再改变阶段、负责人或 delivery type，固定返回 REPORT_STAGE_IMMUTABLE；正式提交的 stageId/stageVersion 不可变。
4. **源文件原地替换已关闭。** PUT /api/reports/:reportId 不再覆盖 source_key、hash、正文或文件，固定返回 REPORT_SOURCE_IMMUTABLE。替换需求必须形成一次新的提交，不能在历史页制造隐式替换。
5. **旧 ReportVersion/全局 version 链已关闭。** 新接口不接受 previousVersionId、currentAnalysisId、旧报告版本号或 sourcePath；不读取或写入 report_versions、report_facts、analysis_jobs、analysis_module_states、analysis_artifacts、analysis_snapshots、job_events、report_insights、report_insight_reservations、ai_budget_ledger。
6. **不提供隐藏双写或旧请求适配器。** 报告提交、任务、分析和洞察只写原生表；旧 URL 可以复用为路径，但请求体、状态码和语义必须遵循本文件的原生契约。

## 4. 原生删除与保留策略

- DELETE /api/reports/:reportId 必须提供 reason。服务端再次校验管理员/课题负责人权限、报告归属、当前完结成果保护和活动任务；不满足条件返回相应 403/409。
- 允许删除时只更新 report_submissions.deleted_at、deleted_by、deletion_reason，并保留文件、正文、成功结果和审计历史；本期不提供恢复入口。
- 当前完结报告或仍有 queued/running 任务的报告不能删除。删除不是物理清理，也不会重排 submissionSequence。
- DELETE /api/projects/:projectId 在确认可见后固定返回 409、PROJECT_RETENTION_REQUIRED。当前版本不级联删除课题下的报告、任务、文件或知识资料。
- 不自动清除正式报告物理文件。准备记录的过期回收、文件对账和显式 recovery --apply 是单独的运维边界，只处理准备记录，不把正式报告当作临时文件。
- `runStorageMaintenance` / `pnpm storage:reconcile` 不得 unlink 报告根下任何候选文件（已提交、墓碑、未知/隔离一律保留）。报告配额走 `reconcileSubmissionQuota`：全部 `report_submissions`（含 `deleted_at`）按不可变 `submitted_by` 记账，并同步 `report_uploads` 的持久预留；不得按当前课题负责人改记，也不得因墓碑或宽限期删除 allocation。知识库与 tmp 孤儿清理仍有效。

## 5. Fresh default bootstrap 与 schema rejection

### 5.1 空目录初始化

- 默认数据库路径为进程工作目录下的 storage/yanxing.sqlite；设置 YANXING_DATABASE_PATH 时使用其绝对解析路径。
- getDatabase() 对完全空的数据库文件执行原生 fresh bootstrap：保留的 users、sessions、projects、project_members、knowledge_items、通知、设置、配额表，加上 native_schema_identity、project_report_state、project_stages、report_submissions、report_uploads、report_submission_* 和 submission_task_*。
- native_schema_identity 的 schema 名称为 yanxing-native-p3，绑定当前版本 checksum；submission_storage_root 记录原生报告存储根。
- fresh bootstrap 只适用于空文件/空目录。它不是历史迁移，不回填旧表，也不把旧报告转换成新提交。即将进行的 Web 构建与浏览器验收不得改写、删除或“修复”现有业务库。
- checksum 绑定的是共享 SQL、identity SQL、默认品牌文案以及 P0/P2/P3 的实际 schema SQL 导出，不是标记词或 `function.toString()`。启动时还会核对必要列、索引和触发器。
- 自定义 `YANXING_DATABASE_PATH` 时，报告/知识库/临时/品牌根从该数据库父目录派生，不会自动指向旧 `cwd/storage`。默认路径 `<cwd>/storage/yanxing.sqlite` 仍使用 `<cwd>/storage/{reports,knowledge,tmp,branding}`。
- `pnpm test`当前只启动一个native测试组；旧repository/job-processor客户端别名及legacy preload已删除。旧库拒绝通过最小inline夹具验证，生产`getDatabase`和测试都没有双模兼容开关。

### 5.2 失败关闭

数据库分类或原生校验失败时不写入、不删除、不改名、不修复：

| code | 条件与处理 |
| --- | --- |
| LEGACY_DATABASE | 发现 schema_migrations、report_versions、analysis_jobs、report_insights、ai_budget_ledger 等旧结构标记；停止并使用全新空目录 |
| INCOMPATIBLE_DATABASE | 非空但没有完整原生身份，或缺表、缺列、缺索引、缺触发器、任务 schema 不完整 |
| IDENTITY_MISMATCH | native_schema_identity 名称/checksum 与当前原生版本不一致 |
| STORAGE_ROOT_MISMATCH | 数据库记录的 submission_storage_root 与本进程报告根不一致 |

API 启动边界将这些 NativeSchemaError 映射为 503 JSON { error, code }；页面启动边界返回安全的 503 页面。错误响应不泄露路径、SQL、密钥或数据库内容。旧库保持原状，不能以启动参数要求本版本自动迁移它。

## 6. Native Worker、配置、密钥与私有根

### 6.1 Worker 入口

默认 Worker 入口是 worker/index.ts，加载 worker/runtime.ts：对空库走 getDatabase() 原生初始化，对已安装原生库托管 createSubmissionProcessingRuntime，并写心跳与 YANXING_WORKER_READY_PATH。它不处理 analysis_jobs，也不调用旧 migrateDatabase/reconcileStorageQuota。

显式 CLI 仍是 worker/submission-index.ts，要求：

- 必须显式提供已经存在的 --database PATH 和 --storage-root PATH；可选 --once 只消费一轮。
- 该 CLI 只接受已安装的 submission_tasks/native schema；不执行初始化、历史迁移或旧 analysis_jobs 处理。
- PATH 必须是同一数据库绑定的报告根；不要用客户端输入或独立环境变量覆盖数据库绑定。
- 显式 CLI 编译到 .runtime/worker/submission-index.mjs。scripts/docker-supervisor.mjs 的默认入口仍为 .runtime/worker/index.mjs；build-runtime 将原生 worker/index.ts 编译到该路径，因此默认进程入口已在代码上切换。现有容器和进程未重建或重启，不能据此宣称部署已切换。

基于实际 package.json 和 Worker CLI 的可识别命令示例：

    pnpm db:migrate
    YANXING_ADMIN_PASSWORD='请使用安全注入' pnpm user:create
    pnpm exec tsx worker/submission-index.ts --database /srv/yanxing/storage/yanxing.sqlite --storage-root /srv/yanxing/storage/reports --once
    pnpm build:runtime
    pnpm build:docker
    docker compose up -d --build --wait

上述命令仅说明当前仓库已有的命令和原生 Worker 参数，不表示当前部署已经完成切换。Docker 无参数入口由 scripts/docker-entrypoint.sh 转交 supervisor，其默认 Worker bundle 已对应原生入口；本轮未运行 Docker 镜像发布或容器切换。

### 6.2 环境变量和模型密钥

- YANXING_DATABASE_PATH：Web、原生 Worker 和管理命令必须指向同一个新数据库文件。
- YANXING_KNOWLEDGE_STORAGE_ROOT：可选知识库根；它不改变原生报告根。
- YANXING_SETTINGS_ENCRYPTION_KEY：生产环境应设置稳定的密钥，并让 Web 与 Worker 使用同一个值。不要把它写入仓库、命令历史或日志。
- 原生冻结任务执行必须显式设置 YANXING_SETTINGS_ENCRYPTION_KEY；未配置时拒绝解密和执行，不回退到 .settings-key。共享设置存储仍保留其独立的本地密钥机制，但不能据此认为原生 Worker 已具备执行密钥。Web 与 Worker 应从首次初始化起使用同一稳定环境密钥。
- REPORT_MAX_UPLOAD_BYTES 必须与 Docker 镜像构建记录一致；改变上限时要重新构建镜像并重建容器。
- AI 队列、解析和 Worker 重试变量沿用 .env.example；模型 context/output 技术限制继续有效。

### 6.3 从数据库父目录派生私有根

lib/storage/runtime-roots.ts 从 getDatabasePath() 的父目录派生：

- 报告根：数据库父目录/reports。
- 临时根：数据库父目录/tmp。
- 默认知识库根：数据库父目录/knowledge；只有知识库配置可以通过 YANXING_KNOWLEDGE_STORAGE_ROOT 覆盖。
- branding 等其他运行时目录也位于同一运行目录下。

report_submissions 只保存受服务端控制的 source_key；报告文件服务、准备文件、恢复和对账均须限制在绑定的报告根内。改变数据库路径或报告根必须使用新的独立空运行目录并重新初始化，不能在线重绑现有原生库。

## 7. P4 接入清单与当前状态

以下是代码接入清单，不是 P5 发布清单：

- [x] 原生领域、阶段状态机、准备/确认事务、任务/调用/结果 schema 和显式 server runtime 已建立。
- [x] 空数据库原生初始化、旧/混合 schema 拒绝、identity checksum 和数据库绑定报告根校验已编码。
- [x] WORKSPACE_API 已全量挂接 app/api，保留可信会话、CSRF/来源保护和统一原生错误边界。
- [x] 根页面挂接原生 WorkspaceApp，阶段分组、默认选择、完整报告库、通知和任务视图不再依赖旧 Dashboard/milestones/reportIds；旧写入按钮已移除。
- [x] 原生文件读取、提交 outbox、独立任务状态/重试/取消/SSE 已挂接；事件流背压、终止清理与过期导航响应隔离已验证。
- [x] 默认 worker/index.ts 与 getDatabase()/pnpm db:migrate 已原生化；Docker supervisor 默认 bundle 与 runtime build 清单已核对。保留显式 recovery，正式及墓碑报告不自动物理清除。
- [x] 已在隔离空运行目录验证固定测试密钥、数据库父目录私有根、管理员、编译后默认 Worker 与生产 Web 启动。
- [x] 全量测试与桌面/移动浏览器关键流程通过；最终测试数量及复现命令见下文。后续P5隔离发布、真实争用/故障及编译版备份恢复已完成，见P5验收记录；正式切换仍未执行。

现有 live Web/Worker 进程在这项接入期间不会被本文重启，当前数据库和当前文件也没有在本文中 cut over。P5隔离验收已于后续完成；当时产物、906项测试和恢复证据见docs/project-stage-report-p5-acceptance.md，本轮964项复验见docs/post-v0.1.2-remediation-plan.md。正式部署依用户选择暂缓。

## 8. Disabled storage:relocate

scripts/relocate-storage.ts 的 storage:relocate 已关闭：除 --help 外返回退出码 1，并说明原生提交使用不可变文件身份和绑定的私有存储目录，不支持旧版绝对路径改写。

- 不要把 storage:relocate 当作历史迁移命令。
- 不要用它修改当前数据库、source_key、storage_allocations 或正式报告文件。
- 已有原生目录的离线搬迁需要单独审核；本 P4 接入不自动搬迁、不覆盖、不清除任何数据。

## 9. 本轮验证与复现

- npm run lint：通过。
- npm test：**843 项通过，0 失败、0 跳过**；其中原生测试 777 项，显式离线旧纯模块夹具 66 项。生产启动没有兼容开关。
- node scripts/build-runtime.mjs：通过，默认 Worker、原生初始化/恢复及维护命令构建成功。
- YANXING_NEXT_DIST_DIR=.next-p4-qa npm run build：生产 Web 构建通过，不覆盖现有 .next/.next-dev。
- node test/helpers/native-browser-smoke.mjs：通过。使用隔离数据库、报告根、心跳/ready 文件、默认编译 Worker、生产 Next 和本地 Chrome；结束时关闭自己启动的进程。
- git diff --check：通过。

浏览器验证：登录、创建课题、两阶段计划、DOCX 准备与显式完结；在服务器已提交后故意丢弃响应，经过“稍后确认→重新打开→重试同一提交”，验证两次请求的命令与幂等键完全一致，最终仅一份正式报告；推进后刷新仍默认空的当前阶段；当前完结删除返回409；文件Range返回206；桌面1440px、移动390px无横向溢出；无未处理JS异常，认证初始化没有请求风暴。

最近一次隔离证据：/tmp/yanxing-p4-browser-denkJp（8张截图；2次同键确认请求；3次认证初始化；0次付费模型调用）。完整回归日志：/tmp/yanxing-p4-final-tests.log。临时证据不进入生产数据目录。

这是P4浏览器流程记录；P5已追加权限/并发、物理故障、事务测量及编译版恢复验收。真实付费供应商连通性与生产容量不在本轮隔离范围内。未执行正式环境切换。


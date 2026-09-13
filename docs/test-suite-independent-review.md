# YanXing 测试体系独立审查报告

> 审查日期：2026-09-13。基准：`ffe4e7a` 加审查时未提交工作树，而非该提交的干净快照。
> 参考材料：`docs/test-suite-review.md`。分域独立审查后核验，不沿用其评级或因果解释。
> 本次仅新增本文，不修改业务、测试、配置或原报告；保留已有工作区改动。

## 1. 总体判断

**领域与持久化测试有实质价值，但默认绿灯的可信度受到顺序依赖、若干无效断言及 UI 行为门禁缺位的影响。应定点修复，不应推倒重建测试框架。**

当前已有纯函数、真实 SQLite、路由 handler 集成、真实进程/崩溃恢复、SSR 契约、手动真浏览器验收，以及 CI 中真实 Docker 部署验收。不能概括为“全部 mock”“没有 UI 测试”或“没有端到端验证”。

优先做四件事：修复顺序污染；强化关键断言；复用已有浏览器验收进入 CI；补运行时间与测试发现等门禁。不是先加框架、重排所有目录或追求测试数量。

**严重性**：P0 为已证实的重大生产安全/数据事故，本次无足够证据作此判断；P1 为直接损害核心测试信号或高风险契约保护的事项；P2 为后续应解决的覆盖与工程缺口；P3 为维护优化。测试缺口不等同生产漏洞。

## 2. 范围、方法与实测

### 2.1 范围

- `test/` 共 154 个文件：顶层正常测试 129 个（111 个 `.test.ts`、18 个 `.test.mjs`），22 个 helper，3 个 fixture。fixture 中另有一个 `.test.ts`，全树按后缀计数为 130，不能将其当作默认 runner 发现数。
- 全树清单/结构搜索；重点精读领域、DB/事务、Worker/并发、认证/授权/HTTP、前端状态与渲染、18 份 `.mjs` 测试；对照对应实现及 runner/package/两份 workflow/手动验收入口。
- 重点检查断言有效性、独立 oracle、正常/失败/恢复契约、状态隔离、异步生命周期、安全边界、发现规则和 CI 覆盖范围。
- 采用默认运行、固定种子重复、覆盖率、定向故障复现。备份/存储/解析与部分 stage/admission 测试是重点抽样和调用链核对，不声称每行、每分支均被精读；未做全仓变异测试或形式化证明。

### 2.2 运行记录

Linux、Node `v24.20.0`。工具 shell 没有 `pnpm` 命令，首次调用在测试启动前退出 127；随后直接运行 package 中同一入口 `node scripts/run-tests.mjs`，未安装或修改依赖。

| 验证 | 结果 | 解释 |
|---|---|---|
| 默认全量，第一次 | 退出 0，约 24 秒墙钟 | 未启用额外容器门控 |
| 默认全量，第二次 | 1,013 tests / 1,010 pass / 0 fail / 3 skip；25.719 秒 | 该次同时有类型检查负载，不作严格性能基准 |
| 固定种子 `4180762113`，两次 | 均为 1,000 pass / 10 fail / 3 skip；25.370 / 25.394 秒 | 同一失败集合：branding 2、health 3、proxy 5 |
| TypeScript lint 等价检查 | 退出 0 | 带 noUnused，关闭 incremental，避免改写缓存 |
| 小范围原生覆盖率探针 | 6/6 通过 | 当前 Node + tsx 可输出 TS 覆盖率 |
| 全量原生覆盖率，最终成功运行 | 1,010 pass / 0 fail / 3 skip；30.226 秒 | 原始行 84.28%、分支 80.81%、函数 87.35%；口径见第 5 节 |
| 完全不匹配的名称过滤 | 退出 0，显示文件级 tests 1 / pass 1 | 实际未运行该文件的 6 条业务用例 |
| 较长 TMPDIR 下单跑 runner 自测 | 6 pass / 1 fail | 嵌套 tsx IPC 路径报 listen EINVAL，不开 coverage 也复现 |

覆盖率实验还遇到两个前置问题：首次 `/tmp` 的 5.3GB tmpfs 空间不足，出现 ENOSPC，清理又遇 ENOTEMPTY；改用磁盘目录后暴露长路径问题；缩短磁盘临时目录后全量成功。这不构成业务失败证据。仅定向清理本次实验目录，未清用户其他临时数据。

**未运行**：Next 生产构建、真实 Docker job、真浏览器 smoke、P5 完整发布验收/压测、跨操作系统矩阵。CI 调用链由代码证实，本次不宣称这些现场验收已通过；未进行实际付费模型调用。

## 3. 值得保留的设计

1. **真实生产事务**：`test/report-submission-repository.test.ts:175-212` 调确认路径并注入数据库失败；P5 commit 后丢响应、SIGKILL、租约恢复和不重放外部调用均有实际断言。
2. **跨进程并发**：report-submission-concurrency、submission-task-concurrency、p5-fault-acceptance 确实用独立进程验证 WAL、唯一性、重放、fencing。
3. **前端纯逻辑有真价值**：提交 reducer、request guard、report reader 覆盖过期响应、幂等键保留、有界重读、取消和监听清理，应沿用而不是为换框架重写。
4. **安全对抗输入**：符号链接/撤权、配额回滚、key 不落快照、日志脱敏、备份篡改/恢复中断已有覆盖；文件解析并非只有 happy path。
5. **Docker CI 是真门禁**：`.github/workflows/ci.yml:27-39` 执行 `scripts/test-docker.sh`；后者 `:223-262` 真构建、启动、安全/API smoke、重建、杀 Web/Worker、破坏隔离库校验标记。发布 workflow `:16-20` 依赖此验证。
6. **runner 隔离有自证**：`test/run-tests.test.mjs:25-78` 真启动子 runner，验证存储隔离、宿主哨兵不变和工作区删除。不要绕过它直接运行会写默认 storage 的测试。

## 4. 分级发现与最小建议

### R1 · P1 · 用例内关闭共享 DB，产生确定性顺序依赖【运行证实】

**证据**：`test/proxy.test.ts:113-117`、`test/health.test.ts:236-264` 在故障用例中调用 `getDatabase().close()`。`lib/db/client.ts:63-85` 仍缓存该句柄，之后 `:94` 查询抛 database is not open。随机运行 proxy 5 项、health 3 项因此失败。

**建议**：优先将两个破坏性故障用例各自移到独立测试文件，沿用每文件进程隔离。不要为测试自动重开生产数据库：那会使刻意测试的 503 失效，也无法修复其他 runtime 持有的旧引用。只有确需同进程重建时，才提供受控 fixture/reset，处理连接、checksum、runtime 等全部关联状态。

**验收**：默认、单文件、固定种子和其他记录下来的种子通过；故障本身仍严格返回 503，正常路径可用。这里是测试故障注入污染，不据此宣称生产 DB 生命周期有 bug。

### R2 · P1 · 共享业务状态未复原，不只是连接问题【运行证实/静态扩展】

**证据**：`test/branding-settings.test.ts:93-105,146-156` 假设 revision=1；`:159-200` 保存并重置展示内容后 revision 已为 3。两个随机失败就是版本污染。`test/knowledge.test.ts:88` 对共享目录数量等于 1 的假设，与 `:91-105` 另一上传冲突；`test/model-settings.test.ts:31-38` 也依赖初始配置。

**建议**：品牌恢复完整初始行、版本和审计字段，或用逐例 fixture；不要盲目用外层事务包已有 BEGIN IMMEDIATE 的生产事务。上传按用例独占目录或断言前后差量。只把“目录只有一个文件”改成“文件存在”会丢失“失败上传未留垃圾”的原契约。

**验收**：读取/保存/重置可任意排序；失败上传不新增文件、reservation、allocation。不要求所有测试都重建 DB，按实际共享面定点隔离。

### R3 · P1 · 恒真断言无法保护详情契约【代码证实】

**证据**：`test/submission-workspace-routes.test.ts:194-196` 的 `assert.ok('analysisTask' in detail.body || true)` 对正常对象恒真。`test/user-optimistic-lock.test.ts:222-244` 自行把 listedDuringHash 置 true 后断言，不能证明写锁时点。

**建议**：第一处按真实响应 schema 断言必需字段、report/task ID 关系和状态，不只机械删 `|| true`。第二处删自赋值断言，以可控 hash 完成信号验证快更新获胜与最终持久化结果；保留已有 fast fulfilled / slow rejected 的有效断言。

**验收**：缺字段、错 ID 必红；慢 hash 尚未释放时快更新完成，慢更新随后只因版本冲突失败。常量协议快照不是同类“恒真”。

### R4 · P1 · 核心 UI 接线没有自动交互门禁，现有浏览器能力未接 CI【代码/调用链证实】

**证据**：`test/workspace-submission-ui.test.ts:544-597,845-917`、`test/original-workspace-mount.test.ts:5-17` 读源码检查 WorkspaceApp。`test/settings-loading.test.ts:80-89` 用字符串判断 lazy 重试。`test/dialog-focus.test.ts` 只测比较器，不执行 `components/use-dialog-focus.ts:18-73` 的键盘/effect/清理。

但 `test/helpers/native-browser-smoke.mjs:33-71,109-125,182-186` 已真启动 Worker/Next/Chrome，登录、上传、双击去重、丢响应后幂等重试；--ponytail 扩展已有键盘/焦点/取消/重试/动画。`project-configuration-browser.mjs:181` 也确实打包其 entry。缺口是未进入 CI，不是不存在 UI 测试。

**建议**：复用现有 harness，先接一条必跑 job。准备匹配的 .runtime、Next dist/release-root、Chrome 路径/版本、超时、无付费 provider、日志截图上传与清理。不能仅把命令塞进 CI 而不准备产物。先自动化提交重试、对话框焦点、设置失败重试，再逐条替换相关源码正则；保留纯函数与 SSR 权限/文案/结构测试。

**验收**：破坏实际监听、幂等键接线、重试按钮、Tab 方向必红；只调整 JSX 属性顺序/局部变量名不红。无需立即上第二套框架或把所有 effect 抽成服务层。

### R5 · P1 · 真实任务仓储的重要拒绝契约缺少专属负例，fake 与真实行为有差异【代码证实】

**证据**：`lib/db/submission-task-repository.ts:103-107` 拒绝模型不匹配/超次数/非法 call intent；`:233-236` 对不同内容覆盖 artifact 抛 ARTIFACT_IMMUTABLE；`:258-260` 拒绝错误存储根/非法 source。全 test 搜索未发现 ARTIFACT_IMMUTABLE、CALL_MODEL_MISMATCH、CALL_ATTEMPTS_EXHAUSTED、STORAGE_ROOT_MISMATCH、INVALID_SOURCE 的专属断言。

同时 `test/submission-executor.test.ts:249-260` 的内存替身对已有 artifact 静默 continue，beginCall 只检查未完成调用，不复现真实模型/attempt 约束。**这证明替身范围不同，不等于 executor 测试无价值；未做变异实验，不能断言删除任意守卫后全套必绿。**

**建议**：在真实 repository 测试补“同 artifact 同值可重放/不同值拒绝”“冻结模型不匹配”“attempt 边界”“root/source 非法”的小型负例，检查错误码及无写入。executor 的 fake 保持最小，但与测试用到的端口语义一致；不要复制整个 DB 实现。

**验收**：同值/异值分别有通过/失败控制组；临时破坏目标守卫应由对应测试捕获，而非依赖另一个约束碰巧拒绝。

### R6 · P1 · 超时预算与子进程回收没有闭环【代码证实】

**证据**：`scripts/run-tests.mjs:58-75,130-168` 未设默认 test timeout，等待 close 无总期限，仅转发到直接子 PID。`.github/workflows/ci.yml:13-25` verify 无 timeout-minutes。`test/job-events-stream.test.ts:66-91` 等预期事件无 deadline；`test/helpers/p5-native-harness.ts:367-390` IPC helper 无自身 deadline。

不是“全链路无超时”：P5 故障用例、很多 spawnSync、部署等待、Docker job 已有限制。

**建议**：先给 verify 合理上限；给 SSE/IPC 的具体等待加 timeout 与 abort/reader.cancel/进程退出回收。runner 加合理默认上限，重测试显式覆盖。真进程测试验证 TERM→必要时 KILL→等待退出→删除工作区。

**验收**：进程存活但不 ready、SSE 永不出下一条、忽略 TERM 时有界失败，有诊断且无残留。不要用 --test-force-exit 隐藏泄漏，或无条件重试失败套件。

### R7 · P2 · 安全 API 的路由组合/反向用例仍不完整【覆盖缺口，不是已证实漏洞】

- **登录**：`app/api/auth/login/route.ts:18-43,49-62` 的 body 408/413、账号失败限流、认证繁忙 503、两类 Cookie 属性未被默认 suite 的路由专测钉住。服务层 auth 测试与 Docker 正常登录不能替代这些失败分支。补登录失败阈值、成功 Cookie（session HttpOnly、csrf 可读、生产 Secure/SameSite）、busy/非法 body；登录/logout 的真实组合需经 proxy。
- **任务取消/重试**：`test/jobs-cancel-route.test.ts:39-60` 主要是 owner；`lib/http/submission-workspace-handlers.ts:194-212` 有 actor/job 的接线，默认路由层未见完整 outsider/只读/停用/撤权矩阵。补拒绝码，并验证任务状态、generation、通知无变化。不能将“非成员可读取报告”当漏洞：项目已有所有登录用户读报告的明确契约。
- **文件下载**：`app/api/knowledge/[knowledgeId]/file/route.ts:20-49` 的登录、路径约束、磁盘大小、流式响应、限流和错误映射不在本次默认覆盖表；报告下载也需要从 service 扩到 route。补缺失文件、符号链接、撤权时序、响应头/字节、流中断。Range 是应先确认的产品契约，不能无依据要求必须返回 206。
- **CSRF**：多数 handler 测试直接调用路由，绕过 proxy。补“缺失/不匹配 token、跨 Origin、错误 Host、合法请求”的组合验证，并确认拒绝时不消耗业务副作用。已有正常 token 路径不是攻击失败路径的替代品。

**验收**：错误身份、凭据和数据均有精确拒绝原因及无副作用断言；真实 Docker/browser 的正常路径继续保留。

### R8 · P2 · runner 容许发现空集、过滤空集假绿【运行/代码证实】

**证据**：`scripts/run-tests.mjs:90-95` 仅顶层；`:57` 空集成功；`test/run-tests.test.mjs:151-174` 固化该行为。名称完全不匹配时 Node 将文件作为一项通过，实测 tests 1 / pass 1，不是六条业务用例。

**建议**：默认发现空集失败，输出发现文件数；CI 禁止未经验证的名称过滤。将来分目录要做发现一致性检查并排除 helpers/fixtures，不直接递归全树：fixture 中有故意失败的 runner probe。用真实用例事件确认过滤是否选中；简单总 pass 下限不够可靠。

当前正常 129 文件均在顶层，这是门禁脆弱性，不是已漏跑一批顶层测试。

### R9 · P2 · 长 TMPDIR 被嵌套放大，tsx IPC socket 创建失败【新增，运行证实】

**证据**：`scripts/run-tests.mjs:16,30-37` 将临时目录置于 workspace/tmp；`test/run-tests.test.mjs:41-56` 再启动同 runner。长磁盘 TMPDIR 下路径经两层追加后，报 listen EINVAL；不带 coverage 单跑仍 6 pass / 1 fail，短路径全量成功。

**建议**：保留临时空间私有、可追踪和可清理，但避免嵌套路径持续增长。先给 CI 明确的短临时根；再评估 Node + tsx import 避开 CLI IPC，或为嵌套 runner 用短独立路径。改入口要保留参数转发、哨兵与信号自测，少删一层目录不保证所有长度都能解决。

**验收**：短/长 TMPDIR、嵌套 runner、失败清理通过，或启动前清晰诊断，不是深层 EINVAL。不要将其归因于业务或覆盖率工具。

### R10 · P2 · 部分测试的“集成”范围高于实际 oracle 能力【代码证实】

`test/stage-report-foundation-integration.test.ts:38-70,116-130` 自己执行 INSERT/UPDATE/BEGIN/ROLLBACK，保护 schema + 领域计划 + helper，不是生产确认事务。`test/deployment-smoke.test.mjs` 的 FakeYanXing 保护 smoke 客户端，不是产品本身。

**建议**：保留必要 schema 测试并准确命名；生产原子性由真实 report-submission-repository 调用守住。fake 用于客户端错误路径，由已有 Docker smoke 绑定真实兼容性。无需强迫所有单元测试连 DB。

**验收**：生产回滚/写序/幂等性被破坏时相应集成测试红；“smoke 客户端单元通过”和“真实部署通过”分开报告。

### R11 · P2 · 负例只约束失败，不约束失败原因【代码证实】

`test/submission-workspace-routes.test.ts:313-318` 接受 400 或 409；`test/project-owners.test.ts:123-124` 接受 200 或 202；`test/jobs-cancel-route.test.ts:29-36` 无 session，只断言不为 200，401/500 均能通过，不能证明退役表语义。

另：`test/core-contracts.test.ts:1131-1143` 构造 13 行热力图，却保留默认的一章报告详情（`:141-143`）。即使放宽行数，`modules/analysis/gates.ts:97-107` 的章节归属仍可能拒绝；accepted=false 不足以证明行数边界。这是静态推断，未做变异实验。

**建议/验收**：固定夹具状态后断言 status + code/path + 无副作用；合法多状态拆成情境，不机械禁止多状态。负例尽量只破坏一条规则，移除目标规则后专属测试须红，而不是另一校验兜底。

### R12 · P2 · 三个 opt-in 容器用例未被 CI 启用【调用链证实】

`test/proc-role-scan.test.mjs:21,78,125,142` 受 YANXING_PROC_ROLE_DOCKER_TESTS 控制，CI/脚本未设置，正是本次三个 skip。但 `test-docker.sh:247-248` 已真测 kill-recovery，不能称此能力完全没测。

**建议**：将三项独有的分类/祖先过滤断言接入现有 Docker job，或证明等价后减少重复。测试 `:18-19,174-178,299-303` 要求指定预置镜像且不 pull/build，须统一 CI 镜像 tag；只设置 env 不够。

**验收**：目标 job 执行这些断言而非 skip；快速套件允许可见且有归属的环境 skip，不为零 skip 让无 Docker 开发机全部失败。

### R13 · P2 · JS/TSX 检查、覆盖率口径没有纳入门禁【配置证实】

`tsconfig.source.json:6-20` 未将 mjs 测试、浏览器 tsx entry 作为根文件，也没有 checkJs。pnpm lint 是带 noUnused 的 tsc，有价值但不等于 JS 缺陷或 hooks 检查。间接 import 的 JS 可能参与解析，不能说所有 mjs 连解析都没有。

**建议**：实际保留的 tsx entry 纳入类型检查；runner/进程/browser harness 优先渐进 @ts-check 或局部 JS 检查。需要 hooks 规则再有针对性引入 linter。Prettier 是否存在不是安全门禁证据。覆盖率先做第 5 节的清单对账，再按关键模块防退化，不拍全局 70/80/90%。

### R14 · P3 · 重构摩擦和诊断成本可低风险下降【代码证实】

- `overview-loading.test.ts:288-327`、`repository-loading.test.ts:199-203` 长 SVG 黄金串与 sparkline-geometry 重叠：组件侧关注结构/空态/可访问性，几何保留独立 oracle。
- `graph-layout.test.ts:26-79` legacy 算法可作一次重写的差分参考，但共享生产几何函数，不是独立正确性证明；补极值/性质，确认迁移结束再删参考实现。
- `core-contracts.test.ts:25-40` 手写串行 Promise 队列优先以 runner 显式串行控制替代；全局 mock 自动还原，不立即重构整个 HTTP runtime。
- 循环、多进程、文件系统断言补 scenario/路径/stderr；简单 deepEqual 已有 actual/expected，无需全量加重复消息。
- 参数化用例名称应保留。把 12 条矩阵测试折为一个循环并未减少 12 次渲染，反而可能降低诊断力。

## 5. 覆盖率：已有实测，但不能制造另一个虚假绿灯

成功运行原始指标：**84.28% 行 / 80.81% 分支 / 87.35% 函数**，仅用于诊断：

1. 未加载文件没有自动以 0 计入分母，WorkspaceApp 未出现在默认覆盖表；不能宣称全仓达 84%。
2. 包含 scripts 及临时生成的 parser-worker fixture，正式门禁需明确生产路径与 fixture/产物排除。
3. 原生实验性覆盖率、tsx/打包 source map 的行/函数/分支需结合源码核对。高分支数不代表嵌套 effect 执行，更不代表断言能杀死错误。
4. 本次未将浏览器、Docker 和全部独立进程产物合并为统一指标。

| 模块 | 原始行 / 分支 / 函数 % | 意义 |
|---|---|---|
| lib/db/report-submission-repository.ts | 96.18 / 85.43 / 98.59 | 与真实事务测试一致，应保留 |
| lib/documents/knowledge-upload.ts | 90.29 / 54.65 / 73.68 | 不是无覆盖，重点查失败/回收分支 |
| worker/submission-pipeline-repository.ts | 82.86 / 59.29 / 92.59 | 后续关注 fencing、取消、失败组合 |
| lib/workspace-submission-client.ts | 68.53 / 74.42 / 50.00 | 请求适配/错误接线值得补测 |
| components/ui/select.tsx | 59.67 / 58.06 / 36.00 | 间接 SSR 不等于键盘验证 |
| components/ui/file-dropzone.tsx | 85.52 / 97.06 / 33.33 | 高行/分支不能证明拖放/重选事件 |
| components/use-dialog-focus.ts | 44.74 / 100.00 / 66.67 | 分支 100% 不等于 effect/键盘行为已验证 |

推荐：报告→生产清单对账→风险分支/函数未覆盖清单→精确补测→少量高风险变异验证。不要按“无直接 import”计算业务覆盖率。

## 6. 原报告核验与更正

| 原结论/建议 | 独立核验 |
|---|---|
| 固定种子4180762113失败10项 | **确认**，两次同集合；不外推为任意种子固定10–13项 |
| 4处getDatabase().close都是污染主因 | **不成立**。rate-limit.test.ts:13-16、http-dns-errors.test.ts:16-21 在 test.after；proxy/health 才是用例内关闭 |
| 限流桶跨测试累积解释proxy失败 | **本次不支持**，失败是关库；lib/security/rate-limit.ts:23-74 的桶实际在 SQLite，不是简单进程内 Map |
| 自动reopen或一个reset即可解决所有顺序失败 | **不成立**，品牌/模型/目录需各自恢复，reopen会破坏故障语义和旧runtime引用 |
| 没有真实UI，WorkspaceApp从未执行 | **应限缩为默认runner/CI行为层**。有真浏览器脚本，configuration entry 被 helper:181 打包，非完全无人调用 |
| worker/index从未执行，主循环只有fake | **全体系口径错误**。Docker CI跑真实编译Worker；默认suite也运行worker/runtime，health测试与coverage均证实 |
| docker-security-smoke、migrate没有测试 | **调用链被遗漏**，前者在Docker CI真执行，后者本次coverage表出现，不能等同零覆盖 |
| 六处全是恒真 | **分类过度**。固定协议值、事件集合成员、timeout选择函数可因生产改动失败；覆盖有限不等于逻辑恒真 |
| storage maintenance SQL注入失效会静默绿 | **不成立**，storage-maintenance.test.ts:540-563 明确 protectionReads===3，不匹配会红；实现耦合属实 |
| overview限流key改名仍绿 | **不成立**，submission-workspace-routes.test.ts:223-224 对真实请求断言429，key改名会失败；问题是内部key耦合 |
| knowledge-upload没有直接测试→零覆盖风险 | **不成立**，knowledge.test经路由执行，实测行90.29%；应查失败分支和下载路由 |
| parser只有正常路径，无损坏文件 | **不成立**，documents.test.ts:217-257 有伪造ZIP/膨胀/DTD，:278-286 写broken.docx并调解析入口 |
| 前五31.7s/121.5s=22.1% | **算术/汇总不自洽**，原表前五合计约26.8s才约22.1%；31.7/121.5约26.1% |
| 将worker-command的build移before可直接省数秒 | **未证明**，该测试:50已在36次spawn循环外，只build一次，移动位置不省构建 |
| 每类进程只留1–2条、直接SQL改租约过期 | **不宜照做**，source/compiled入口、环境加载、防写和真实租约恢复本身是契约；快层注入时钟，真边界保留代表性验收 |
| 全链路无超时 | **过度概括**，runner/verify/SSE/部分helper缺口属实，Docker/P5/很多子进程已有期限 |
| 三个容器用例默认skip且未接CI | **确认**，但“永久/静默”过重：日志列SKIP，相关kill-recovery在另一个真CI脚本存在 |
| no ESLint/Prettier、无消息断言均高优先 | **不认同优先级**，先修行为与信号，工具/消息数量不等同正确性 |

## 7. 性能与维护策略

第二次默认运行解析到1,011条成功计时记录（含suite汇总，非严格独立用例CPU时间），墙钟25.719秒，计时求和133.171秒。前五合计28.652秒，约占该求和21.5%；超过1秒的记录30条。存在并行、嵌套计时及负载，不将比例换算成可直接节省的墙钟。

应保留的慢路径：SIGKILL恢复、真实并发确认、source/compiled CLI fail-closed、备份CLI环境优先级。先分层记录耗时，反馈时间真成为瓶颈再拆slow job；不为“每条<100ms”删除跨进程价值。

固定sleep逐渐改成事件/IPC/状态条件，但真实跨进程租约恢复与纯时钟边界属于不同层。Worker续租抛错后abort是保守失败策略，若补测应先明确安全契约，不应仅凭“未重试SQLITE_BUSY”就建议自动重试或继续写入。

## 8. 整改顺序与验收

| 阶段 | 工作 | 完成标准 |
|---|---|---|
| 第一批：恢复信号 | R1/R2隔离、R3恒真、verify上限 | 默认/单文件/固定种子通过；故障注入仍真实；坏响应必红 |
| 第二批：关键契约 | R4浏览器job与产物、R5真仓储负例、R7安全矩阵、R11精确拒绝 | 提交/重试/焦点/安全接线实际破坏可被发现 |
| 第三批：工程门禁 | 具体等待回收、短TMPDIR、空集发现、容器skip归属、JS/TSX检查 | 干净CI与开发机明确知道哪些层运行/未运行 |
| 第四批：按证据补盲点 | coverage清单、持久化失败组合、少量变异验证 | 关键未覆盖分支下降，不只是测试数增长 |
| 持续维护 | 减少重复黄金串/过期协议断言、改善诊断、归并重复harness | 等价重构少误红，独立业务oracle仍保留 |

不要同步上线几十项结构性改动。每批保留原基线与独立验收，不用更大的测试平台替代最小可验证修复。

## 附录：复现命令与证据

在项目根目录执行；正常测试只走隔离runner，不直接操作现有storage。

```bash
# 默认基线
node scripts/run-tests.mjs

# 当前可复现顺序依赖，预期退出1
node scripts/run-tests.mjs --test-randomize --test-random-seed=4180762113

# 类型/lint等价检查，不写tsbuildinfo
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.source.json \
  --incremental false --noUnusedLocals --noUnusedParameters

# 覆盖率探针
node scripts/run-tests.mjs test/workspace-url.test.ts --experimental-test-coverage

# 名称无匹配仍显示文件级成功
node scripts/run-tests.mjs test/workspace-url.test.ts \
  --test-name-pattern=__audit_no_test_should_match__
```

全量coverage应使用有容量且短的私有TMPDIR。本次使用 /home/zheye/yr-XXXXXX 形态的mktemp -d目录，执行 --experimental-test-coverage 后定向清理；正式CI不硬编码个人home。

现场临时日志（不作为长期门禁产物）：

- `/tmp/yanxing-independent-review-baseline.log`
- `/tmp/yanxing-independent-review-random.log`
- `/tmp/yanxing-independent-review-coverage-final.log`
- `/tmp/yanxing-independent-review-long-tmp.log`

本文保留关键结果和复现方法；临时日志清理后应重新运行，而不是依赖历史数字。

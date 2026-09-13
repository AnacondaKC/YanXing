# 研行（YanXing）测试套件全面评审

| 项目 | 内容 |
|---|---|
| 评审范围 | `test/**`（129 个测试文件 + 22 个 helper + 3 个 fixture）、`scripts/run-tests.mjs`、`.github/workflows/ci.yml` |
| 评审方法 | 静态度量 → 全量运行 → **顺序随机化实验** → **逐用例耗时剖析** → 覆盖映射 → 抽样精读（含源码对照）→ 关键结论逐条复验 |
| 交叉复验 | 对两份外部评审的论断逐条实测：**属实部分已合并进本文**（见 §七、附录 B.3），**被证伪部分记入附录 A.2**，**纠正本文之处记入附录 B.1/B.2** |
| 评审基准 | `ffe4e7a feat!: adopt native stage-report submission workflow` |

---

## 一、总体结论

**这是一套领域逻辑扎实、命名规范、但隔离性已明显劣化、UI 验证能力缺失、工程门禁偏弱的中上等测试套件。**

它最可贵之处是：把「提交状态机 / 阶段工作流 / 配额与权限 / 恢复与幂等」这些真正会出事故的逻辑抽成纯函数并做了真实断言，还用真实子进程验证并发与崩溃恢复。

它最大的风险有两个，且互为因果：

1. **隔离性已被破坏**——随机顺序下 10～13 个测试失败，说明当前绿灯依赖"测试声明顺序"这一隐含前提；
2. **用字符串假装验证 UI**——1,062 行的前端控制器 `components/workspace-app.tsx` 从未被真正执行过，只有源码正则。这类断言 **重构必红、真 bug 必绿**。

| 维度 | 评级 | 依据 |
|---|---|---|
| 领域覆盖 | A− | 提交、阶段、配额、权限、恢复、并发、崩溃一致性均有真实断言 |
| 命名与可读性 | A | 880 个顶层测试名零重复，绝大多数是完整契约句 |
| 运行速度 | A | 全量 1,013 个测试约 24 秒（并行） |
| 执行效能 | B− | 前 5 个慢用例占全部用例时长的 **22.1%**；26 个用例 > 1 秒，其中 2 个可回收约 11～12 秒 |
| **隔离与确定性** | **C** | **随机顺序下 10～13 个失败；全量运行观测到 1 次 flake** |
| **UI 验证能力** | **D+** | 无 jsdom/RTL；事件、effect、焦点、错误边界一律不执行 |
| **断言强度** | **C+** | 存在 6 处恒真断言与多处"或状态"弱契约 |
| 断言诊断力 | C | 71% 的 `equal/ok/deepEqual` 无失败消息 |
| 工程门禁 | C | 无覆盖率、无超时、无 ESLint/Prettier；5,222 行 `.mjs` 零静态检查 |
| 可维护性 | B− | 109 处源码正则断言是重构摩擦的主要来源 |

---

## 二、基线事实（全部可复现）

```text
测试文件          130 个（112 × .test.ts + 18 × .test.mjs）
                  └ 112 含 test/fixtures/run-tests-probe.test.ts；顶层 test/ 下为 111
测试代码          23,049 行（另：helper 2,166 行 / fixture 3 个）
生产代码          36,588 行（app + lib + components + modules + worker）
测试/生产比       0.69 : 1（含 helper 共 25,215 行测试代码）
顶层 test()       880 个（循环生成后实际执行 1,013 个）
describe()        1 个（test/submission-admission.test.ts:238，正确使用 { concurrency: false }）
                  test.only 0 处    test.todo 0 处    test.skip 选项 3 处（见 P0-4）
断言总数          4,749 个（均值 5.4 个/测试）
全量运行          1,013 tests / 1,010 pass / 0 fail / 3 skipped / 24.2s
顺序随机化        三次运行 pass 997 / 1,006 / 1,000（失败 13 / 4 / 10）
固定种子复现      seed=4180762113 → 稳定失败 10 个（连续两次一致）
```

复现命令：

```bash
pnpm test                                                                   # 全量
node scripts/run-tests.mjs test/workspace-url.test.ts                        # 单文件 → 6 passed
node scripts/run-tests.mjs test/workspace-url.test.ts --test-name-pattern=restores   # 名称过滤 → 1 passed
node scripts/run-tests.mjs --test-randomize --test-random-seed=4180762113    # 顺序随机 → 10 failed
```

测试金字塔（按行数占比）：

| 层次 | 占比 | 说明 |
|---|---|---|
| 纯单元 | 47% | reducer、URL 编解码、几何计算、schema 校验 |
| 进程/系统 | 22% | 真实 spawn、真实 SQLite 文件、真实 DOCX/PDF、Docker 门控 |
| 组件渲染 | 17% | `renderToStaticMarkup` 首屏快照 |
| 集成（DB/IO） | 14% | 内存 SQLite + 路由 handler 直调 |

金字塔形状健康；22% 的进程级测试占比偏高，是运行时与不稳定性的主要来源。

逐用例耗时基线（解析 spec reporter 的 1,011 条时长记录）：

```text
全部用例时长之和     121,493 ms（远大于 24s 墙钟，因为文件间并行、文件内并发）
> 1000 ms 的用例     26 个
前 5 名合计          31.7 s = 全部用例时长的 22.1%
最慢单用例          7,181 ms
```

---

## 三、值得保留与推广的优点

以下不是客套，建议直接写进团队规范。

### 3.1 测试名就是行为契约，且零重复

880 个顶层测试名**无一重复**，绝大多数是完整契约句而非 "works / should be ok"：

- `'missing scores stay missing while zero remains a valid quality score'`
- `'conflict without fresh tokens cannot commit and does not fall back to old tokens'`
- `'crashed worker lease expires and fences stale acknowledgement from the recovered worker'`
- `'oversized or malformed confirmation is rejected without trusting Content-Length'`

这直接决定失败报告的可读性，是本套件最容易被低估的资产。

### 3.2 需求可追溯：测试名带验收用例编号

`report-submission-policy.test.ts` / `report-submission-query.test.ts` 直接引用设计文档的验收项（`docs/project-stage-report-engineering-design.md:539` 的 `AT-16`、`:584` 的 `Q-01`）：

```ts
test('AT19/30: latest submission may rerun even in an earlier stage with a smaller stage version', ...)
test('Q06: either active operation must finish or be cancelled before logical deletion', ...)
```

唯一瑕疵是**格式漂移**：文档写 `AT-16`/`Q-01`，测试写 `AT16`/`Q01`。建议统一并加一条自动校验。

### 3.3 真正的隔离启动器（且被自身测试覆盖）

`scripts/run-tests.mjs` 做了三件对的事：

1. 每个测试文件一个子进程（node:test 默认 `process` 隔离），子进程 `cwd` 指向 `mkdtemp` 出来的临时工作区；
2. 通过 `TEMP/TMP/TMPDIR` + `YANXING_DATABASE_PATH` + `YANXING_KNOWLEDGE_STORAGE_ROOT` + `YANXING_TEST_WORKSPACE_ROOT` 把落盘位置全部重定向出仓库；
3. `delete environmentForChild.NODE_TEST_CONTEXT`（`run-tests.mjs:43`）让 runner 自测不会被父上下文污染。

且它被自己的测试覆盖：`test/run-tests.test.mjs` 用真实子进程验证了退出码透传、信号转发后再清理、子进程启动失败仍清理工作区、`--tsconfig` 覆盖被拒绝——**这是很多项目完全缺失的"测试基础设施自身被测"**。

### 3.4 生产代码为可测性做了让步

`lib/config/environment.ts` 的 `runtimeConfig` 全部用 **getter 惰性读 `process.env`**，因此测试可以在 `import` 之后改环境变量而不必重启进程。

### 3.5 依赖注入而非全局 mock

`submission-executor.test.ts:403` 通过 `runModuleAgent: (input) => fakePageAgent(input)` 注入替身；`submission-admission.test.ts:31-43` 用 `context.after(() => database.close())` 逐测试关库。局部打全局 `fetch` 的地方都集中在确实面向网络的 HTTP runtime 层，属于合理范围。

### 3.6 内嵌 shell 函数的"抽取并真执行"

`test/test-docker.test.mjs:9-14` 把 `scripts/test-docker.sh` 里的 `UPDATE native_schema_identity ...` 抽出来在 `:memory:` SQLite 上真跑；`logs_show_migration_failure()` 被整段抽出用 `spawnSync('sh', ...)` 执行并断言 5 组日志分类。`proc-role-scan.test.mjs` 同样把 shell/mjs 胶水抽出来在容器里执行。**这是在无法模块化的脚本上做行为测试的教科书做法**——与纯正则断言有本质区别。

### 3.7 已抽出的纯逻辑层（最有价值的部分）

| 模块 | 测试位置 | 覆盖的关键风险 |
|---|---|---|
| `reduceWorkspaceSubmit` / `classifyCommitFailure` | `workspace-submission-ui.test.ts:598-999` | 重复提交、幂等键丢失、ack 后重新 prepare |
| `createLatestRequestGuard` | `use-latest-request.test.ts` | 过期响应覆盖、abort 监听泄漏 |
| `createRetryableLazyResource` | `retryable-lazy.test.ts:107-129` | 被放弃的 load 产生 unhandledRejection |
| `ConfigurationSaveSession` | `project-configuration.test.ts:28-190` | CAS 冲突、部分保存、首次提交后冻结 |
| `settleOverviewLoadState` | `overview-loading.test.ts:102-116` | 首次失败 vs 刷新失败的文案与数据保留 |
| 删除门禁矩阵 | `workspace-report-deletion.test.ts:40-100` | operation × status × cancelRequested × 拒绝码 |
| `formatBeijingDateTime` | `format-beijing-time.test.ts` | 时区、跨年、非法输入（注入时钟） |
| 权限**码**矩阵 | `report-submission-policy.test.ts`、`project-configuration-policy.test.ts:16-26` | 权限拒绝而非仅 HTTP 状态 |

### 3.8 崩溃一致性与并发用真实进程验证

- `report-submission-repository.test.ts:175-212`：用 TEMP TRIGGER + 配额陷阱验证**生产** `confirmSubmission` 的全量回滚；
- `p5-fault-acceptance.test.ts`：提交 commit 后 SIGKILL、WAL、重放、`context.after` 清理（`:209-216`）；
- `submission-task-concurrency.test.ts:19-40`、`report-submission-concurrency.test.ts`：真实多进程抢锁；
- `database-baseline.test.ts:140-158`：真实双连接可见性。

### 3.9 独立金标准而非自我复述

`submission-workspace-performance.test.ts:92-112` 用 **SQL 侧的独立实现**交叉验证 `runningAverageValues`/`cumulativeTrend`，而不是让生产函数和自己比。

### 3.10 安全相关的真实对抗性输入

`upload-limits.test.mjs` 用 `0.5`/`Infinity`/超限 1 字节等非法值；`submission-report-file.test.ts:43-66` 覆盖哈希校验、符号链接、微任务级撤权（TOCTOU）；`submission-admission.test.ts:155-158` 验证冻结快照丢弃明文 API Key；`env-bootstrap.test.mjs` 断言密钥绝不出现在 stdout。

### 3.11 其他值得保留的细节

- `docker-runtime-config.test.mjs:57-66`：Dockerfile 的 `chmod` / `USER node` / 无 `chown=node:node` **顺序**断言，是真实权限契约；
- `docker-assembly.test.mjs` 真跑 `assembleDockerRuntime` 并断言密钥与缓存不被打进镜像；
- `docker-supervisor.test.mjs:538-561` 用"忽略 SIGTERM 的子进程"验证强杀与无残留 PID；
- `submission-worker-command.test.ts:67-72`：拒绝的 CLI 调用后数据库字节级不变（fail-closed）；
- 文案常量化：`insightEmptyCopy` / `SKIPPED_EMPTY_COPY` / `workspaceErrorCopy`，测试断言常量而非散落字面量。

---

## 四、P0 关键问题（建议本迭代内解决）

### P0-1 隔离性已被破坏：随机顺序下 10～13 个测试失败

**证据**：

```text
--test-randomize 第 1 次： pass 997  fail 13  skipped 3
--test-randomize 第 2 次： pass 1006 fail  4  skipped 3
--test-randomize 第 3 次： pass 1000 fail 10  skipped 3
--test-random-seed=4180762113（连续两次）：fail 10，失败集合完全一致
```

失败集中在两类，根因清晰：

**(a) 单个测试文件内共享同一个模块级 SQLite 库**——文件用一次 `mkdtemp` 建目录、设一次 `YANXING_DATABASE_PATH`，文件内所有测试共用：

- `proxy.test.ts`：`proxy allows exact /api/health without a session...`、`login can load public brand settings...`
- `health.test.ts`：`web health GET returns only status...`、`worker heartbeat writes JSON...`、`worker poll loop writes a heartbeat...`
- `branding-settings.test.ts`：`admin branding API requires administrators...`、`public branding starts with generic defaults...`
- `model-settings.test.ts`：`model channels preserve multiple profiles...`、`prompt settings persist versions...`
- `knowledge.test.ts`：`knowledge upload owns stored paths, bounds files, and hides internals`

**(b) 全局限流桶跨测试累积**——`rate-limit.test.ts` 及若干路由测试共用进程内限流状态：

- `analysis start uses AI-task rate limits`
- `insight mutations are rate limited after CSRF validation`
- `native preparation retains upload rate limits without sharing the confirmation bucket`
- `task retries do not consume the independent insight-start bucket`
- `native retry cannot bypass the strict AI mutation limiter`

**影响**：当前绿灯只代表"按声明顺序执行时绿灯"。任何重排、局部运行或未来引入并发都会产生不可解释的失败，排查成本随时间指数上升。**已定位到主因（比"共享 SQLite"更具体）**：4 个文件对**共享的全局连接**直接调用了 `getDatabase().close()`——

| 位置 | 在文件中的序号 | 是否出现在随机化失败名单 |
|---|---|---|
| `proxy.test.ts:114` | **最后一条** | ✅ `proxy allows exact /api/health...` |
| `health.test.ts:248` | 末段 | ✅ `worker heartbeat writes JSON...` |
| `rate-limit.test.ts:14` | 首段 | ✅ 全部 4 条限流用例 |
| `http-dns-errors.test.ts:17` | 首段 | — |

而 `lib/db/client.ts:83-84` 把连接缓存进 `globalThis`，**且没有任何重置入口**：

```ts
databaseGlobal.__yanxingDatabase = database
databaseGlobal.__yanxingDatabasePath = databasePath
```

`openEnsuredDatabase()` 一旦命中缓存就直接 `return cachedDatabase`（`:67-72`），**不会检查它是否已被 close**。于是"关闭"只关掉了连接，缓存里留下一个**已关闭句柄**，同进程后续每一次 `getDatabase()` 都会拿到它并抛错。

所以这些用例能通过，纯粹是**"声明顺序恰好让 close 排在最后"**——这解释了为什么 `proxy` / `health` / `rate-limit` 三个文件同时出现在随机化失败名单里，也说明**修 P0-1 的第一刀不是加用例，而是给 `lib/db/client.ts` 加 `closeDatabaseForTesting()`**（关连接并清 `globalThis` 缓存，或让 `openEnsuredDatabase` 检测已关闭句柄后重建）。

这与全量运行中偶发的 `app-manager-lifecycle.test.mjs:214` 失败（`[yanxing] ENOENT: ... lstat '/proc/730020'`；该文件单跑 25/25 通过、全量运行偶发）是同一类病：**共享可变状态 + 时序假设**。

**修复方案（按性价比排序）**：

1. **第一刀：给 `lib/db/client.ts` 加 `closeDatabaseForTesting()`**（关闭连接**并清除** `globalThis.__yanxingDatabase` / `__yanxingDatabasePath`），或让 `openEnsuredDatabase()` 在命中缓存时检测句柄已关闭并重建。这一处即可消除上表 4 个文件的顺序耦合——**比补用例优先级更高**。
2. **每个测试一条数据库连接**，而非每个文件一条。仓库已有正确示范：`test/helpers/report-upload-database.ts` 返回 `:memory:` 库，`submission-admission.test.ts:31-43` 用 `context.after(() => database.close())` 逐测试关库。优先改造 `proxy` / `health` / `branding-settings` / `model-settings` / `knowledge`。
3. **限流状态提供 reset 钩子**，或把限流器做成可注入实例，测试各持一份。
4. **把顺序随机化写进 CI**：`node scripts/run-tests.mjs --test-randomize`。不修任何代码就能把问题变成"必须面对的信号"。
5. 定位 `app-manager` 的 /proc 竞态并加防御（单文件 25/25 通过说明它只在负载下出现）。
6. 可选：runner 为每个测试文件生成**独立**的 `YANXING_DATABASE_PATH`（如 `$workspace/<file>.sqlite`），杜绝跨文件共享句柄。

### P0-2 用源码正则替代 UI 验证：1,062 行的 `workspace-app.tsx` 从未被执行

`components/workspace-app.tsx`（1,062 行）是整个工作台的前端控制器。**在 `test/` 里 `WorkspaceApp` 从未被 import 或渲染**（唯一引用是无人调用的孤儿 helper `test/helpers/project-configuration-browser-entry.tsx`）。

替代它的是 **109 处对生产源码文本的正则断言**（`readFile` 生产源码共 39 处调用点，其中 `workspace-submission-ui.test.ts` 一个文件 14 处）。典型样本：

```ts
// workspace-submission-ui.test.ts:893-916 —— 按字符串切片后断言语句顺序
const finish = app.slice(app.indexOf('function finishSubmission('), app.indexOf('try {', ...))
assert.match(finish, /setSubmitOpen\(false\)\s+updateSubmitPhase\(idleSubmitPhase\(\)\)\s+.../)
assert.doesNotMatch(finish, /\bawait\b/)

// workspace-submission-ui.test.ts:850 —— 锁死 JSX 属性顺序
assert.match(app, /<WorkspaceUpdateReportDialog\s+key={detail\.project\.id}\s+detail={detail}\s+onSubmit={handleReportUpload}\s+onClose={closeSubmit}/)

// workspace-submission-ui.test.ts:566 —— 锁死表达式写法
assert.match(app, /onReturnToLatest={detail\.latestSubmission \? \(\) => openReport\(detail\.latestSubmission!\) : undefined}/)

// workspace-submission-ui.test.ts:583-586 —— 锁死 useCallback 依赖数组
assert.match(app, /void refreshLibrary\(controller\.signal\)[\s\S]{0,80}\}, \[refreshLibrary, refreshProjects, refreshStats\]/)
```

**双向失效**：

- **重构必红**：改变量名、JSX 属性换行、Prettier 重排、把 `finishSubmission` 抽成模块——8～12 个测试变红，产品行为完全没变。
- **真 bug 必绿**：`generationAtCommit` 比较写错、`finishSubmission` 漏 `catch`、`useCallback` 依赖数组少一项导致闭包过期——只要字符串还在，测试全绿。**而这恰恰是这些测试自称要防的 bug。**

同类还有 `insight-request.test.ts:7-28`（TSX/CSS 源码切片断言 `aria-live`、`animation-delay: 160ms`）、`project-edit-entry.test.ts:57-64`（把 `canManage={detail.project.canSubmit}` 这一可疑接线冻结成契约）、`project-configuration.test.ts:192-200`（正则匹配 `size="4xl"` 与中文页签）。

**修复方案**（不要新增 `readFileSync` UI 测试）：

1. 沿用已验证的模式：把 `finishSubmission` / `handleReportUpload` / `persistUrl` / `applyFetchedReport` 从组件抽成模块函数（就像已抽出的 `reduceWorkspaceSubmit`、`createLatestRequestGuard`），再对抽出的函数做行为测试。
2. 「已退役 UI 不再出现」这类墓碑断言是合理的，但应集中到**一个** `retired-ui.test.ts`，不要混在行为测试里。
3. 依赖数组这类"实现签名"诉求交给 `eslint-plugin-react-hooks`，不要用字符串正则。

### P0-3 没有真实的 UI 交互层

`renderToStaticMarkup` 只执行首屏。**`useEffect`、事件回调、`setState`、错误边界重试、焦点陷阱一律不运行**：

- `components/use-dialog-focus.ts:18-73` 的 Escape 处理、Tab 循环、模块级 `activeDialogs` 注册、焦点恢复——一个分支都没执行；`dialog-focus.test.ts:14-24` 只测了一个纯谓词。
- `frontend-ui.test.ts:128-147` 渲染 `ConfirmDialog` 并断言 HTML 结构，但从不触发 `onConfirm`。
- `settings-loading.test.ts:80-89` 对"重试失败面板"只断言 `retryablePanel.includes('setGeneration')`；真正会出错的路径（React 复用失败的 lazy 组件导致重试无效）无法被发现。
- `overview-loading.test.ts:170-176`、`repository-loading.test.ts:47-61`、`detail-entrance.test.ts:27-38` 用 `for (visit = 0; visit < 2)` 重新 SSR 两次来验证"每次挂载都重播动画"——**SSR 本身无状态，`data-enter="true"` 永远在初始 HTML 里，这些测试是空转的**。

**修复方案**：补**一个**真正的交互测试层（jsdom + RTL，或 Playwright 组件测试），只覆盖三处最高价值交互：对话框（焦点/Escape/确认）、提交流程、设置面板重试。不要试图迁移全部 154 个文件。

### P0-4 三个容器测试永久静默跳过，且"安全契约"文件名不副实

`test/proc-role-scan.test.mjs:21`：

```js
const runContainerTests = process.env.YANXING_PROC_ROLE_DOCKER_TESTS === '1'
```

该变量**在仓库、CI 工作流、`scripts/*.sh` 中没有任何地方被设置为 `1`**，只在 `docs/ponytail-implementation-log.md:58` 的一次性手工命令里出现过。结果是 `proc-role-scan` 的 3 个容器用例（含 400s 超时的"kill worker 后容器恢复健康"）**从未在 CI 中运行**。全量运行时那行 `skipped 3` 就是它。

同类问题：`test/api-security-contracts.test.ts` 名为"API 安全契约"，实际 40 行只测了 `requireSettingsRevision` 的 revision 解析——**没有任何 CSRF、越权、注入用例**。而 CSRF 是在 `proxy.ts:101` 强制的，测试却全部直调 handler 并只带 session cookie。

**这是最危险的测试坏味道：跳过是静默的，绿灯是假的。**

**修复方案**：

1. 把 `YANXING_PROC_ROLE_DOCKER_TESTS=1` 加进 `.github/workflows/ci.yml` 的 `docker` job（那里本来就有 Docker）；
2. runner 增加规则：白名单外的任何 skip 都视为失败（或至少在 CI 日志里醒目打印跳过清单）；
3. `api-security-contracts.test.ts` 要么补上真实的 CSRF/越权矩阵（经 proxy 调用），要么改名以免误导。

### P0-5 全链路没有超时，挂起会烧掉 6 小时 CI

- `scripts/run-tests.mjs:58-75,154-168`：只转发 `--test`，**没有 `--test-timeout`**，node:test 默认超时为 `Infinity`；`waitForChild` 无限等待 `close`。
- 信号只发给 tsx 单个 PID，**没有进程组 kill，也没有 TERM→SIGKILL 升级**（`run-tests.mjs:130-138`）；node:test 的子进程可能成为孤儿。
- 129 个测试文件里 22 个会 `spawn` 真实进程，任一个挂住就整体挂住。
- `.github/workflows/ci.yml` 的 `verify` job **没有 `timeout-minutes`**（GitHub 默认 360 分钟）；同文件的 `docker` job 反而设了 20 分钟。
- 具体的高危无超时读取点：`test/job-events-stream.test.ts:66-91` 的 `readSse`（`while (events.length < expectedCount)` 无 deadline）；`test/helpers/p5-native-harness.ts:367-390` 的 `waitForIpcMessage`（只监听 message/error/exit，无 deadline）；`test/env-bootstrap.test.mjs:38-42` 与 `p5-native-harness.ts:348-357` 的 `spawnSync` 无 `timeout`。

**修复方案**：

```js
// run-tests.mjs
const child = dependencies.spawnProcess(process.execPath, [
  tsxCliPath, '--tsconfig', tsconfigPath, '--test',
  '--test-timeout=60000',     // 全局兜底
  '--test-concurrency=4',     // 降低对宿主 CPU 数的敏感性，见 P0-1
  ...nodeArguments, ...testFiles,
], { detached: true, ... })   // 新建进程组，超时后 kill(-pid) 并升级到 SIGKILL
```

并在 `verify` job 上加 `timeout-minutes: 20`；给 `readSse` / `waitForIpcMessage` 加 `AbortController` 与 deadline。

### P0-6 存在恒真（vacuous）断言

**已确认的实例**：

| 位置 | 断言 | 问题 |
|---|---|---|
| `submission-workspace-routes.test.ts:196` | `assert.ok('analysisTask' in detail.body \|\| true)` | `\|\| true` 使断言**恒真**，报告详情契约完全没被检查 |
| `user-optimistic-lock.test.ts:233-243` | 测试自己写 `listedDuringHash = true`，再 `assert.equal(listedDuringHash, true)` | 恒真；并未证明"哈希发生在写锁之前"，标题过度承诺 |
| `p5-package-container.test.mjs:48-56` | `assert.equal(timeoutForDockerArgs(['build',...]), DOCKER_TIMEOUT_MS.build)` + `DOCKER_TIMEOUT_MS.build > 0` | 拿函数的返回值与其常量比，且从不接触 Docker |
| `submission-workspace-contracts.test.ts:17-23` | `assert.deepEqual(WORKSPACE_RETIRED_CODES, { REPORT_STAGE_IMMUTABLE: 'REPORT_STAGE_IMMUTABLE', ... })` | 断言 `{CODE:'CODE'}` 映射等于自身；只锁了名单，不验证行为 |
| `workspace-submission-ui.test.ts:571-574` | `assert.ok(NATIVE_TASK_EVENT_TYPES.includes('queued'))` | 断言常量数组包含自身元素；除非同时断言"注册的监听器集合恰好等于该数组"（而注册目前只被正则匹配） |
| `core-contracts.test.ts:1142` | `tooManyRows['热力图'].length === 13` | 这个 13 行是测试自己刚构造的；真正该断言的是拒绝**错误码** |

**修复方案**：加一条 CI 检查（`grep -rn "|| true" test/` 与"断言对象是测试自建 fixture"的人工评审规则）；逐条按上表右列改写成可失败断言。

### P0-7 "集成"测试绕过生产实现

`test/stage-report-foundation-integration.test.ts:38-70`：

- 测试自己实现了 `persistPlannedSubmission()`——重新写了一遍 INSERT / UPDATE 顺序（含 `in_progress` 排序）；
- 测试自己 `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`；
- 于是"多表写入失败会整体回滚"验证的是**测试自己的 helper + SQLite 的事务语义**，生产的 `confirmSubmission` 不在被测范围内。

仓库里其实已有真版本：`report-submission-repository.test.ts:175-212` 用 TEMP TRIGGER 驱动**生产**代码验证回滚。

同类：`test/submission-executor.test.ts:200-295` 的 `MemorySubmissionStore` 重实现了 lease / call / complete / fail / artifact-once 语义（约 100 行），executor 测试因此从不接触 SQLite。

**修复方案**：helper 降级为纯 schema 播种器；用 `ReportSubmissionRepository.confirmSubmission` 驱动集成路径；不要由测试自己开事务。

### P0-8 "验收"测试自建替身，产品坏了也可能绿

- `test/deployment-smoke.test.mjs:509,641-699`：用进程内 `FakeYanXing` 驱动 `scripts/deployment-smoke.mjs`，而这个 fake **总是登录成功、从不校验 CSRF 或口令**，并按客户端的预期实现协议。真正的部署验收是 `scripts/test-docker.sh`，不是这个文件。
- `test/p5-release-acceptance.test.mjs:11,117-129`：对 `createFakeReleaseRoot` 与预设 provider JSON 做断言，不启动真实 Next 服务。

**影响**："smoke / release acceptance" 在默认 runner 里全绿，而真实路由、CSRF 或 Next 启动可能已经坏了。

**修复方案**：明确区分 **client-contract unit test**（保留，但改名并在注释里写清边界）与 **live acceptance**（CI 中必须有 job 跑，且若被跳过则 CI 失败）。

---

## 五、P1 重要问题

### P1-1 断言失败时几乎没有诊断信息

| 断言 | 总数 | 带消息 | 缺失率 |
|---|---|---|---|
| `assert.equal` | 2,736 | 596 | **78%** |
| `assert.match` | 609 | 67 | **89%** |
| `assert.ok` | 372 | 57 | **85%** |
| `assert.doesNotMatch` | 217 | 22 | **90%** |
| `assert.notEqual` | 56 | 5 | **91%** |
| `assert.deepEqual` | 346 | 220 | 36% |
| `assert.throws` | 253 | 249 | 2% ✅ |
| `assert.rejects` | 141 | 134 | 5% ✅ |

`assert.ok(x)` 无消息时只打印 `false !== true`。在 22% 是进程级测试的套件里，这会让定位成本从秒级变成分钟级。

**建议**：只强制要求**循环/表格驱动的断言**必须带消息（最易失去定位能力的场景）。已有正确示范：`authorization.test.ts:85-90` 的 `assert.ok(listed, member.username)`。

### P1-2 5,222 行 `.mjs` 测试代码没有任何静态检查

- `tsconfig.source.json:19` 的 include 只有 `"test/**/*.ts"`，**不含 `test/**/*.mjs`，也不含 `test/**/*.tsx`**（`test/helpers/project-configuration-browser-entry.tsx` 因此从不被类型检查）。
- 仓库**没有 ESLint、没有 Prettier、没有任何 linter 配置**；`pnpm lint` 实际是 `tsc --noEmit --noUnusedLocals --noUnusedParameters`。

即：18 个 `.test.mjs` + `helpers/*.mjs` + `scripts/*.mjs` 共 5,222 行测试代码，既无类型检查也无风格/缺陷检查——而它们正是最容易写错的进程编排代码。

**建议**：include 补上 `test/**/*.mjs`、`test/**/*.tsx`、`scripts/**/*.mjs` 并开 `checkJs`（可先给重点文件加 `// @ts-check` 渐进推进）；引入 ESLint（`@typescript-eslint` + `react-hooks`）替换伪装的 `lint` 脚本。

### P1-3 零覆盖率度量

仓库**没有任何覆盖率工具**，但 Node 24 已内置 `--test-coverage-lines` / `--test-coverage-branches` / `--test-coverage-functions` 阈值参数。写了 23,049 行测试却无法回答"哪个模块在退化"，这是异常高的杠杆点。

```json
"test:coverage": "node scripts/run-tests.mjs --experimental-test-coverage --test-coverage-lines=70"
```

建议先用**只报告不设阈值**的方式接入，观察 2～3 个迭代后再定阈值。

### P1-4 `core-contracts.test.ts` 手写互斥锁：全局耦合的症状

```ts
// core-contracts.test.ts:25-40
// The node test runner may overlap sibling tests; serialize tests that share fetch/env globals.
let sharedStateTail = Promise.resolve()
test.beforeEach(async () => { const previous = sharedStateTail; ... await previous })
test.afterEach(() => { releaseSharedState?.() })
```

该文件 1,299 行 / 43 个测试，因为要改 `globalThis.fetch` 和 `process.env` 而**被迫全量串行**。三层问题：

1. 手写 Promise 队列很脆弱——任一测试不 resolve 就永久死锁整个文件；
2. 43 个本可并行的测试被完全串行化；
3. 它掩盖了根因：被测 HTTP runtime 依赖全局 `fetch` 而非注入。

**建议**：把 `fetch` 变成 `createHttpRuntime({ fetch })` 的显式参数（`submission-executor.test.ts` 已是此模式），然后删掉互斥锁；至少也应改用 `describe({ concurrency: false })` 与 `t.mock.method(globalThis, 'fetch')`，绝不直接赋值。

### P1-5 双层单例锁死：21 处临时目录样板的真正根因

```ts
const directory = await mkdtemp(tmpdir() + '/yanxing-authz-')
process.env.YANXING_DATABASE_PATH = path.join(directory, 'authz-test.sqlite')
const { ... } = await import('../lib/auth/session')   // 必须动态 import，等环境变量生效
test.after(async () => { await rm(directory, { recursive: true, force: true }) })
```

这段"mkdtemp + 设 env + 动态 import + after 清理"在 21 个文件里逐字重复，**但样板本身只是症状**。真正的根因是两层进程级单例，它们让"在内存里重置状态"变得不可能：

**第一层：SQLite 连接全局固化且拒绝换路径**（`lib/db/client.ts:66-70`，缓存写于 `:83-84`）

```ts
const cachedDatabase = databaseGlobal.__yanxingDatabase
if (cachedDatabase) {
  if (databaseGlobal.__yanxingDatabasePath !== databasePath) {
    throw new Error('进程运行期间不能切换 YANXING_DATABASE_PATH；请重启进程。')
  }
  ensureCachedNativeSchema(cachedDatabase)
  return cachedDatabase
}
```

没有任何 `close()` / `dispose()` / 测试重置入口。

**第二层：服务运行时模块级单例**（`lib/reports/server-runtime.ts:19,47-48`）

```ts
let host: SubmissionServerRuntime | undefined

export function getSubmissionServerRuntime() {
  return host ??= createSubmissionServerRuntime({ ... })
}
```

`host` 一旦初始化就再也无法卸载或重设。

**架构后果**：所有路由/API 测试被**强制**在模块最顶层（import 之前）改写 `process.env.YANXING_DATABASE_PATH`，并完全依赖 Node `--test` 的"每文件一进程"隔离来获得干净的库——无法做轻量级内存级复用。这也是 P0-1（顺序随机化失败）无法靠"测试内部清理"解决的原因：**状态根本无从清理**。

其余两个隐患：`test.after` 只在模块加载成功后注册，**任一 import 抛错则临时目录永久残留**；env 还原只有 `core-contracts.test.ts:17-23` 和 `http-dns-errors.test.ts:19-20` 做了（`native-backup.test.ts:315` 只在正常路径 `delete`，抛错路径不还原）。

**建议**（两层一起解）：

1. 在 `lib/db/client.ts` 导出受控的 `closeDatabaseForTesting()`，清理 `databaseGlobal.__yanxingDatabase` 与 `__yanxingDatabasePath`；
2. 在 `lib/reports/server-runtime.ts` 导出 `resetSubmissionServerRuntime()`；
3. 之后路由测试即可在同一进程内逐用例重建内存库，样板与"import 前改 env"的强耦合同时消失；
4. 兜底层：抽出 `test/helpers/temp-environment.ts`，在 `process.on('exit')` 里兜底清理并快照/还原 env。

### P1-6 用"再实现一遍"验证实现

- `test/graph-layout.test.ts:26-65` 定义 `legacyGetMindMapDirection`——**把生产算法完整重写了 40 行**，再断言新旧结果相等。共享 bug（两边都错）→ 绿灯；生产一改 → 测试也要跟着改，但没人会记得。
- `research-workbench.test.ts:125` 直接复制 `lib/rendering/visualizations.ts:45` 的 `ratio: Math.max(0, Math.min(1, value / 100))`。
- `storage-maintenance.test.ts:540,563` 的竞态注入以**精确 SQL 文本**为触发条件（`prepare(sql) === 'SELECT source_path FROM knowledge_items UNION ALL ...'`）：SQL 空白或列名一变，注入静默失效，测试**仍然通过**；`assert.equal(protectionReads, 3)` 是"实现计数"而非行为 oracle。
- `submission-workspace-routes.test.ts:221-222` 用 119 次 `checkRateLimit('overview-stats:' + owner.id, ...)` 自己灌满桶：证明的是"单例是共享的"，不是"路由用了这个 key 和这个 limit"——key 改名后 429 消失，填充循环照样"通过"。

**建议**：改用"表驱动输入→期望输出"的 oracle 表；竞态与限流改为通过 seam/公开键构造器注入或断言。

### P1-7 "或状态"弱契约：多种错误码都能通过

| 位置 | 断言 | 风险 |
|---|---|---|
| `submission-workspace-routes.test.ts:318` | `assert.ok(response.status === 400 \|\| response.status === 409)` | 退役字段 `ownerId`/`collaboratorIds`/`members` 应固定为 409 + `PROJECT_FIELD_RETIRED` |
| `project-owners.test.ts:124` | `assert.ok(started.status === 202 \|\| started.status === 200)` | 分析触发若静默返回 no-op 200 也能通过 |
| `jobs-cancel-route.test.ts:33` | `assert.notEqual(response.status, 200)` | 401 / 404 / 500 全部满足 |

**建议**：每个用例固定单一期望状态 + `body.code`。

### P1-8 自证式断言（fixture 断言自身）

除 P0-6 已列外，还有：`core-contracts.test.ts:946-953`（`AnalysisStages` 深比较后又比长度）、`:1217`（对测试自己构造的对象做 `Object.keys`）、`stage-workflow.test.ts:252`（`STAGE_FIELD_LIMITS.stages === 12`）、`submission-task-schema.test.ts:21`（seed 的 users 数量是 4）。

**建议**：删除自比较；对 heatmap 应断言 `HEATMAP_*` 错误码。

### P1-9 整体 HTML/SVG 黄金串 + 中文文案耦合

- `overview-loading.test.ts:281-326` 与 `repository-loading.test.ts:198-206` 用 400 字符黄金串复述 `sparklineGeometry` 的输出（而 `sparkline-geometry.test.ts:17-40` 已经在测几何计算）；曲线算法一改要同步改 3 个文件。
- 4,730 个断言里 701 个（15%）比较中文字面量。**契约型**（错误码→文案映射、`insightEmptyCopy`、`describeCommitNetworkError`）是好设计；**装饰型**则造成无谓摩擦：`report-history-replacement.test.ts` 80 个断言里 59 个在比中文；`insight-workspace.test.ts:156` 与 `insight-empty-state.test.ts:102` 重复同一句文案；黄金 SVG 里嵌中文 `aria-label`。
- `schema-errors.test.ts:137-144` 断言 TypeBox 的英文原文 `error.message === raw.message`——库改文案则测试失去意义。

**建议**：断言"性质"而非整串（点数、`stroke-dasharray` 存在、空数据分支渲染 `—`）；文案集中成常量模块（沿用 `insightEmptyCopy` 模式）；错误断言优先用 `code`。

### P1-10 测试名与行为不符

- `original-workspace-mount.test.ts:7`：`'native controller **mounts** the original visual components'` —— 其实只是字符串 `includes`。
- `workspace-submission-ui.test.ts:577`：`'startup callbacks stay stable so **auth is not aborted**'` —— 没有执行 auth。
- `user-optimistic-lock.test.ts` 的 `'password hashing happens before the write lock...'` 标题过度承诺（见 P0-6）。
- `api-security-contracts.test.ts`、`p5-release-acceptance.test.mjs`、`deployment-smoke.test.mjs` 的文件名均高于其实际覆盖。

**建议**：测试名描述**已验证的**行为；覆盖不足时改名（如 `*-contract.test.ts`）或注明 `(unit)`。

---

## 六、P2 次要问题

1. **"每次挂载都重播动画"类测试是空转的**（`overview-loading.test.ts:170-176` 等，见 P0-3）。
2. **布尔与运算断言掩盖真实失败**：`workspace-submission-ui.test.ts:948` 的 `assert.equal(retry.step === 'submitting' && retry.idempotencyKey, submitting.idempotencyKey)`——`step` 错误时比较 `false` 与字符串，报错毫无帮助，且 `step` 从未被独立断言。应拆成两行。
3. **`documents.test.ts:117,148,159` 写入 `process.cwd()/storage/reports`**——只因为 runner 把 `cwd` 设为临时工作区才安全；直接跑 `tsx --test test/documents.test.ts` 会污染真实仓库。该文件已有 `mkdtemp`，传参即可。
4. **`knowledge.test.ts:8-12,88` 共享临时目录并断言 `readdir(storageRoot).length === 1`**——顺序一变就会看到别的测试上传的文件（P0-1 的成因之一）。改为断言"该项存在"。
5. **真实时钟与 sleep**：`submission-worker-flow.test.ts:162`（`setTimeout(...,1250)` + mock 时钟，`renewals >= 1` 时序依赖）、`auth.test.ts:64`（20ms sleep 让 `last_login_at` ≠ `updated_at`）、`core-contracts.test.ts:1281-1285`（10ms 定时器触发 abort）。`report-submission-outbox` 已示范纯注入时钟，应推广。
6. **12 个循环生成的测试不如 1 个表格测试**：`workspace-submission-ui.test.ts:816-843` 用 `viewingHistorical × status`（2×6）生成 12 个测试，每个渲染整棵 `DashboardView`，耗时约 480ms。
7. **`frontend-ui.test.ts:89-96` 用整篇 HTML 的首个正则匹配定位元素**：`html.match(/<div class="([^"]*)" style="width:([^;]+);background-color:([^"]+)"/)` 匹配的是**整个文档里第一个**符合该形状的 div——上方新增同形状元素后会静默检查错误节点。
8. **`frontend-ui.test.ts:152-158` 断言 SVG 硬编码坐标**（`d="M232 \d+ H256"`、`width="64" height="24"`）：重构图标必红、图标画错未必红。
9. **`app-manager-lock.test.mjs:82` 用 `chmodSync(lockPath, 0)` 模拟不可读**：以 root 运行时文件依然可读，测试前提不成立。应 `skip` 当 `process.getuid?.() === 0`。
10. **平台假设不一致**：`proc-role-scan.test.mjs:42` 有 `skip: process.platform !== 'linux'`，但依赖 `/proc` 与 POSIX 信号的 `docker-supervisor.test.mjs`、`app-manager-lifecycle.test.mjs`、`app-manager-lock.test.mjs` **一个平台守卫都没有**（grep `platform` 计数为 0）。跨平台开发机上会直接失败。
11. **两处无 `WHERE` 的 `UPDATE`**：`rate-limit.test.ts:27` 的 `UPDATE rate_limit_buckets SET window_started_at = ?`、`p5-native-harness.ts:92-93` 的 `UPDATE ai_model_channels SET base_url = ?`。在私有测试库里无害，但这是会被复制粘贴的危险范式。
12. **`native-browser-smoke.mjs` 不归 runner 管**：它不是 `*.test.*`，`defaultTestFiles`（`run-tests.mjs:90-95`）只扫 `test/` 顶层，所以永远不会被自动执行；内部硬编码 `/usr/bin/google-chrome`，用"监听 0 端口后立刻关闭再让 Next 绑定"造成 TOCTOU 端口竞争，清理时留下 `mkdtemp` 目录，且用 `delay(850)` / `delay(700)` 而非等待选择器。
13. **`project-members-management.test.ts:50`** 依赖 `{request, context}` 的**对象键插入顺序**（`Object.values(request(...))`）。
14. **`submission-worker-command.test.ts:44-75`**：9 变体 × 4 入口 + esbuild 打包 + 每次 15s `spawnSync`，思路正确但不应放在默认套件（建议标记为 slow 并单独 job）。
15. **`native-backup.test.ts` 的 CLI 标志表**把 unknown / duplicate / empty / `--force` 全部映射到同一个 `EXPLICIT_PATH_REQUIRED`，无法区分"错误码回归"。
16. **中英混用的测试名**：`overview-trends.test.ts`、`report-stage.test.ts`、`graph-layout.test.ts`、`core-contracts.test.ts:910` 里混有中文名，其余 874 个是英文。建议统一（推荐英文名 + 中文 fixture 数据）。
17. **`upload-limits.test.mjs:21-29`** 直接 import `next/dist/server/body-streams.js`（Next 内部路径）+ 分配 9～25 MiB 缓冲；Next 升级会破。
18. **`help()` 用法文案正则**（`p5-release-acceptance.test.mjs:68-76`、`deployment-smoke.test.mjs:44-48`）价值低、遇改词即红；保留一条"必需的 flag 存在"即可。

---

## 七、性能剖析与优化（实测）

### 7.1 耗时分布

解析全量运行的 spec reporter，1,011 条用例时长记录：

| 耗时 | 用例 | 根因 |
|---|---|---|
| **7,181 ms** | `killed worker preserves incomplete call...`（`p5-fault-acceptance.test.ts:80`） | 真实 Worker 子进程被 `SIGKILL` 后，硬编码 `await delay(P5_WORKER_LEASE_MS + LEASE_RECOVERY_SLACK_MS)` 等租约自然过期 |
| **6,886 ms** | `explicit write entries fail closed...`（`submission-worker-command.test.ts:44`） | 用例内即时 `esbuild.build`，随后 **9 变体 × 4 入口 = 36 次串行 `spawnSync(node)`** |
| **6,136 ms** | `true concurrent native confirm processes...`（`p5-fault-acceptance.test.ts:74`） | 多组独立 Node 进程对同一 SQLite WAL 触发并发争抢 |
| **3,360 ms** | `backup CLI loads env files...`（`native-backup.test.ts`） | 针对不同环境变量层级多次派发备份 CLI 真进程 |
| **3,238 ms** | `SIGKILL after native confirm commit...`（`p5-fault-acceptance.test.ts`） | 事务提交后 `SIGKILL`，再拉起恢复进程验证重放 |
| 3,227 ms | `extractDocumentText dispatches by file extension...` | 真实 DOCX/PDF 解析 |
| 2,933 ms | `isolated parser children still extract PDF and DOCX...` | 解析器子进程 |
| 2,740 ms | `extractPdfText extracts plain text from a minimal PDF` | PDF 解析冷启动 |

**结论**：耗时的主因不是零散 sleep，而是**在单个用例内即时编译打包工具，并密集派发几十次全新 Node 进程**。前 5 名合计 31.7 s，占全部用例时长（121.5 s）的 **22.1%**——这是优化的真实 ROI 上限，不是"近一半"。

> 注意：121.5 s 是所有用例时长之和，远大于 24 s 墙钟，因为文件间并行、文件内并发。用墙钟做分母会得出错误的比例。

### 7.2 两条可直接回收约 11 秒的优化

**优化 A：把即时编译移出用例体，折叠进程爆炸（预计回收 5～6 秒）**

`submission-worker-command.test.ts:44-77` 现在在**单条用例内**调用 `esbuild.build`，然后对 `['marker','empty','legacy','mixed','checksum','trigger','index','root','valid']` 9 种库形态 × 4 个入口（源文件 2 + 编译产物 2）串行执行 36 次 `spawnSync`：

```ts
await build({ entryPoints: [entry, recoveryEntry], outdir: join(root,'.runtime'), ... })
const entries = [entry, recoveryEntry, join(root,'.runtime/worker/submission-index.mjs'), join(root,'.runtime/scripts/recover-report-uploads.mjs')]
for (const variant of ['marker','empty','legacy','mixed','checksum','trigger','index','root','valid']) {
  ...
  for (const target of entries) { const result = run(args, root, target); assert.equal(result.status, variant==='valid'?0:1, ...) }
}
```

做法：`esbuild.build` 提到 `test.before` 只编译一次；9 种库形态改为**直接调用目标校验函数**，只保留 1～2 个真实进程退出冒烟（该用例的核心价值是 fail-closed 与"字节级不变"，进程边界本身不是被测对象）。

**优化 B：虚拟化租约时钟，消除 6 秒硬等待（预计回收 6 秒）**

`p5-fault-acceptance.test.ts:109` 的等待是精确的 4,000 + 2,000 = **6 秒整**（`p5-native-harness.ts:21` 的 `P5_WORKER_LEASE_MS = 4_000` 加 `:33` 的 `LEASE_RECOVERY_SLACK_MS = 2_000`）。把持久化租约时间**拨回过去**即可 0 毫秒确定性过期：

```sql
UPDATE submission_tasks SET lease_expires_at = datetime('now', '-10 seconds') WHERE report_id = ?;
```

注意：优化 B 用 SQL 直接改状态，必须断言"恢复进程随后确实看到了过期租约"，否则会从"慢但真"退化成"快但假"。`report-submission-outbox` 已有纯注入时钟的先例，优先沿用其模式。

### 7.3 顺带值得治理的慢用例

`native-backup.test.ts` 的 CLI 环境层级用例（3,360 ms）与 `submission-worker-command` 的其余变体，共同特征是"用真进程验证纯逻辑"。建议统一策略：**进程边界用 1 个冒烟用例守住，其余改为函数直调**；确需保留的标记为 slow 并放到独立 job。

---

## 八、覆盖缺口（按风险排序）

### 8.1 无直接测试引用的生产文件：57 / 256（22%）

> 方法说明：统计测试文件对生产文件路径的**直接**引用；被间接依赖覆盖的模块（如 `native-backup-*.ts` 被 `native-backup.test.ts` 间接覆盖）不计入风险。下表只列真实风险项。

| 文件 | 行数 | 风险 |
|---|---|---|
| `components/admin/model-settings.tsx` | 1,039 | 模型渠道/绑定管理 UI，零直接测试 |
| `components/ui/select.tsx` | 600 | **键盘导航、ARIA、焦点管理，零测试** |
| `components/admin/project-management-settings.tsx` | 496 | 课题管理 UI，零直接测试 |
| `components/admin/user-management-settings.tsx` | 488 | 用户管理 UI，零直接测试 |
| `components/ui/multi-select.tsx` | 415 | 多选交互，零测试 |
| `app/login/page.tsx` | 364 | 登录页，零直接测试 |
| `lib/documents/knowledge-upload.ts` | 340 | 知识库上传（路径归属、大小上限），无直接测试 |
| `components/workspace-navigation.tsx` | 309 | 导航，零测试 |
| `components/notification-center.tsx` | 262 | 通知中心，零测试 |

`components/ui/` 的 13 个组件里只有 4 个被测试 import（`confirm-dialog`、`empty-state`、`file-dropzone`、`repository-stats`）。

### 8.2 API 路由：9 / 35 无路由级测试

```text
app/api/auth/login/route.ts                       ← 登录（限流、CSRF、Cookie 签发）
app/api/auth/logout/route.ts
app/api/users/route.ts                            ← 用户列表
app/api/reports/[reportId]/file/route.ts          ← 报告文件下载（仅测了 service，未测路由）
app/api/reports/[reportId]/insight/route.ts
app/api/knowledge/[knowledgeId]/file/route.ts     ← 知识库文件下载（完全无测试）
app/api/jobs/[jobId]/route.ts
app/api/jobs/[jobId]/retry/route.ts
app/api/projects/[projectId]/report-uploads/[uploadId]/route.ts
```

其中**两个文件下载路由**直接涉及权限与 `Range` / 路径穿越，是安全面最需要路由级测试的地方；`submission-report-file.test.ts` 测的是 `serveSubmissionReportFile` service，绕过了路由层的会话解析。

此外，整个套件**没有任何经由 `proxy` 的 CSRF 用例**（`proxy.test.ts:36-96` 的变更请求总是带正确 origin + csrf），而 CSRF 正是在 proxy 层强制的。

### 8.3 完全没有覆盖的测试维度

| 维度 | 现状 | 建议 |
|---|---|---|
| 覆盖率度量 | 无 | 接入 Node 24 内置 `--experimental-test-coverage`（P1-3） |
| 变异测试 | 无 | 对提交状态机、配额、权限、限流四模块跑一次 `stryker`，评估断言强度 |
| 无障碍（a11y） | 无 | `jest-axe` / Playwright a11y 扫描，至少覆盖对话框与表单 |
| 视觉回归 | 无 | 有设计冻结诉求，可上 Playwright `toHaveScreenshot` |
| 属性/模糊测试 | 零星（`report-insight.test.ts:140` 的 tag flood） | 对 schema 校验、URL 解析、限流边界引入 `fast-check` |
| 顺序随机化 | 未启用（且当前会失败） | 修好 P0-1 后加入 CI（§九 第 3 项） |
| 性能回归门禁 | 无 | `p5-contention-benchmark.ts` 设 P95 阈值（如 < 200ms）并纳入每周定时 CI |
| 测试策略文档 | 无（`README.md:292` 只有一句"行为变更请补充测试"） | 新增 `docs/testing.md` |

---

## 九、建议路线图

### 第 1 周（几乎不改测试逻辑，杠杆最高）

1. `run-tests.mjs` 加 `--test-timeout=60000` 与 `--test-concurrency`；补进程组 kill 与 TERM→SIGKILL 升级；`ci.yml` 的 `verify` job 加 `timeout-minutes: 20`。
2. 给 `readSse`（`job-events-stream.test.ts`）、`waitForIpcMessage`（`p5-native-harness.ts`）、无 `timeout` 的 `spawnSync` 加 deadline。
3. CI 增加一个 job：`node scripts/run-tests.mjs --test-randomize`（先设 `continue-on-error`，观察一周）。
4. 修掉 P0-6 的 6 处恒真断言（一次性、低风险）。
5. CI 打印跳过测试清单，并把 `YANXING_PROC_ROLE_DOCKER_TESTS=1` 加进 docker job。
6. **加 `closeDatabaseForTesting()` 并改写 4 处 `getDatabase().close()`**（`proxy` / `health` / `rate-limit` / `http-dns-errors`）——这是 P0-1 的第一刀，产品代码约 5 行改动，消除三个文件的顺序耦合。
7. **执行 §7.2 优化 A**：`esbuild.build` 提到 `test.before`；`submission-worker-command.test.ts` 的 9 变体改为函数直调，仅留 1～2 个进程冒烟（预计回收 5～6 秒）。
8. **执行 §7.2 优化 B**：`p5-fault-acceptance.test.ts:109` 的 6 秒租约等待改为 SQL 拨回 `lease_expires_at`，并断言恢复进程确实观察到过期租约（预计回收 6 秒）。

### 第 2～3 周（解开双层单例 + 修隔离性）

9. **补齐组合根重置口**：`lib/reports/server-runtime.ts` 导出 `resetSubmissionServerRuntime()`（`closeDatabaseForTesting()` 已在第 1 周第 6 项完成）。
10. 逐文件把共享 SQLite 改为 `:memory:` 或每测试独立库（照抄 `submission-admission.test.ts:31-43` 的 `context.after(() => database.close())`）。优先：`proxy`、`health`、`branding-settings`、`model-settings`、`knowledge`。
11. 限流器提供 reset 或改为可注入实例。
12. 抽出 `test/helpers/temp-environment.ts`，替换 21 处样板并补 env 还原与 `exit` 兜底清理。
13. 补 Worker 主循环与页面层的执行级测试（见附录 B.3）：`worker/index.ts`、`app/error.tsx`、`app/global-error.tsx`、`app/login/page.tsx`。
14. **验收标准：`--test-randomize` 连续 20 次全绿**；然后把随机化设为 CI 必过项。

### 第 4～6 周（补 UI 验证能力 + 清理重构摩擦）

15. 引入 jsdom + RTL（或 Playwright 组件测试），只覆盖：对话框焦点/确认、提交流程、设置面板重试。**注意：不要把 browser smoke 塞进 `pnpm test`**（Chrome + 生产 Next 会把默认套件拖成分钟级），它应留在 CI 独立 job / nightly。
16. 把 `workspace-app.tsx` 的 `finishSubmission` / `handleReportUpload` / `persistUrl` / `applyFetchedReport` 抽成模块并做行为测试，删除对应源码正则。
17. 删除 `graph-layout.test.ts` 的 `legacyGetMindMapDirection` fork；黄金 SVG 串收敛到 1 处；墓碑断言合并为 `retired-ui.test.ts`。
18. 弱契约改为单一期望状态 + `body.code`；补 `proxy` 级 CSRF 用例、`login`/`logout` 路由用例与两个文件下载路由的权限用例。

### 第 7 周以后（制度化）

19. 新增 `docs/testing.md`：隔离启动器契约、`helpers/` 复用要求、**禁止对 UI 源码做正则断言**（冻结政策：不得新增对 `components/*.tsx`、`app/*.css` 的 `readFileSync` 断言）、DB 测试模板、文案常量化约定、慢测试标注方式、skip 政策。
20. 接入覆盖率（先报告、后阈值）与一次变异测试评估。
21. 统一验收编号格式（`AT-16`/`Q-01`）并加自动校验。
22. 给 `p5-contention-benchmark.ts` 设 P95 阈值门禁并入每周定时 CI，防止持久层锁争抢回退。

---

## 十、一句话建议

**先修隔离性（P0-1）和超时（P0-5），因为它们是"绿灯是否可信"的前提；再修恒真断言（P0-6）与绕过生产的"集成"测试（P0-7/P0-8），因为它们是"绿灯是否算数"的前提；然后补一个最小的真实交互层（P0-3）并删除源码正则断言（P0-2），因为那是重构摩擦与虚假信心的来源；最后用覆盖率和顺序随机化把成果锁进 CI。**

这套测试的领域层已经做得比多数项目好——**需要的是停止用字符串假装验证 UI，并让每次运行都独立于执行顺序。**

---

## 附录 A：与既有评审报告的交叉复验

仓库外另有一份同项目评审（`test_architecture_review.md`，15:07 产出，早于本文约 4 小时）。本文对其全部技术论断做了实测复验，结论如下——**分析正确但缺一次实验**。

### A.1 属实并已合并进本文

| 论断 | 复验方式 | 合并位置 |
|---|---|---|
| 双层单例锁死（`lib/db/client.ts:66-70` + `lib/reports/server-runtime.ts:19,47-48`） | 读源码确认：`throw` 拒绝换路径、`host ??=` 无重置口 | §P1-5（改写为该问题的根因） |
| 逐用例耗时排名（7,177 / 6,760 / 6,018 / 3,463 / 3,199 ms） | 独立解析 1,011 条时长记录，实测 7,181 / 6,886 / 6,136 / 3,360 / 3,238 ms，**Top-5 全部命中** | §7.1 |
| 单用例内即时 `esbuild.build` + 36 次 `spawnSync` | 读循环体确认：9 变体 × 4 入口 | §7.2 优化 A |
| 6 秒硬等待可 SQL 虚拟化 | 确认常量 `P5_WORKER_LEASE_MS = 4_000` + `LEASE_RECOVERY_SLACK_MS = 2_000` = 6,000 ms | §7.2 优化 B |
| `api-security-contracts.test.ts` 名不副实（41 行仅测 revision） | 全文阅读确认 | §P0-4、§8.2 |
| p5 压测/验收工具游离于 `pnpm check` 与 CI 之外 | 核对 `package.json` 与 `ci.yml` | §8.3 性能回归门禁 |

### A.2 实测证伪，**不予采纳**

**❌ 「前 5 个最慢用例占全套件近一半耗时」**

实测前 5 名合计 31.7 s，占全部用例时长之和（121.5 s）的 **22.1%**；且另有 3 个不在其 Top-5 的用例超过 2.7 s（`extractDocumentText` 3,227 ms、`isolated parser children` 2,933 ms、`extractPdfText` 2,740 ms），全套件 > 1 s 的用例共 **26 个**。若以 24 s 墙钟为分母，Top-5（31.7 s）会超过 100%，说明"近一半"在任何口径下都不成立。**该数字直接影响优化优先级判断，故在 §7.1 采用 22.1%。**

**❌ 「递归扫描改动仅需 1 行代码，向后完全兼容」**

`readdirSync('test', { withFileTypes: true, recursive: true })` 实测结果：

1. 递归时 Dirent 的 `name` 是 **basename**，所在目录在 `parentPath`；沿用现有的 `path.join(testRoot, entry.name)`（`run-tests.mjs:90-95`）会为嵌套文件拼出**不存在的路径**（实测至少 1 条）；
2. 更严重：递归会立刻把 `test/fixtures/run-tests-probe.test.ts` 扫进套件，而该文件含 `assert.fail('test name filtering was not forwarded')`——它**只在被 `--test-name-pattern` 过滤时才是合法的**。实跑该文件：**2 tests / 2 fail**。

因此目录分层方向可采纳，但落地至少需要：改 `defaultTestFiles` 的路径拼接（用 `parentPath`）＋显式排除 `fixtures/` 与 `helpers/` ＋更新 `run-tests.test.mjs` 的断言。**本文因此不把"递归扫描"列为第 1 周动作**（见 §九 路线图：目录分层未列入，避免 129 个文件的高 churn 与 `git blame` 损失，收益仅是导航性）。

### A.3 其计数为当时快照，非错误

该报告的 127 文件 / 110 `.ts` + 17 `.mjs` / 21 helper / 971 测试，在 15:07 时点是准确的。差额来自此后新增的 `test/proc-role-scan.test.mjs`、`test/use-latest-request.test.ts`、`test/sparkline-geometry.test.ts`、`test/helpers/ponytail-browser-checks.mjs` 与被删除的 `test/shared-abortable-task.test.ts`（净 +2 文件）。**正因如此，它不可能发现本文 P0-4 的"3 个容器测试永久静默跳过"——那个文件当时尚不存在。**

### A.4 方法论教训

该报告的分析能力没有问题——它的"双层单例"结论在逻辑上**预言了**本文 P0-1；但因为它只跑了一次并看到全绿，就没有去验证这个预言。**静态洞察再准确，也需要一次随机化运行来证伪。** 任何测试套件评审，`--test-randomize` 应当是第一个动作，而不是可选项。

---

## 附录 B：第二轮评审（架构师 + 测试工程师）带来的修正

第二份评审对当前工作树独立复核，**纠正了本文的两处事实错误**，并给出了本文 P0-1 的**具体主因**。以下为逐条实测复验结果。

### B.1 它纠正了本文的两处事实错误 ✅ 已采纳

| 本文原述 | 实测真相 | 处理 |
|---|---|---|
| `describe() 0 个（全平铺）` | **存在 1 个**：`test/submission-admission.test.ts:238` 的 `test.describe('submission admission queue limits', { concurrency: false }, …)`。本文此前用 `^\s*describe\(` 检索，漏掉了 `test.describe(` 形式 | 已在 §二 更正为 1 个，并注明这是**正确用法**（该处共享 `process.env`，作者显式声明串行） |
| `测试文件 129 个（111 × .test.ts + 18 × .test.mjs）` | **130 个**：`test/fixtures/run-tests-probe.test.ts` 也是一个 `.test.ts`，故为 112 + 18。本文只 glob 了 `test/*.test.ts` | 已在 §二 更正，并注明顶层 111 / 含 fixture 112 的差异 |

第二处差异还有一层含义值得保留：`run-tests-probe.test.ts` 是**能被 runner 运行、但故意只在名称过滤下才合法**的探针文件（见附录 A.2）。把它算进"用例文件"更能反映真实风险面。

### B.2 它给出了 P0-1 的主因（本文此前只到"共享 SQLite"）✅ 已采纳

它的判断——**根因是 `getDatabase().close()` 毒化 `globalThis` 缓存**——实测成立，且比本文原来的表述精确得多：

- 4 处调用：`proxy.test.ts:114`、`health.test.ts:248`、`rate-limit.test.ts:14`、`http-dns-errors.test.ts:17`；
- `lib/db/client.ts:83-84` 把连接缓存进 `globalThis`，**无任何重置入口**；`openEnsuredDatabase()` 命中缓存即 `return`（`:67-72`），**不检查句柄是否已关闭**；
- `proxy.test.ts:114` 位于该文件**最后一条用例**——顺序改变前它无害。

三处已并入本文 §P0-1 与修复方案第 1 条。

### B.3 它新增的覆盖发现（本文 §8 未覆盖）✅ 属实，建议补入

| 发现 | 复验方式 | 结论 |
|---|---|---|
| `worker/index.ts` 从未被执行 | 全仓检索：仅 `build-runtime.test.mjs` / `docker-assembly.test.mjs` / `p5-package.test.mjs` 把它当**路径字符串**断言，无任何测试 import 或启动它 | 属实。Worker 主循环、轮询、心跳、优雅退出只有 P5 验收的 fake 版本 |
| 页面层零执行 | `app/loading.tsx` / `app/error.tsx` / `app/global-error.tsx` / `app/login/page.tsx` 在 `test/` 中引用数均为 **0**；`app/page.tsx` / `app/layout.tsx` 各 1 处且为源码正则 | 属实。错误边界与全局错误页完全无验证 |
| 脚本 CLI 无测试 | `scripts/test-production.mjs`、`p5-contention-benchmark.ts`、`migrate.ts`、`storage-maintenance.ts`、`docker-security-smoke.mjs` 均存在且不在任何测试引用中 | 属实 |
| 解析子进程未喂损坏文件 | `parser-child-runtime.test.ts` / `documents.test.ts` 中无 corrupt / truncated / malformed 用例 | 属实（仅验证 spawn 参数与正常路径） |
| `lib/reports/server-runtime.ts` **并非**未执行 | `runSubmissionRoute` 被 **19 个** `app/api/**/route.ts` 引用，已测路由会走到它 | 属实——这是它对自己覆盖率审计的纠偏，与本文 §8.1 的"仅统计直接引用"方法说明一致，本文无需修改 |

### B.4 它更准确的一处口径 ✅ 已采纳

测试/生产比：本文原为 **0.63 : 1**（分母含 helper 与否不一致）。它的 **0.69 : 1**（生产 36,588 行 vs 测试 23,049 + helper 2,166 = 25,215 行）口径更自洽，已在 §二 采纳。

### B.5 仍需保留判断的两处

1. **"16 个组件从未 import"与本文 §8.1 的 9 项不矛盾**——口径不同：本文表格只列**真实风险项**（按行数排序的高价值目标），它列的是全量清单。
2. **"26 个文件在模块顶层 mkdtemp"**：本文实测为 **22 个**（`^const … = mkdtemp`）。差异源于是否把"函数内 mkdtemp + 顶层改 env"计入。两者量级一致，不影响结论；本文保留 22 这一可复现口径。

### B.6 两份外部评审的共同盲点

两份都**没有**发现本文 §P0-6 的 6 处恒真断言中的 `assert.ok('analysisTask' in detail.body || true)`（第二份部分覆盖了 `listedDuringHash` 与 `submission-workspace-contracts`），也都没有给出断言消息覆盖率、覆盖映射的量化口径。**这正是"多份评审交叉"仍不能替代"逐条实测复验"的原因。**

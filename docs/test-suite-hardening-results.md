# 测试加固实施记录

本文跟踪 `test-suite-independent-review.md` 后的修复，而不是改写历史审计结论。保留开始修复前已有的工作区改动；未提交 Git。已逐文件比对修复前保存的 binary diff：原先 90 个已修改追踪文件中，8 个属于本轮定向修改，其余 82 个差异保持原样；没有覆盖原工作区的构建产物。

## 1. 本轮范围

- 修复共享数据库关闭与持久 fixture 状态造成的顺序依赖。
- 用具体响应、真实写锁和独立边界 fixture 替换无效或时序猜测断言。
- 补充真实 SQLite 仓储守卫、授权/登录/下载/CSRF 负例。
- 为 SSE、IPC、子进程和测试 runner 增加可诊断的边界与清理。
- 接入已有真实浏览器和容器测试，不另造测试框架，不调用付费模型。
- 对补测试过程中证实的安全问题做针对性生产修复。

## 2. 已实施的测试变化

### 隔离与断言（R1 / R2 / R3 / R11）

- `proxy-unavailable.test.ts`、`health-unavailable.test.ts` 独立运行真实关闭数据库后的 503 场景；正常文件不再在用例中关闭共享连接。没有给生产 DB 加自动 reopen。
- branding fixture 在每例前恢复初始行及 revision；model settings 恢复种子 channels、profiles、assignments、prompts 和 revisions。恢复事务不包裹生产自有事务。
- 知识上传失败检查前后 files、active reservations、allocations 的差量，既不依赖空目录，也不把合法的 released 记录误判为泄漏。
- 报告详情分别验证未创建任务、已入队任务与兼容 job 别名；入队场景使用独立课题，不污染后续删除测试。
- 首次分析严格为 202 / reused=false，重放严格为 200 / reused=true，且只存在一个任务。退休字段与非法字段分别断言精确状态和错误码。
- 热力图测试覆盖 0 / 1 / 12 / 13 行；报告章节同步匹配，13 行拒绝不能再由章节不匹配替它完成。
- 密码哈希回调使用可控信号；另一个真实 SQLite 连接在哈希完成前执行 BEGIN IMMEDIATE / ROLLBACK，证明写锁空闲，并证明快速更新赢得乐观锁且密码未被覆盖。

### 持久化边界（R5）

- artifact 同值重放成功，异值抛 ARTIFACT_IMMUTABLE，同批 sibling writes 回滚。
- 冻结 provider/model 不符抛 CALL_MODEL_MISMATCH，且不新增 call。
- analysis 与 insight attempt 上限分别验证成功边界和超限拒绝。
- 构造时/延迟绑定后的错 storageRoot，以及绝对路径、../ source_key，断言具体错误且无写入。
- executor fake 仅对齐测试实际使用的不可变性与 call admission 规则，不复制一套数据库实现。
- outbox 验证 created_at 优先的 FIFO、后续事件可独立 claim，以及非法 retry 时间/errorCode 不改变 leased 行。

### 异步与 runner（R6 / R8 / R9）

- SSE 读取有 deadline；静默流和提前 EOF 必须失败，取消后释放 reader lock。
- P5 IPC 等待有 deadline 并移除监听器；bootstrap 超时杀死并等待子进程关闭，失败创建的根目录也回收。新增真实子进程生命周期测试。
- runner 用 Node --import tsx --test 代替 tsx CLI，保留 tsconfig、独立工作目录、环境与退出/信号转发。长 TMPDIR 不再触发 tsx CLI 的 Unix socket EINVAL。
- 默认测试 timeout 为 60 秒，调用者可显式覆盖；不使用 --test-force-exit。
- 默认仅发现 test 顶层 .test.ts / .test.mjs，helpers 和 fixtures 不递归运行；默认发现空集退出 1，仍清理工作区。

### CI 与真实 UI（R4 / R12 / R14 的部分落实）

- verify 增加 job timeout、原失败固定种子的随机顺序回归、诊断覆盖率输出及 artifact。
- 新 browser job 构建匹配的 .runtime 与 Next dist，定位真实 Chrome，再执行既有 --p5 --ponytail 验收。
- 浏览器路径/诊断根可配置，等待和 seed 有界，子进程关闭后再结束；截图数量按实际文件统计，保留日志、截图、summary 与动作指标。
- Docker job 准备依赖和 Node 镜像，显式构建一个共享应用镜像，既运行部署 smoke，也启用默认跳过的 process-role 测试。
- TypeScript 检查纳入 test/**/*.tsx；没有声称已完成所有 MJS/checkJs 治理。CI pull 与容器测试的 Node 镜像版本也加入已有 baseline 回归，防止升级 .nvmrc 后漂移。

## 3. 新测试有效性：隔离变异验证

在私有源码克隆执行，未改真实工作区，未安装依赖；每次变异后恢复。三个目标文件的原样基线为 70 pass / 0 fail，退出 0。

| 定向变异 | 对应新测试 | 实测 |
|---|---|---|
| 热力图 maxItems 12 → 13 | 13 行且章节匹配的边界 | 46 pass / 1 fail，退出 1 |
| 删除 ARTIFACT_IMMUTABLE 守卫 | 异值不可变且 sibling writes 回滚 | 14 pass / 1 fail，退出 1 |
| reportDetail 删除 analysisTask 字段 | 详情任务与入队结果/别名一致 | 7 pass / 1 fail，退出 1 |

这些测试不是只验证它们自己能跑绿；对应的真实退化会让它们失败。另一次独立只读审查检查了 runner、异步 helper 与 CI 接线，没有发现需阻止交付的新增问题。

## 4. 安全修复与最终回归

### 4.1 补测试发现并修复的生产问题

1. **知识文件下载的符号链接边界**：旧逻辑 stat + 路径流会跟随符号链接。在存储目录被放入指向库外文件的叶或父目录 symlink 时，已登录下载者可读到外部内容。新逻辑词法 containment 后用 O_NOFOLLOW | O_NONBLOCK 打开，fstat 要求普通文件；Linux 对已开描述符的 /proc/self/fd 路径做真实根 containment，再从同一句柄流式响应并接入 request.signal。缺文件、目录、越界路径及指向库外的符号链接返回 404，其他 I/O 错误保留 500。未声称阻止拥有任意文件系统/挂载修改能力的攻击者；非 Linux 的 realpath 回退也没有完整目录竞争保证。
2. **未可信代理下的 Origin 校验**：旧逻辑无条件信任 X-Forwarded-Host / Proto，构造匹配伪造头的 Origin 能绕过该层检查。现在默认只使用 Host 和实际协议；仅显式 trustProxy=true 才采用转发头。回归包含默认拒绝/不消耗限流桶，以及独立进程中可信代理的允许和拒绝。此处验证的是来源校验层，不把服务端构造请求直接等同于完整浏览器 CSRF 利用链；已登录写入仍另有 CSRF token、SameSite 等约束。

另外补齐登录错误/失败阈值/生产 Cookie、可控 scrypt 下的真实运行槽与排队槽饱和、cancel/retry/analyze 的精确授权码与无写入，以及知识库有效会话读取/撤销会话拒绝。登录阈值使用真实失败请求和另一账号对照，不批量篡改限流桶；不依赖测试先后顺序。

### 4.2 最终稳定版验证

| 验证 | 结果 |
|---|---|
| TypeScript + noUnusedLocals / noUnusedParameters | 退出 0 |
| 默认全量 | 1051 tests，1048 pass，0 fail，3 skip；28.22 秒 |
| 原失败 seed 4180762113 | 1051 tests，1048 pass，0 fail，3 skip；30.34 秒 |
| 第二 seed 20260327 | 1051 tests，1048 pass，0 fail，3 skip；27.13 秒 |
| 全量原始 Node coverage | 1051 tests，1048 pass，0 fail，3 skip；35.28 秒 |
| 最终源码的 .runtime + Next production build | 退出 0，私有源码及依赖副本 |
| Docker context 回归 | 8 pass / 0 fail，退出 0 |
| 最终源码 Docker build + 部署 smoke | 均退出 0；覆盖 PDF/DOCX、分析/重试、重建后保留和坏 checksum 拒绝启动 |
| 最终源码镜像的 process-role 容器测试 | 6 pass / 0 fail / 0 skip；24.24 秒，含原默认跳过的 3 例 |
| 最终安全修复构建的 Chrome --p5 --ponytail | 退出 0，46 张实际截图；15 项 P5 扩展 + 20 项交互扩展；付费 provider 调用 0 |

原始 loaded-files coverage 为：行 **84.37%**、分支 **81.06%**、函数 **87.46%**。它只作诊断，不是全仓覆盖率或浏览器交互覆盖率。

三个 skip 均为依赖 Docker 的 process-role 用例，单独真实容器执行结果另列；不是把 skip 计作通过。开发中间态的失败不混入最终结果。

真实 Docker 构建还暴露了构建上下文的问题：宿主机专用 scripts/p5-contention-benchmark.ts 被复制进构建，但它依赖的 test/helpers 被安全 allowlist 排除。最小修复是从 Docker context 排除该宿主基准脚本，并补配置回归；没有把 tests 放进生产构建，也没有关闭类型检查。

## 5. 尚未宣称解决的问题

- Node 未匹配 --test-name-pattern 仍可能以文件级通过退出 0；已用回归说明平台语义，没有新增复杂自定义 reporter。CI 的全量门禁不使用名称过滤。
- 原始 Node coverage 是 loaded-files 分母，不是全仓源码覆盖率；不据此设置虚假的“全仓 80%”阈值。
- 浏览器验收已接入，但尚未批量删除所有 JSX/源代码字符串断言，也未覆盖每一种前端交互排列。
- 尚未全面迁移/类型检查所有 MJS，未一次性消除全部 imprecise negative oracle 或 integration 命名问题。
- 普通 pnpm test 仍默认跳过依赖 Docker 的 3 例；CI 专门启用并准备镜像，不能把普通测试的 skip 当作执行证据。
- runner 仍不是通用操作系统进程树管理器；本轮加强的是现有 helper 的 deadline、取消、监听器和直接子进程回收。

## 6. 复现入口

```sh
pnpm lint
pnpm test
pnpm test --test-randomize --test-random-seed=4180762113
pnpm test --test-randomize --test-random-seed=20260327
pnpm test:coverage

# 浏览器：构建和启动必须使用同一个 Next dist 配置
export YANXING_NEXT_DIST_DIR=.next-browser-ci
pnpm build:runtime
pnpm build
pnpm test:browser

# 容器：应用镜像必须来自待验证源码，不要拿旧镜像代替最终验证
docker pull node:24.20.0-bookworm-slim
export YANXING_TEST_IMAGE=yanxing:test-hardening
docker build -t "$YANXING_TEST_IMAGE" .
sh scripts/test-docker.sh
YANXING_PROC_ROLE_DOCKER_TESTS=1 pnpm test test/proc-role-scan.test.mjs --test-timeout=480000
```

临时构建副本、私有镜像及隔离测试资源已清理；证据打包为 `/home/zheye/yanxing-test-hardening-evidence-yq-Wn4X09.tar.gz`。最终原始日志、46 张截图、浏览器 summary 与动作指标转存于 `/home/zheye/yanxing-test-hardening-evidence-yq-Wn4X09/`（未保留测试数据库、Cookie profile 或存储卷）。browser summary 中的 root 是执行时的临时路径；截图相对于转存后的 browser 目录。

本机工具 shell 中使用 `corepack pnpm`；验证的 TMPDIR 放在磁盘短路径，避免本机接近满额的 /tmp tmpfs。浏览器与生产构建在私有源码/依赖副本完成，不覆盖正在使用的原工作区构建产物。

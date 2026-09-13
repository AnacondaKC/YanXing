# Ponytail 代码精简实施记录

> 状态：M01—M23 已实施并通过本轮验收。依据 [代码修改方案](ponytail-code-modification-plan.md)，不提交、不部署；原用户审计保持不变。

## 1. 原始基线与隔离

- 原 HEAD：`ffe4e7a0204277978c3b1d8e352a730affd0f89f`。开始时已有用户修改 `docs/ponytail-audit-merged.md`，保持原样。
- 原始代码、用户审计和方案副本：`/tmp/yanxing-ponytail.upm4fM`。不复制 `.env.local` 或业务数据；副本依赖为自身真实目录。
- Node `v24.20.0`；`corepack pnpm --version` 为 `11.18.0`；Chrome `152.0.7977.82`；Docker Server `29.8.0`。
- 严格类型检查 + 全量隔离测试：`node node_modules/typescript/bin/tsc --noEmit --incremental false -p tsconfig.source.json --noUnusedLocals --noUnusedParameters && node scripts/run-tests.mjs`，退出码 0。
- 原始 Next build 通过。首次 runtime 构建因 node_modules 软链接导致追踪路径在副本外被拒绝；改用副本内依赖后重跑 `node scripts/build-runtime.mjs` 通过（1158 trace files），没有放宽追踪安全检查。
- 原始浏览器：副本内 `YANXING_NEXT_DIST_DIR=.next node test/helpers/native-browser-smoke.mjs --p5`，退出码 0；19 张截图、确认重试与协作者/移动端等检查通过，`paidProviderCalls=0`。附件目录 `/tmp/yanxing-p5-browser-Xr07pw`。
- 后续新增的定向浏览器测试可复制到原副本执行；原副本生产代码保持不变，作为视觉与行为对照。

## 2. 逐项状态

下表“已验收”包含定向测试与最终集成验收；前端另有真实 Chrome 截图、动画和交互证据。各组测试存在重叠，不相加作为总测试数。

| 项目 | 状态 | 实施与验证摘要 |
|---|---|---|
| M01 | 已验收 | 删除死 sidecar 缓存、共享取消与旧裁剪；保留 throwIfParserAborted；文档/存储/worker 构建相关 56 测试通过 |
| M02 | 已验收 | pipeline 直用任务端口，保持 ledger/租约/迟到核销/质量失败语义；新增取消+质量失败、ledger 恢复等行为用例 |
| M03 | 已验收 | 只删旧 Project/ReportInsight 声明、12 死字段与常量；22 测试通过 |
| M04 | 已验收 | 迁移外来再导出与测试包装；reducer 行为不变；与 M13 合跑 121 测试通过 |
| M05 | 已验收 | 同一个两阶段循环处理文件和 sidecar，保留不同保护计数顺序；7 个新增竞态用例在原/新实现均通过，存储套件 26 测试通过 |
| M06 | 已验收 | 仅共用 sparkline 几何，保留各图分支；与 M11/M20 合跑 39 测试，原/后 SSR 总计 25/25 相同 |
| M07 | 已验收 | 删除模块接口，直调 prompt builder；原提示词断言迁到真实入口 |
| M08 | 已验收 | 共用宿主扫描；显式 Docker 专项 15/15 通过，真实 worker/web 故障后 RestartCount 0→1→2、StartedAt 更新且均恢复 healthy；3 容器项默认 opt-in，避免给普通测试强加 Docker/本地镜像依赖 |
| M09 | 已验收 | 五处共用最新请求守卫，保留页面 fetch/状态策略；32 相关测试通过，外部监听寿命补强后 12 守卫用例通过 |
| M10 | 已验收 | 五处 timer 均已替换并保持三种取消语义；与 B3 及 SSE/限流/worker 流程合跑 87 测试通过 |
| M11 | 已验收 | 仅共用同文件完全相同的 SVG 装饰；独有 quality/characters/success 保持，39 相关测试通过 |
| M12 | 已验收 | 保留三类可见文案，删除未渲染字段；8 静态测试通过 |
| M13 | 已验收 | 两处测试 deferred 改 Promise.withResolvers；与 M04 合跑 121 测试通过 |
| M14 | 已验收 | 用户类型以 domain 为唯一来源，保留必要类型别名；23 测试通过 |
| M15 | 已验收 | 删除两 snapshot 包装，保留 InDatabase 和解密活入口；29 测试通过 |
| M16 | 已验收 | 新 outbox 写 {}，旧载荷不改；从真实阶段表保留原业务断言；两格式投递/不可变测试及相关套件 40 测试通过 |
| M17 | 已验收 | 事件仅传消费的 type，含洞察调用；保留 safePublish 策略及真实事件序列断言 |
| M18 | 已验收 | 删除纯桥接，原 aside/服务端边界保持；70 静态测试通过 |
| M19 | 已验收 | 备份测试直连真实模块，保留 acceptance 内部调用；24 测试通过 |
| M20 | 已验收 | 原生 SVG 保留 visx 非对称 gap；6 组真实原/后热力图 SSR 逐字节相同；实际 Chrome 的 14 张图表截图一致，依赖已删除 |
| M21 | 已验收 | 删除存储根导入快照，probe 动态 getter；7 测试通过 |
| M22 | 已验收 | 一行 type-only 再导出；10 测试通过 |
| M23 | 已验收 | 通知条 150ms fade，菜单 100ms fade+scale3d，均 ease/forwards；保留 origin/定位/核心 duration 类；实际普通与减少动态效果帧一致，依赖已删除 |

## 3. 已取得的关键行为证据

- M05 新增引用、预留、同尺寸/mtime 但 inode 不同的替换、sidecar 源文件出现共 7 个场景，先在旧实现执行、再对重构执行，均通过。每轮断言初始保护读取 + 文件刷新 + sidecar 刷新合计 3 次；源存在/受保护的 sidecar 静默跳过，普通文件保护仍计数。没有新增长事务或每候选全表查询。
- M16 既有 confirmSubmission 测试不再读取冗余 payload.workflow，而从真实 project_stages 断言 in_progress；新增空载荷/旧 workflow 载荷两种 fixture 的可靠投递及原文不变检查。
- M10 `Analysis cancelled` 与中文 DOMException 哨兵保持；SSE/worker 原本取消 resolve 的路径仅吞定时器 AbortError，不吞普通异常。
- M09 外部 abort 监听使用原生 `{ once: true, signal: next.signal }`。新请求/失效/卸载即时卸监听，无需等忽略取消的旧请求 finally；`getEventListeners` 断言证实归零，旧 `end` 不干扰新请求，当前 `end` 后仍能完成 loading 收尾。
- 独立只读复核对照原始副本确认 M05/M10/M16 没有发现删除、取消或清理语义回归。
- M04 `tokensReady=false` 不提交、uncertain 保留原幂等键等 reducer 断言保留，不用强制类型断言掩盖迁移。

## 4. 总体验收

- [x] 当前全部业务改动严格类型检查、全量隔离测试：1009 项，1006 通过，0 失败，3 个 Docker 集成项默认跳过且已单独运行通过。依赖删除后的隔离副本全量复检仍为上述结果。
- [x] 修改后副本 `/tmp/yanxing-ponytail-final.s4LisF`，无 `.env.local`；frozen-lockfile 安装和 Next/Worker/CLI 构建通过（1158 trace files）。复制依赖目录触发 pnpm 11 迁移检查，先在该副本 CI 重装；离线缺缓存的 @next/env，改为正常 registry frozen 安装后通过，不改锁定版本。依赖删除后再次 frozen/offline 安装、严格类型检查和构建均通过；最终 CSS 仍为 `0a08c6835ee15d4d.css`。初次副本全量测试因过宽排除 `.env*` 缺少公开 `.env.example`，仅补回全注释模板后通过；没有复制真实配置或放宽测试。
- [x] `YANXING_PROC_ROLE_DOCKER_TESTS=1 node scripts/run-tests.mjs test/proc-role-scan.test.mjs test/test-docker.test.mjs test/p5-package-container.test.mjs`：15/15。仅唯一名新容器、无网络、只读根、tmpfs 存储，finally 清理；无生产容器或镜像更改。
- [x] 前端专项动画与异步交互对照通过（最终证据见第 5 节）。原/后完整 `--p5` 均通过，修改后目录 `/tmp/yanxing-p5-browser-n3HLRI`。19 张截图中 18 张 PNG 逐字节相同；第 12 张只因采样时刻 17:01→17:40，差异为 180 像素，全部位于 x=846–857、y=446–453 / 751–758 两处时间数字区域，其余像素完全相同。没有扩大阈值或改变布局。
- [x] 原/后 25 组图表 SSR 对照（`/tmp/yanxing-b7-ssr/compare.json`）全部相同。重捕修正了“待分析”标签误搜和空输出哨兵两个证据生成错误，不修改生产代码或伪造相等结果。
- [x] `@visx/heatmap`、`tw-animate-css` 从 manifest / lock / 许可证表删除；锁文件由 pnpm 生成，仅删除对应条目，没有升级其他包。副本内两包实际不存在，hierarchy / wordcloud 仍存在；runtime manifest 不含扫描测试 helper。
- [x] 逐项复核、`git diff --check` 和用户审计与保留副本的 `cmp` 通过；未留 `.tmp-*` 源码脚本，未提交或部署。

## 5. 浏览器证据与复跑

- 原/后第一组专项目录：`/tmp/yanxing-p5-browser-U1bqKE` / `/tmp/yanxing-p5-browser-QxgLxd`，各 60 PNG。56 张逐字节相同，其中包含全部 12 张普通/减少动态效果动画帧和全部 14 张图表渲染。三处圆角/阴影边缘仅有 1 / 36 / 5 个像素、最大通道差 1 / 2 / 1；另一张加载图差异仅为 16×16 spinner 的采样相位，后续测试固定无限动画相位再复核。没有用宽松像素阈值掩盖布局差异。
- 全量 metrics 仅有通知 `transform: identity` 与 `none` 的等价序列、CSS 文件名和完成时间差异；对应 16 元矩阵、translate=-50%、位置、透明度、focus、SVG 几何、可见内容及真实系统字体均相同。
- 菜单 100ms、通知 150ms；关键帧 easing=ease，WAAPI effect timing 显示 linear 是正常层级差异；半程 opacity=0.802403，终点=1。减少动态效果时两边均为 0.01ms。通知末帧改为即时截图，避免测试的 850ms 等待跨过 2800ms 自动消失期限，不修改业务计时器。
- 实测加载/错误/重试、知识库 React 卸载取消、设置重进、通知与设置 Escape 焦点还原。图表用应用 CSS、同一 font-sans/antialiased body；CDP 记录实际 Noto Sans CJK SC 字体，而不把 fonts.ready 当作字体加载证明。
- 最终复核：原 `/tmp/yanxing-p5-browser-TNUhsv`，依赖删除后的改版 `/tmp/yanxing-p5-browser-EBH0Ty`，均 exit 0，21 个专项检查，知识库在途请求经真实 React 卸载后 signal.aborted=true，返回页面/错误重试恢复。除上述单位矩阵与 none 的等价表示、文件名和时间元数据外，metrics 全字段相同。
- 最终 60 张中 52 张 PNG 逐字节相同：第 12 张仅两处提交时间数字（154 像素）；第 33/35 张仅三位测试用户登录时间（各 174 像素）；其余五张仅背景卡片右端 40 / 8 / 8 / 8 / 8 个圆角边缘像素，最大通道差 2。菜单三帧的差异位置均在菜单外的同一卡片圆角（x=1389–1391, y=292–295）；动画本体无像素差异。加载 spinner 相位固定后原/后相同，所有图表截图相同。
- 一次追加检查的原副本 Chrome 在既有 DOCX 浏览阶段无响应，新专项尚未执行；只关闭该次拥有的页面以让 harness 正常进入 finally 清理，再独立重跑通过。未修改原生产代码、DOCX 断言或超时来掩盖问题。

隔离副本内复跑（不得从含真实 `.env.local` 的工作树直接启动浏览器测试）：

```sh
PONYTAIL_SSR_FIXTURES=/tmp/yanxing-b7-ssr \
YANXING_NEXT_DIST_DIR=.next NEXT_TELEMETRY_DISABLED=1 \
node test/helpers/native-browser-smoke.mjs --p5 --ponytail
```

`PONYTAIL_SSR_FIXTURES` 是本次原/后 HTML 证据目录，可省略以只跑应用交互；显式传入时缺失片段或 CSS 会失败，不会静默当成已验收。`.tmp` / `/tmp` 截图、数据库和构建均为隔离验收产物，不是生产部署。

## 6. 实际改动规模

统计口径：相对上述 HEAD，包含新文件，排除用户原有审计修改；源代码包括应用与运维/验证工具脚本，测试和文档分列，不用原方案估计值充当结果。

- 最终统计：生产/工具源码 57 个文件，+419/−1054，净减少 635 行；测试 30 个文件，+1508/−220，净增加 1288 行；文档 3 个文件，+425/−2；manifest/lock 2 个文件，净减少 30 行。合计 92 个改动文件（含 4 个删除），测试增量主要用于竞态、容器恢复和真实浏览器验收。
- 直接依赖减少 2 个；没有新增生产依赖。保留所有被标记为必须保留的安全、租约、可靠投递和 UI 分支，不以凑删除行数为目标。

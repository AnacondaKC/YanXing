# YanXing 简化审查：结论与证据

> 状态：**D0、A1—A7、B1—B4，以及 C 中“分析/洞察原文件抽取回退”单项已实施并通过集成验证。** 原审查的只读/隔离副本结果作为历史证据保留；原批次实际结果见 §11，C 单项结果见 §12（971/971）。B5 与其余 C 项未实施；未提交、未部署；未执行浏览器/容器验收。
> 历史比较基线：v0.1.2（6660fda）；本次实施起点 HEAD 为 dcf6f23，含全部未跟踪实现。
> 日期：2026-09-13

---

## 0. 一句话结论

原审查时点的工作树是相对 v0.1.2 的一次**横向重写**（约 −9,235 行 / +13,596 行，净 +742 行），
其中七项删除建议经独立复核均成立：**4 项上一轮已发现、3 项遗漏、0 项误报**。遗漏为 reportFileContentType、INITIAL_AI_SETTINGS_VERSION、comparisonFor。−44 行是原隔离实验记录，不是当前实施的固定目标。
不能据此认定其余候选均已排除；连带死调用链、旧报告模型和 B1—B4 完善项见 [实施方案](simplification-remediation-plan.md)，保留/暂缓边界见 §6。
另有一项**测量错误**在复核中被发现并更正（§2.3），任何引用本审查早期版本的人必须看该节。

---

## 1. 原审查范围与方法（历史记录）

| 项 | 内容 |
|---|---|
| 模式 | Survey（只读）+ 隔离副本内 Change 验证 |
| 范围 | Broad（全仓库） |
| 隔离验证目录 | /tmp/yx-verify（工作树完整副本，8.9M，软链 node_modules） |
| 真实工作树 | **未被写入**。全部写操作在 /tmp |

### 1.1 方法修正（重要）

本次审查中途更换了判定方法，因为前两版方法被证明不可靠：

| 方法 | 结论 | 为何作废 |
|---|---|---|
| ① 正则 grep 导出 + 统计引用 | 报 209 个"死导出" | 把"自己文件内使用"误判为死 |
| ② TS Compiler API 消费者图 | 报 18 个，后修至 7–48 个 | 三轮迭代中每轮都被下一轮推翻 |
| ③ **文件内重命名 + tsc**（最终采用） | **7 个** | 见 §3，基线可证伪 |

**为何 ② 不可信**：两个版本分别报告"导出总数"为 1295 与 1264，自相矛盾。
已定位到具体缺陷：错误地把 obj.PROP 的属性名位置也当作符号引用，
导致 runtimeConfig、workspaceErrorCopy、PROJECT_FIELD_LIMITS、storageUnavailableErrnos、
SUBMISSION_TASK_DATA_KEYS 等**实际活跃**的符号被误报为死。
这些符号都经 tsc 证实在 2–10 个生产文件中被使用。

**③ 的适用边界**：重命名后 tsc 通过，只能说明当前编译范围内没有发现静态引用断裂。它不能单独排除未检查的脚本、动态属性访问、框架约定导出或库外消费者；allowJs 不等于对所有 JavaScript 开启检查。七项结论还依赖独立的生产/测试/脚本消费者与运行入口核查。基线先行校验（§3.1）。

---

## 2. 原审查基线测量（历史快照，不随本次剪切重算）

### 2.1 仓库规模（生产代码 = app components lib modules worker scripts 下的 .ts/.tsx）

| 指标 | v0.1.2（tag 检出） | 当前工作树 | 净变化 |
|---|---|---|---|
| 生产文件 | 215 | 263 | **+48** |
| 生产行数 | 37,110 | 37,852 | **+742** |
| 测试文件 | 89 | 128 | **+39** |
| 测试行数 | 15,205 | 23,736 | **+8,531** |

**变更性质（关键）**：不是单纯扩张，而是横向替换 ——

| 集合 | 文件数 | 行数 |
|---|---|---|
| v0.1.2 有、当前已删 | 35 | 9,235 |
| v0.1.2 无、当前新增 | 83 | 13,596 |
| 两端都有（被改写） | 180 | 27,875 → 24,256（**−3,619**） |

即：**改写不是净增 13k 行，而是替换约 9.2k 行、新写约 13.6k 行。**

### 2.2 验证基线（本次采集，可复跑）

```bash
export PATH=/home/zheye/.nvm/versions/node/v24.20.0/bin:$PATH
cd /home/zheye/VibeCoding/YanXing
./node_modules/.bin/tsc --noEmit -p tsconfig.source.json          # exit 0
./node_modules/.bin/tsx scripts/run-tests.mjs                     # 963 tests / 963 pass / 0 fail
```

测试数 **963**（ℹ tests 963 / ℹ pass 963 / ℹ fail 0）。

### 2.3 ⚠️ 已更正的测量错误

本审查**早期版本**（以及转述它的审查方案）包含一处错误数字，现更正：

| | 早期声明 | 实测（正确） |
|---|---|---|
| v0.1.2 生产 LOC | 24,441 | **37,110** |
| v0.1.2 生产文件 | 215 | 215 ✓ |
| 净变化 | "+13,411 行" | **+742 行** |

**错误根因**：早期用 git ls-tree -r v0.1.2 --name-only 取路径清单，
再在**当前工作树**里 wc -l 那些路径。但 v0.1.2 的 217 条路径中有 **35 条已不存在于工作树**，
xargs wc -l 对缺失文件静默返回 0 行，导致总数被低估约 12,700 行。
（wc 报"总计 24441"，但其中 35 个文件贡献为 0。）

**正确做法**：git archive v0.1.2 | tar -x 到临时目录后测量。

```bash
set -euo pipefail
MEASURE="$(mktemp -d /tmp/yanxing-v012-measure-XXXXXX)"
git archive v0.1.2 | tar -x -C "$MEASURE"
# 仅在该导出目录中统计 app/components/lib/modules/worker/scripts 的 .ts/.tsx。
# 原测量结果为 37110；不要改用当前工作树中同名路径，也不要清空固定共享目录。
```

**对结论的影响**：无。候选判定不依赖 LOC 数字，只依赖符号可达性。
但"v0.1.2 之后代码库大幅膨胀"的叙述**是错的**，必须废弃。

### 2.4 git diff v0.1.2 为何具有误导性

```bash
git diff --numstat v0.1.2 -- . | awk ...
# tracked 文件：+4,568  −21,178  净 −16,610
```

该历史 diff 统计只覆盖其 Git 跟踪范围，不包含全部未跟踪实现，因此不能单独代表完整工作树的净变化。历史手工补加仍不一致，说明当时计数范围没有对齐，不应归结为 Git diff 本身无效。

git diff v0.1.2 对其覆盖的文件仍是有效差异证据；完整规模比较必须对齐文件类型、路径集合和时点，并包含未跟踪文件。不要混用“全部跟踪 diff”与“.ts/.tsx 生产代码”两种口径。

---

## 3. 判定方法：文件内重命名探针

### 3.1 探针定义与基线校验

```text
对候选符号 S（位于文件 F）：
  1. 校验 tsc 基线干净            -> 否则中止
  2. 在 F 内把所有 word-boundary S 替换为 __renamed_probe__
  3. 运行 tsc --noEmit -p tsconfig.source.json
  4. 恢复 F
判定：tsc exit 0 => 当前编译范围未发现引用断裂，仍须追踪运行入口、脚本及动态/外部消费者
      tsc 报错   => 先区分真实引用断裂与改名冲突/语法错误，再分类
恢复：从剪切前实际工作树快照恢复，不从 HEAD 恢复未跟踪文件
```

**为何必须校验基线**：若基线本就不干净，就无法区分"因改名而报错"与"原本就报错"。
本次基线校验结果：baseline tsc status = 0 (clean)。

### 3.2 原扫描结果（仅线索，非完备消费者证明）

原扫描用“名字不出现在其他文件原文中”缩小范围；这不是必要条件，同名无关符号、文档和测试夹具都会影响筛选。因此下面是历史扫描结果，不证明只有七项值得删除：

```text
total exports                                 : 1295
名字不出现在任何其他文件（启发式筛选）         : 候选集
重命名后 tsc 仍 exit 0（仅静态探针结果）        : 176
其中重命名后 tsc 报错（即实为活）              : 0
```

**原扫描对 176 项的分类（动态与框架契约未逐项核验）**：

| 分类 | 数量 | 含义 |
|---|---|---|
| A. 完全无使用（连自己文件内都不用） | **7** | 可整体删除 |
| B. 仅自己文件内使用 | 169 | 仅需去掉 export 关键字 |

**B 类不建议处理**（见 §6）。

---

## 4. 原隔离副本已实测的七项剪切（当前实施另见 §11）

### 4.1 清单

| # | 文件 | 符号 | 删行 |
|---|---|---|---|
| 1 | components/ui/file-dropzone.tsx | reportFileContentType | 6 |
| 2 | lib/db/initial-ai-settings.ts | INITIAL_AI_SETTINGS_VERSION | 2 |
| 3 | lib/db/settings-repository.ts | getAiPromptConfiguration | 4 |
| 4 | lib/documents/report-storage.ts | parseContentLengthHeader | 8 |
| 5 | lib/reports/server-runtime.ts | bindSubmissionServerRuntimeForTests | 7 |
| 6 | modules/reports/domain.ts | ReportHistoryEntry | 6 |
| 7 | modules/reports/workspace-query.ts | comparisonFor | 11 |
| | | **合计** | **−44 行** |

**裁剪必须低于文件粒度**：这些文件均可能包含活消费者；保留 ReportSource、SubmissionComparison、host 等存活声明。不得把删除声明扩大成删除整个文件。

### 4.2 残渣检查（每符号全仓仅 1 处命中 = 声明本身）

```bash
for s in reportFileContentType INITIAL_AI_SETTINGS_VERSION getAiPromptConfiguration \
         parseContentLengthHeader bindSubmissionServerRuntimeForTests ReportHistoryEntry comparisonFor; do
  echo -n "$s: "
  grep -rn "\b$s\b" --include='*.ts' --include='*.tsx' --include='*.mjs' \
    app components lib modules worker scripts test proxy.ts | grep -v node_modules | wc -l
done
# 全部输出 1
```

上面的历史命令不搜索文档，不能证明“文档零引用”；本报告和方案就保留了这些名字。复核结论是七项无活跃运行消费者，不要求历史文档或负向测试零命中。

### 4.3 连带简化（同一所有权边界）

bindSubmissionServerRuntimeForTests 是 lib/reports/server-runtime.ts 中
let bound 的**唯一写入者**。删除后：

```ts
// 删除前
let bound: SubmissionServerRuntime | undefined
let host: SubmissionServerRuntime | undefined
export function bindSubmissionServerRuntimeForTests(runtime) { bound = runtime; if (runtime === undefined) host = undefined }
export function getSubmissionServerRuntime() {
  if (bound) return bound                                    // <- 永假分支
  return host ??= createSubmissionServerRuntime({ ... })
}

// 删除后
let host: SubmissionServerRuntime | undefined
export function getSubmissionServerRuntime() {
  return host ??= createSubmissionServerRuntime({ ... })
}
```

这**减少了一个概念**（"测试可注入的运行时宿主"并行状态），不只是删行。
它是同一所有权边界内的连带，不是跨边界扩张。

复核还发现原剪切未收完的链：getAiPromptConfigurationInDatabase 仅被 getAiPromptConfiguration 调用，应一并删除；ReportHistoryEntry 所属旧 ReportVersion 模型仍由死选择器与测试夹具供养，按 B1 整体退役，保留 ReportSource。

### 4.4 剪切边界 = 文件粒度以下，需严格 lint 才能看见

删除 comparisonFor 后，workspace-query.ts 的两个导入失去唯一用途：

```text
modules/reports/workspace-query.ts(16,3): error TS6133: 'resolveSubmissionComparison' is declared but its value is never read.
modules/reports/workspace-query.ts(17,8): error TS6133: 'ComparisonSubmission' is declared but its value is never read.
```

**但 type SubmissionComparison 仍然被 :77 与 :93 使用，必须保留。**
这证明：候选的裁剪边界落在文件内部，只有 --noUnusedLocals 能发现遗漏。

---

## 5. 验证环（逐环独立报告）

以下是原报告自述的隔离副本 /tmp/yx-verify 历史结果，本次未重新取得该副本的执行记录；不得与本次实施验证混写。第 3 行的“各 1 命中”对应剪切前声明盘点，不是剪切后的残留结果：

| 环 | 命令 | 结果 |
|---|---|---|
| 1 基线校验 | tsc --noEmit -p tsconfig.source.json（剪切前） | exit 0 ✓ |
| 2 决定性命中 | 同上（剪切后） | **exit 0** ✓ |
| 3 剪切前盘点 | 7 符号源码 grep | 各 1 声明命中；不是剪切后验证 |
| 4 本地门禁 | tsc ... --noUnusedLocals --noUnusedParameters | **exit 0**（首轮报 2 个遗留导入，修复后通过） ✓ |
| 5 仓库门禁 | tsx scripts/run-tests.mjs | **963 / 963 pass，0 fail，0 skipped** ✓ |
| 6 边界对照 | 7 文件逐一 diff 真实树 ↔ 副本 | 仅 7 文件不同，全部为删除 ✓ |

```text
ℹ tests 963
ℹ pass 963
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

### 5.1 未执行的环（必须视为未验证）

| 环 | 状态 | 影响 |
|---|---|---|
| 生产构建 next build | **未运行** | 无法断言构建产物无碍 |
| build:runtime / .runtime 重生成 | **未运行** | 现有 .runtime 为 1158 文件的旧构建 |
| Docker 装配 build:docker | **未运行** | 容器路径未验证 |
| 浏览器 / 视觉验收 | **未运行** | 7 个符号均非 UI，风险低但未证 |
| 剪切**未应用到真实工作树** | 有意为之 | 见 §7 |

---

## 6. 拒绝的候选（含理由）

| 候选 | 判定 | 依据 |
|---|---|---|
| **R15**：统一 storage_usage 三套预留谓词 | **拒绝** | 见 §6.1 —— 不可达状态，无缺陷 |
| 169 个“仅自身使用”导出的 export 关键字 | **不批量处理** | private 包仍可能有框架/动态契约；未逐项核验，且单纯移除关键字收益低 |
| R14：抽取回收谓词公共只读查询 | **降级** | 三处谓词归一化后**字节相同**（仅 NOT EXISTS( 空格差异），属去重，非缺陷 |
| 合并 SubmissionTaskStore → Port | **拒绝** | 租约绑定在 port factory；合并是搬家不是少义务 |
| 合并两个 Worker 入口 | **拒绝** | docker-supervisor.mjs:12 固定 .runtime/worker/index.mjs；submission-index.ts 是 M01 刻意加固的备用 CLI，所有权不同 |
| lib/db/client.ts 再导出 schema error | **拒绝** | scripts/migrate.ts:5,12 实际调用 isNativeSchemaError |
| 删 scripts/relocate-storage.ts | **产品门** | build-runtime.mjs:25 仍是编译入口，.runtime/scripts/relocate-storage.mjs 已生成 |
| schema 休眠列 | **关闭** | 74 列全部有生产消费者 |
| 四个仓储方法重叠 | **证据不足，暂缓** | 方法名零重名不证明行为不同；事务包装还存在 BEGIN 位于 try 内/外的真实差异，不能直接合并 |
| pipeline.ts 死模块路径 | **关闭** | pipeline.ts:50 定义 definition = pageAnalysisModule；AnalysisModuleIds = ['page_analysis']，构造上单模块 |

### 6.1 R15 的完整证伪记录

早期版本声称："维护刚写完的 storage_usage 计数会被审计判 QUOTA_COUNTER_MISMATCH"。
**该结论错误，根因是制造了不可达状态。**

**结构性证明**：storage_reservations 在整个生产代码中**只有 2 个 INSERT 点**：

```bash
grep -rn "INSERT INTO storage_reservations" --include=*.ts lib modules worker scripts app
# lib/storage/quota.ts:73
# lib/storage/submission-reconciliation.ts:10
```

- quota.ts:44-77 reserveStorageQuotaInDatabase：**先**在 :53-68 用条件 UPDATE 递增
  reserved_bytes/reserved_count（WHERE ... changes===1 否则抛错），**后**在 :73 INSERT 预留行。
  两者在同一事务内（调用方 reserveStorageQuota 经 inImmediateTransaction）。
- submission-reconciliation.ts:10：SELECT ... FROM report_uploads WHERE 1 全量 upsert，
  随后 :31-32 立即零化并重算 storage_usage。

**收窄后的结论**：已核查的正常生产生命周期未发现维护后计数与审计预期不一致的反例，不将 R15 作为代码缺陷。knowledge 预留 TTL 到期但尚未释放时，active 与 active AND expires_at>t 两谓词可以不同；此时相关计数路径保留 active 预留。maintenance 在同一事务、同一时间戳下先 expireNonUploadReservations，再重建计数；报告上传预留使用持久化到期哨兵。构造证据依赖这些顺序和当前写入点，不是仅凭两个 INSERT 或 11 条样本即可推出任意状态等价。

**实证**：11 条真实生命周期序列 fuzz（knowledge/report 混合预留 × TTL 内/外 ×
maintenance/dry-run/重复 maintenance 交错）：

```text
sequences run: 11 | divergent: 0
HISTORICAL VERDICT (overstated): the two predicates never disagree on any reachable state.
CORRECTION: 11 sampled sequences showed no accounting divergence; predicates are not universally equivalent.
```

**早期分歧的真实来源**：探针直接 INSERT 了一行 storage_reservations 而不同步计数器，
随后审计正确地报告了不一致 —— 那是探针制造的污染，不是产品缺陷。

---

## 7. 原审查未应用剪切的原因（历史决定）

真实工作树现有 **330 个未提交条目**（152 未跟踪 / 54 删除 / 124 修改），全部来自 v0.1.2 之后的 M01–M14 改造，
**尚未分化成可审查的提交**（docs/post-v0.1.2-remediation-plan.md §17.3 自己要求按边界切小提交）。

当时选择保持只读。未分化成提交不是技术阻塞：本次用户已授权实施，通过保存实际工作树快照和逐批差量来区分原有改造与简化。没有 commit/push 授权，不自动提交。下面的 mtime/状态记录只属于原审查时点，不代表当前树零写入。

### 7.1 真实工作树完整性的证据

```bash
git status --porcelain | wc -l      # 330
# 所有源码文件 mtime 均早于本次会话（会话时间 2026-09-13 09:0x–09:3x）：
find app components lib modules worker scripts test \( -name '*.ts' -o -name '*.tsx' -o -name '*.mjs' \) \
  | xargs stat -c '%y %n' | sort -r | head -1
# => 2026-09-13 08:25:02  lib/rendering/graph-layout.ts
```

**关于 porcelain 从 331 → 330 的一处变化**：用户本机运行着 next dev（PID 313445），
其 next-server 于 09:26:59 重启、09:27:01 重写了 next-env.d.ts，使其与 HEAD 字节一致，
因而不再计入未提交集合。**该变化由外部进程产生，非本审查所为**；
本审查的全部写入均在 /tmp/yx-verify（已删除）与 /tmp 探针脚本中。

---

## 8. 残余风险与不确定项

| 项 | 性质 | 需要什么才能消解 |
|---|---|---|
| 未跑生产构建/Docker | 验证缺口 | 在噪声隔离副本内跑 pnpm build 与 build:docker |
| .runtime 为旧构建 | 验证缺口 | 跑 pnpm build:runtime 后核对清单 1158 文件 |
| out/ 存在幽灵引用 | **已确认，未处理** | out/p5-final-candidate/.runtime/scripts/reconcile-submission-usage.mjs 与 p5-verified-candidate 同路径的源 scripts/reconcile-submission-usage.ts **已删除**；.next-p5-qa/standalone/package.json:25 仍保留指向不存在文件的 usage:reconcile npm script。属构建残留，非源码问题 |
| 169 个 B 类导出未做值/类型分类 | 未决 | 需按 SymbolFlags 分列；即便分类完成，收益仍为"可选性"而非行为 |
| 提交边界 | **工作组织/权限边界** | 可以先按所有权边界实施并记录差量；commit/push 另需授权 |

---

## 9. 复现步骤（安全边界修订）

1. 在真实工作树读取源码并采集基线；保存 HEAD、完整 -uall 清单、staged/unstaged diff。
2. 用 mktemp -d 建立唯一私有目录，按明确文件白名单复制实际源码、测试和配置（包含未跟踪文件）。不复制私密 .env、业务 storage、主密钥、历史 out/ 或 .runtime。不要用固定 /tmp/yx-verify 的 rm -rf。
3. 在隔离目录配置 node_modules，先运行以下基线；失败即停止。探针前另存目标文件的实际字节与哈希，完成后从该副本恢复。workspace-query.ts 原本不在 HEAD，禁止 git show HEAD:路径 > 当前文件。
4. 只在副本做探针或剪切；编译通过仍需核对脚本、框架、动态/外部消费者。实际实施后的测试数可因删除死功能测试变化，必须解释而非硬凑 963。

验证命令（在准备好的隔离源码目录执行）：

- node node_modules/typescript/bin/tsc --noEmit --incremental false -p tsconfig.source.json --noUnusedLocals --noUnusedParameters
- YANXING_CHAT_COMPLETIONS_API_KEY='' node scripts/run-tests.mjs

历史规模测量同样使用唯一临时目录导出 v0.1.2，并在导出目录而非当前树统计；只在确认文件属于本次临时目录后清理。§2.3 已将导出示例改成唯一临时目录；历史测量结果仍只代表原审查时点。

## 10. 本次实施顺序与未授权动作

1. 按 [修改与完善方案](simplification-remediation-plan.md) 执行 D0、A1—A7、B1—B4；B5 与 C 暂不实施。
2. 每个所有权边界先定向测试，再检查连带死代码；最终统一做严格编译、全量测试及隔离构建。
3. 本次实施前快照：/tmp/yanxing-simplify-before-XA916F/source；manifest.json 记录文件哈希，Git 差量单独保存。该路径是本次恢复资料，不是永久依赖。
4. 不自动 commit/push、发布镜像或部署；不清理 out/ 历史候选。其保留供审阅的记录仍有效；如需清理，应另行确认路径和保留策略。
5. 当前真实实施与各验证层结果以 §11 为准，不用旧 /tmp/yx-verify 的输出冒充本次验证。

---

## 附录 A：本审查的自身错误清单

供评审人判断证据可信度：

| # | 错误 | 发现方式 | 更正 |
|---|---|---|---|
| 1 | 用 ls-tree + 当前树 wc 测 v0.1.2，得 24,441 行（真值 37,110） | 交叉核对 LOC 账目不平 | §2.3 |
| 2 | 正则扫描把"文件内自用"判为死导出（209 项） | 抽样 grep 发现被自己文件引用 | §1.1 |
| 3 | 排除属性访问位置，致 runtimeConfig 等误报为死 | 用 grep 交叉验证 | §1.1 |
| 4 | R15 报"真实缺陷"，实为探针制造的不可达状态 | 改真实 API 重测 + fuzz | §6.1 |
| 5 | taskWouldRegress 被扫描器判为死 | 内置 sanity 断言清单捕获 | §1.1 |

**共同根因**：先接受结论框架，再造证据，而非从真实写入路径反推可达状态。
改用重命名探针并未消除证明过度的问题。后续复核还纠正了：tsc 被当作全仓无消费者的充分条件、从 HEAD 恢复未跟踪文件、R15 谓词普遍等价、剪切前命中被列为剪切后残留检查；七项删除结论仍由独立调用链证据支持。

## 附录 B：确定性结论 vs 推断

**确定性（有可复跑命令支撑）**：
- 生产代码 v0.1.2 → 当前：215→263 文件，37,110→37,852 行
- 测试 963/963 通过；tsc 与严格 lint 均 exit 0
- 七项删除建议经独立消费者复核成立；历史文档保留名字不是运行消费者
- storage_reservations 仅 2 个 INSERT 点
- 176 是历史静态探针通过数，不是已证明的全仓无消费者数

**推断（未经端到端验证）**：
- "改写性质是横向替换"（基于文件集合差，非全量 diff 审计）
- "B 类 169 项无价值"（未做逐项值/类型分类）
- 构建与容器路径不受影响（未跑）

**未决**：
- commit/push 授权；现有未提交工作按快照和逐批差量保护
- 169 项的价值判断
- out/ 残留是否需清理

## 11. 本次实施记录（D0、A、B1—B4）

### 11.1 基线、权限与实际差量

- 用户在方案生成后明确授权实施。本次范围为 D0、A1—A7、B1—B4；B5 和 C 未执行。未 commit/push、未发布镜像、未部署、未清理历史候选。
- 实施前 HEAD：dcf6f23194c2a9d547c82928ce22aa59713eac83。已重新运行严格 TypeScript 与全量隔离测试，结果 **963/963，exit 0**；不是复用原报告自述结果。
- 恢复目录：/tmp/yanxing-simplify-before-XA916F。source/ 保存 489 个实际源码/配置文件，包含未跟踪实现；manifest.json 记录哈希，status.txt、staged.diff、unstaged.diff、tracked.diff 保留原有 Git 状态。临时快照不是持久发布产物，不应在需要回退前清理。
- 相对上述快照而非 HEAD 计算：**13 个源码/脚本文件 +41/−213，净 −172 行；6 个测试文件 +165/−45，净 +120 行；另完善本报告和实施方案，共 21 个文件。** 此处与 §2 的生产 .ts/.tsx 统计口径不同，包含 scripts/run-tests.mjs，不混算历史重写规模。
- 本轮差量另存于恢复目录 implementation.diff；build-inputs.json 记录冻结给隔离构建的输入哈希。没有整文件回退或覆盖已有未提交实现。

### 11.2 按所有权边界落地

| 批次 | 实际修改文件 | 删除内容 / 保留契约 |
|---|---|---|
| D0 | docs/simplification-review.md、docs/simplification-remediation-plan.md | 修正静态探针证明范围、七项分类、旧测量/验证口径、安全复现命令、R15 谓词绝对化及实施状态；保留历史证据并标明时点 |
| A1 | components/ui/file-dropzone.tsx | 删 reportFileContentType；保留文件类型、大小及可访问性 |
| A2 | lib/db/initial-ai-settings.ts | 删 INITIAL_AI_SETTINGS_VERSION；保留原生首次播种及不覆盖已有配置 |
| A3 | lib/db/settings-repository.ts | 删 getAiPromptConfiguration 与其唯一内部调用链 getAiPromptConfigurationInDatabase；保留活提示词快照入口 |
| A4 | lib/documents/report-storage.ts | 删 parseContentLengthHeader；保留新上传长度/流式上限与实际文档验证 |
| A5 | lib/reports/server-runtime.ts | 删 bound、无消费者测试绑定入口及分支；保留 host 惰性单例和错误映射 |
| A6+B1 | modules/reports/domain.ts、lib/workspace-reports.ts、components/report-history-view.tsx；test/workspace-reports.test.ts、test/light-theme.test.ts、test/report-insight.test.ts | 退役四个旧报告类型、死选择器和旧历史状态输入；保留 ReportSource、隐藏课题、当前 capabilities/评分展示、亮色/沙箱和 insight-only 待分析断言 |
| A7 | modules/reports/workspace-query.ts | 删 comparisonFor 与两项失效导入；真实 resolver、仓储比较和 SubmissionComparison 保留 |
| B2 | scripts/run-tests.mjs、test/run-tests.test.mjs | 删除单组循环、恒空 preload、双重解析及失去用途的 createTestInvocation；保留原生 --import 参数转发、隔离环境、退出码/信号、退出后清理与监听器释放；补四类边界测试 |
| B3 | modules/analysis/pipeline.ts、modules/contracts/analysis.ts、test/workspace-submission-ui.test.ts | 删 previousOverall 注入、写入与类型字段；使用测试局部 LegacyAiScore 和具名夹具保留旧字段忽略断言，不新增运行时恒等助手；accepted-artifact 恢复与 documentText 可选未改 |
| B4 | lib/db/settings-repository.ts、lib/db/settings-crypto.ts、test/submission-admission.test.ts | 原生任务直接用已有显式 secret 解密，删不可达数据库本地 key 回退；共享 .settings-key、scrypt/AES-GCM/v2、缺钥 503 与错钥诊断保留，补错钥 fail-closed 用例 |

### 11.3 定向验证与全量结果

子代理定向结果与主代理集成结果分列，不把子集通过等同于全局通过：

| 检查 | 剪切前 | 修改后 | 说明 |
|---|---|---|---|
| A6+B1：workspace-reports、light-theme、report-insight、workspace-report-deletion | 51/51 | 50/50 | 删除一个死选择器专属测试；当前删除/选择和隐藏课题仍有覆盖 |
| A3+B4：model-settings、submission-admission、submission-admission-routes；改后另含 worker-flow、native-backup | 46/46（3 文件） | 71/71（5 文件） | 两侧文件集合不同，不能据计数差推断新增测试数；实际只新增一个错钥用例 |
| B2：run-tests | 3/3 | 7/7 | +4：空集、选择/去重/参数转发、拒绝 --tsconfig 且清理、spawn error 且清理；--import 使用 mock spawn 验证原样转发，不实际加载假路径 |
| B3：submission-executor、workspace-submission-ui | 75/75 | 75/75 | 所有旧比较字段负向断言保持；executor 测试文件未修改 |
| 主代理严格 TypeScript + 全量隔离测试 | 963/963，exit 0 | **967/967，exit 0** | 最终源码冻结后执行；0 fail、0 skipped、0 cancelled |
| 删除符号残留搜索 | 原声明存在 | 源码/测试目标符号零命中 | 文档保留历史名字；previousOverall 仍仅用于两个测试文件的负向夹具/断言，不要求这些字符串消失 |

测试总数变动可解释为 **963 − 1（死选择器）+ 4（runner）+ 1（错钥）= 967**，没有靠删除失败断言使测试通过。全量测试覆盖主代理负责的 A1/A2/A4/A5/A7 定向文件。

集成命令（在真实源码树执行，由 runner 自建业务数据隔离目录）：

- node node_modules/typescript/bin/tsc --noEmit --incremental false -p tsconfig.source.json --noUnusedLocals --noUnusedParameters
- YANXING_CHAT_COMPLETIONS_API_KEY='' node scripts/run-tests.mjs

最终完整测试输出保存在 /tmp/dsh-subprocess-ohZlUk/dsh-subprocess-382101-4-5c5805b54daf-stdout.log；963 基线输出为同目录 dsh-subprocess-382101-3-41137bfddd19-stdout.log。它们是临时证据位置，不是应用运行依赖。

**中间态失败记录**：并行编辑期间，一次定向运行正好读到 crypto 删除而 repository 导入尚未更新，两个 route 文件无法加载；另有几次编译撞上 B3 测试夹具的临时括号错误。没有据此删除测试或回滚用户代码；完成配套修改、去掉临时恒等助手后重新执行上述全部门禁，最终均通过。后续并行实现应先稳定边界，再运行跨边界门禁。

独立只读复核对照实施前快照检查了解密、报告卡片、runner、分析恢复四个关键边界，未发现阻塞问题、真实回归或被遗漏的保护。空目录清理等非必要建议未追加执行。

### 11.4 隔离构建、未验证层与回退

构建目录为 /tmp/yanxing-simplify-build-vzW0Bk：复制冻结源码及本机 node_modules，不使用指向仓库外的依赖软链，以满足 runtime tracing 的仓库内路径保护。未复制真实 .env、业务 storage、历史 .runtime 或 out/；数据库/知识库路径绑定该临时目录，模型 API key 置空，使用仅本次构建的占位主密钥。

| 层 | 命令 / 条件 | 本次结果 |
|---|---|---|
| Next 生产构建 | node node_modules/next/dist/bin/next build --webpack；NODE_ENV=production，YANXING_STANDALONE=0，YANXING_NEXT_DIST_DIR=.next，NEXT_TELEMETRY_DISABLED=1 | **exit 0**，产物仅写隔离目录 |
| Worker / CLI / 解析器构建 | node scripts/build-runtime.mjs | **exit 0**；10 个编译入口，runtime.nft.json 跟踪 1158 文件 |
| 真实浏览器行为 | 未运行浏览器脚本；现有 SSR/组件及行为测试已通过 | **未验证**视觉、真实点击、DOCX 浏览器预览与键盘操作，不将 renderToStaticMarkup 当浏览器验收 |
| Standalone / Docker / 发布验收 | 未执行 build:docker、容器启动或 P5 发布链 | **未验证**；普通 Next 与 runtime 编译成功不等于部署可用 |

本轮没有改数据格式或执行迁移，回退只需本批源码差量，不需要数据库恢复。恢复时先检查用户是否新增改动：无后续变动才可从 source/ 恢复对应文件；有后续变动时仅反向应用本批片段。禁止 git reset --hard、git clean、从 HEAD 覆盖未跟踪文件，或整目录删除业务数据与历史验收证据。

## 12. 分析/洞察原文件抽取回退单项实施

### 12.1 授权、差量与保留边界

- 用户在 C 类核查及回退含义说明后，只授权调整本条；未实施其余 C 项、B5、事务行为修复、API 字段删除或历史产物清理。
- 修改前快照：/tmp/yanxing-c-document-before-S3Pc4j。source/ 保存本批 8 个实际工作树文件，含未跟踪文件；manifest.json、status.txt、staged.diff、unstaged.diff 记录哈希及原有 Git 状态。回退只撤销本批差量，不覆盖后续工作。
- 源码 3 文件：modules/analysis/pipeline.ts 删除原文件抽取导入、allowCachedFileExtraction 开关及 sourcePath 参数，缺少准备正文时保留原错误；worker/submission-executor.ts 仅删除对应 false 实参；lib/ai/report-insight-agent.ts 删除 file 参数与文件抽取导入/分支。
- 测试 3 文件：test/report-insight.test.ts 的 3 处 file 输入改为正文，删除仅为该夹具存在的临时文件、数据库初始化及环境切换；test/prompt-budget.test.ts 改传正文并显式保留洞察零计费回调断言；test/submission-executor.test.ts 保留运行时不含 file 的负向断言，并加强两种恢复路径的零正文读取检查。
- 相对本次快照：**源码 +4/−10，净 −6 行；测试 +89/−29，净 +60 行；另更新本报告及实施方案。** 不以 HEAD 混算已有未提交重写。
- 明确保留：分析 documentText 可选、调用方正文优先、repository.getDocumentText 准备正文兜底、仅 needsModelCall 时加载正文，以及 await 边界。执行器与 pipeline 的 accepted 筛选条件不同，不据原文件读取不可达而连带删除准备正文兜底。
- 原文件身份/哈希/大小校验、上传阶段解析、文件保存/下载/预览、冻结配置、计费结算、lease/cancel/fencing、已接收产物恢复与发布逻辑均未改；未改 HTTP 或数据库格式。

### 12.2 验证结果

| 检查 | 结果 | 范围与证明边界 |
|---|---|---|
| 原有定向基线 | 54/54，exit 0 | submission-executor、report-insight、prompt-budget、submission-worker-flow、report-submission-runtime、prepared-report-files |
| 先补边界测试、尚未删除源码 | 43/43，exit 0 | 前三个测试文件；分析直调测试此时显式禁用原文件回退，验证原生产语义 |
| 修改后同组定向 | 58/58，exit 0 | 与 54 项基线相同六文件；含真实 DOCX 及本地受控 provider Worker 用例，不代表真实供应商验收 |
| 严格 TypeScript | exit 0 | noEmit、incremental=false、noUnusedLocals、noUnusedParameters |
| 全量隔离测试 | **971/971，exit 0** | 0 fail、0 skipped、0 cancelled；967 + 4 个新增测试，未删除原用例 |
| 隔离 Worker/CLI/解析器构建 | exit 0 | 10 个入口；runtime.nft.json 跟踪 1158 文件 |
| 隔离 Next 生产构建 | exit 0 | Next 16.3.2，webpack，非 standalone；不覆盖现有 .next |
| 独立只读差量复核 | 未发现阻塞问题 | 对照本次快照检查六个源码/测试文件，确认准备正文兜底、恢复、源文件校验与计费断言保留 |
| 浏览器／容器／部署 | 未执行 | 不把源码测试及构建通过等同于发布或线上验收 |

四个新增测试覆盖：分析未注入正文时读取仓储准备正文；仓储正文缺失/为空时在 runtime/provider 前失败；分析与洞察读取准备正文失败时不发模型、不发布且任务失败；洞察正文缺失/为空时零网络、零计费回调。另在现有两项 accepted-artifact 恢复测试中用抛错替身和调用次数断言保证不重新读正文，并保留不建 runtime、不调模型、不验证原文件的要求。

命令：

```bash
YANXING_CHAT_COMPLETIONS_API_KEY='' node scripts/run-tests.mjs test/submission-executor.test.ts test/report-insight.test.ts test/prompt-budget.test.ts test/submission-worker-flow.test.ts test/report-submission-runtime.test.ts test/prepared-report-files.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false -p tsconfig.source.json --noUnusedLocals --noUnusedParameters
YANXING_CHAT_COMPLETIONS_API_KEY='' node scripts/run-tests.mjs
# 以下仅在隔离源码副本运行
node scripts/build-runtime.mjs
node node_modules/next/dist/bin/next build --webpack
git diff --check
```

隔离构建目录：/tmp/yanxing-c-document-build-VjWDTZ。仅复制源码、测试、构建配置和本机依赖，不复制真实 .env、业务 storage、现有 .runtime/.next 或 out/。构建进程使用该副本内数据库/知识库路径、空模型 API key、占位主密钥，NODE_ENV=production、YANXING_STANDALONE=0、YANXING_NEXT_DIST_DIR=.next、NEXT_TELEMETRY_DISABLED=1。快照中的 build-inputs.sha256 与构建后工作树六个源码/测试文件比对一致。全量测试输出：/tmp/dsh-subprocess-ohZlUk/dsh-subprocess-382101-6-b48dfa542849-stdout.log（临时证据路径）。



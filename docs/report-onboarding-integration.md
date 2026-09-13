# 首报与空阶段交付引导整合

## 功能归位

- 仅在分析页没有选中报告、显示交付引导时，移除页头的阶段/报告选择与管理操作栏；保留课题名称、进度、负责人和模块导航。
- 现有报告分析页，以及洞察、原文、历史页仍保留原操作栏。
- 引导顺序调整为「选择交付阶段 → 选择报告类型 → 上传并确认提交」。阶段选择修改提交草稿，不切换阅读页面。
- 「调整研究计划」「编辑课题信息」融入引导，按服务端能力控制；有历史报告的空阶段保留「查看已有报告」「查看全部历史」及最近提交/当前完结标识。
- 保留原标题、品牌色、双报告类型卡片、背景装饰和底部三项能力说明；未替换整体页面设计。

## 草稿与提交安全

- 草稿以项目和稳定阶段 ID 识别，阶段改名、重排、修改课题资料后不丢失已选文件、有效报告类型或当前步骤。
- 目标阶段被移除时保留文件，回到第一步要求重选；更新报告的目标变为已完成时清空类型并明确提示，不静默转换成完结报告。
- 已完成阶段仅补交/更新完结报告，不回退进度；保留旧报告。
- 上传仍使用原生「解析准备 → 显式确认 → 正式提交」。同步状态与解析锁防止同一轮重复点击；取消后迟到的解析结果不覆盖新草稿。
- 待确认提交不被新草稿覆盖；结果未确认时可从引导恢复原提交，继续复用原上传、命令和幂等键。只读空课题也允许返回原课题处理已有提交，不开放新提交能力。

## 同步修复的接口与预览问题

- 修正项目详情 API 查询参数为 `stageId` / `reportId`，避免显式阶段/报告选择被后端忽略。页面地址栏仍使用既有 `stage` / `report`，两层约定不混用。
- 推进预览对齐既有后端规则：跨阶段更新同样展示被跳过的前置阶段及将进入的目标阶段；补交已完成阶段不再提示重新推进或再次完成课题。没有修改后端业务规则。

## 验证命令

```bash
corepack pnpm exec tsc --noEmit --incremental false -p tsconfig.source.json --noUnusedLocals --noUnusedParameters
corepack pnpm test
YANXING_NEXT_DIST_DIR=.next-onboarding-qa corepack pnpm build
YANXING_NEXT_DIST_DIR=.next-onboarding-qa node test/helpers/native-browser-smoke.mjs --p5
```

新增测试：

- `test/first-report-onboarding.test.ts`：草稿校验及首屏/权限/页头组合 SSR。
- `test/workspace-project-selection-client.test.ts`：API 参数名、编码与默认选择契约。
- `test/workspace-submission-ui.test.ts`：跨阶段更新、已完成阶段补交的推进预览。

浏览器回归实际点击步骤、上传隔离 DOCX、修改/删除隔离计划、验证重复点击及未知确认结果重试，不以源码匹配代替真实交互。浏览器测试的 Web、Worker、数据库、文件存储和 Chrome profile 均隔离，不向现有用户课题提交测试数据，也不调用付费模型。

## 验证结果

- TypeScript 严格检查与未使用符号检查通过。
- 全量回归 **951 项通过，0 失败**：885 项原生测试 + 66 项显式离线夹具测试。
- 最终源码生产构建通过。
- 隔离 Chrome 完整验收通过，共 19 张截图；覆盖草稿保留、计划增删重排、类型显式重选、重复点击只解析一次、确认前报告数保持为零、丢失确认响应后同命令同键重试、既有报告/历史入口、只读权限、手机端，以及原分析/洞察/原文等页面。
- 构建及测试日志：`out/onboarding-build.log`、`out/onboarding-tests.log`、`out/onboarding-browser.log`。
- 现有 `http://127.0.0.1:3000` 已刷新并完成只读浏览器复核：阶段/类型/上传三步、辅助编辑弹窗打开取消、三个非分析页操作栏、390×844 手机端按钮可达均通过；运行时错误 0、401 响应 0、业务写入 0。测试前后课题、阶段及流程数据一致。
- 本地页面截图：`out/onboarding-local-stage.png`、`out/onboarding-local-type.png`、`out/onboarding-local-upload.png`、`out/onboarding-local-mobile.png`；复核脚本：`out/onboarding-local-check.mjs`。该脚本仅允许 GET/HEAD/OPTIONS 与登录 POST，拦截其他写请求。
- QA 构建目录及其自动添加的类型配置已清理；没有替换既有开发 Web/Worker 服务、执行正式部署或修改用户业务数据。所有测试启动的隔离浏览器和服务均已关闭。

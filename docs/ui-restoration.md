# 原界面恢复与原生接口适配

## 范围与边界

按用户确认恢复原页面布局、视觉与导航。没有恢复旧 Dashboard 控制器、旧报告写入或历史兼容层；继续使用既有“课题 → 有序研究阶段 → 不可变完整提交”模型与后端。

- components/workspace-app.tsx 保留原生鉴权、加载代际隔离、事件流、任务控制与两阶段提交状态机，仅改为挂接原展示组件。
- components/dashboard.tsx 是原页面入口名称的薄转接，不含旧控制器。
- 已移除六个未再使用的简化展示模块以及替代的新建课题弹窗。旧 P5 封存产物未修改，本次不是正式部署切换。

## 恢复的展示组件

| 页面/区域 | 实际组件 |
| --- | --- |
| 总览：问候横幅、指标、质量全景、报告及知识动态 | components/overview-workspace.tsx |
| 报告库：搜索筛选、统计条、折叠课题组、原报告表格 | components/reports-repository.tsx |
| 课题头部与原模块标签 | components/project-executive-header.tsx、components/workspace-project-header.tsx |
| 分析卡片与图谱 | components/dashboard-view.tsx |
| 洞察启动面板与阅读器 | components/insight-workspace.tsx、components/insight-empty-state.tsx |
| 阶段进度与报告历史 | components/report-history-view.tsx |
| 四步设立向导及三步首报引导 | components/project-setup-guide.tsx、components/project-first-report-onboarding.tsx |

保留原配色、卡片装饰、字体体系与主要布局。窄桌面沿用紧凑横向标签；有足够左侧留白的宽屏显示外挂标签，避免导航被裁切。分析卡片仍按自身容器宽度布局，保留最小可读宽度与移动端底部可达性。

## 必要的原生适配

- 课题头部增加紧凑阶段/提交选择器，区分当前选择、当前完结与全局最近提交。
- V 号始终是阶段内版本；全局提交顺序单独标注。总览数量文案为“报告提交”。
- 原四步向导通过类型化 onCreate 提交原生计划，阶段标识独立生成，不复用固定模板 ID。
- 原首报引导收集文件与阶段后，进入同一原生解析、显式确认和幂等提交流程；已有准备或未决提交不能被新草稿覆盖。
- 保留首提冻结、跳阶段/补交不回退、当前完结保护、历史任务能力限制及协作者只读。
- 缺失评分不显示成 0；首份阶段报告隐藏比较，差值来自原生 comparison。报告摘要接口未提供章节总数，因此显示 -- 并说明，不伪造统计。

## 验证

- TypeScript 严格及未使用检查通过。
- 完整回归：863 项原生测试 + 66 项显式离线夹具测试，合计 **929 项通过，0 失败**。
- 独立生产 Web 构建：.next-ui-restore-qa。
- 隔离 Web/Worker/Chrome 的浏览器验收通过，18 张截图；覆盖原向导首报、丢失确认响应后同键同命令重试、阶段推进、补交、跳过空阶段、完结保护、版本不复用、只读权限、原文 Range、桌面与移动端，以及恢复的总览/报告库/洞察面板。无付费模型调用。
- 已登录并刷新实际 http://127.0.0.1:3000，核验原总览、报告库及全页设立向导；健康接口正常。仅登录和读取/浏览，未创建业务课题或报告。
- 没有迁移、清理或切换新旧数据目录；测试数据在独立临时根目录。

验证摘要：out/ui-restoration-verification.json。截图：out/ui-restoration-browser/、out/ui-restored-local-overview.png、out/ui-restored-local-library.png、out/ui-restored-local-setup.png。

后续业务/API 变更默认保留既有视觉；重新设计须先取得明确确认。此边界已补入 AGENTS.md。

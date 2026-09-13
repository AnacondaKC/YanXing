import assert from 'node:assert/strict'
import { EMPTY_WORKSPACE_CAPABILITIES } from './helpers/workspace-capabilities'
import test from 'node:test'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OverviewDataRegion } from '../components/overview-loading'
import { OverviewWorkspace } from '../components/overview-workspace'
import { combineOverviewLoadStates, settleOverviewLoadState, type OverviewLoadState } from '../lib/overview-loading'
import { type WorkspaceOverviewStats, type WorkspaceProjectListItem, type WorkspaceReportCard } from '../lib/workspace-submission'

const readyStats: WorkspaceOverviewStats = {
  submittedReportCount: 12, completedStageCount: 2, totalCharacters: 45000, knowledgeCount: 6, knowledgeCategoryCount: 2,
  weeklyNewReports: 3, weeklyNewKnowledge: 1,
  jobStats: { completed: 4, failed: 1, cancelled: 0, running: 0, queued: 0 },
  trends: { submissions: [1, 2, 3], characters: [100, 200, 300], successRate: [80, 80, 80], knowledge: [1, 2, 6], averageScore: [70, 80], analyzedProjects: [1, 2] },
}

function nativeCard(overrides: Partial<WorkspaceReportCard> = {}): WorkspaceReportCard {
  return {
    id: 'report-1',
    projectId: 'quality-project',
    stageId: 'stage-1',
    stageVersion: 1,
    submissionSequence: 1,
    submittedAs: 'update',
    isCurrentCompletion: false,
    isLatestSubmission: true,
    wasFirstStageSubmission: true,
    title: '研究报告',
    fileName: 'report.docx',
    sourceSize: 1024,
    paragraphCount: 12,
    characterCount: 4000,
    submittedBy: 'owner',
    submittedAt: '2026-01-01T00:00:00.000Z',
    labels: {
      stageLabel: '阶段01 · 开题研究',
      reportLabel: '开题研究 V1',
      compactLabel: '阶段01 V1',
      roleLabel: '阶段更新报告',
    },
    capabilities: { ...EMPTY_WORKSPACE_CAPABILITIES, analysisAction: 'rerun', insightAction: 'start', disabledReasons: [] },
    comparison: { status: 'unavailable', reason: 'first_stage_submission' },
    ...overrides,
  }
}

function nativeProject(overrides: Partial<WorkspaceProjectListItem> = {}): WorkspaceProjectListItem {
  return {
    id: 'quality-project',
    title: '质量测试课题',
    ownerId: 'owner',
    ownerName: '负责人',
    objective: '',
    description: '',
    canManage: true,
    canDelete: false,
    canSubmit: true,
    canEditPlan: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    submittedReportCount: 1,
    completedStageCount: 0,
    currentStage: { id: 'stage-1', ordinal: 1, title: '开题研究', lifecycleStatus: 'in_progress' },
    ...overrides,
  }
}
const baseProps: ComponentProps<typeof OverviewWorkspace> = {
  projects: [], recentReports: [], activityReports: [], knowledgeItems: [],
  projectsState: 'loading', statsState: 'loading',
  onSelect() {}, onNavigate() {}, onOpenReport() {},
}

function renderOverview(overrides: Partial<ComponentProps<typeof OverviewWorkspace>> = {}) {
  return renderToStaticMarkup(createElement(OverviewWorkspace, { ...baseProps, ...overrides }))
}

const FILL_CHAIN = 'flex min-h-0 flex-1 flex-col'

function countFillChains(html: string) {
  return html.split(FILL_CHAIN).length - 1
}

function panelMarkup(html: string, label: string) {
  const open = html.indexOf('<section aria-label="' + label + '"')
  assert.notEqual(open, -1, 'missing ' + label)
  const close = html.indexOf('</section>', open)
  assert.notEqual(close, -1, 'unclosed ' + label)
  return html.slice(open, close)
}

function renderRegion(state: OverviewLoadState, layout?: 'fill') {
  return renderToStaticMarkup(createElement(OverviewDataRegion, {
    state,
    label: '报告动态',
    placeholder: createElement('span', null, '占位'),
    ...(layout ? { layout } : {}),
    children: createElement('div', { className: 'mt-2 min-h-[8.5rem] flex-1' }, 'empty-body'),
  }))
}

test('request outcomes distinguish first-load failure from refresh failure with retained data', () => {
  for (const state of ['loading', 'ready', 'error'] as const) {
    assert.equal(settleOverviewLoadState(state, 'success'), 'ready')
    assert.equal(settleOverviewLoadState(state, 'failure'), state === 'ready' ? 'ready' : 'error')
  }
})

test('regions needing both sources handle every loading, success and failure combination', () => {
  const states: OverviewLoadState[] = ['loading', 'ready', 'error']
  for (const left of states) {
    for (const right of states) {
      const expected = left === 'error' || right === 'error' ? 'error' : left === 'loading' || right === 'loading' ? 'loading' : 'ready'
      assert.equal(combineOverviewLoadStates(left, right), expected)
    }
  }
})

test('first load keeps headings and navigation visible without fabricated zeros or empty states', () => {
  const html = renderOverview()
  assert.match(html, /data-enter="true"/)
  for (const label of ['报告提交总数', '分析质量全景', '最新报告动态', '知识库动态', '进入报告库', '进入知识库']) assert.ok(html.includes(label))
  assert.match(html, /aria-busy="true"/)
  assert.match(html, /报告提交总数正在加载/)
  assert.doesNotMatch(html, /暂无课题动态|暂无参考资料|>00<|>0<|质量标杆/)
})

test('quality gauge reserves glyph padding for double and triple digit scores', () => {
  for (const score of [60, 80, 86, 88, 100]) {
    const html = renderOverview({
      projectsState: 'ready',
      projects: [nativeProject({ latestSubmission: nativeCard({ aiScore: score, completeness: score }) })],
    })
    const quality = panelMarkup(html, '分析质量全景')
    const scoreLabel = quality.match(/<span class="([^"]*bg-clip-text[^"]*)">([0-9]+)</)
    assert.ok(scoreLabel)
    assert.equal(scoreLabel[2], String(score))
    assert.match(scoreLabel[1], /(?:^| )px-1(?: |$)/)
  }
})

test('fast data renders immediately without a mandatory skeleton interval', () => {
  const html = renderOverview({ projectsState: 'ready', statsState: 'ready', stats: readyStats })
  assert.doesNotMatch(html, /yx-overview-skeleton|正在加载/)
  assert.match(html, />12</)
  assert.match(html, /暂无课题动态/)
  assert.match(html, /暂无参考资料/)
})

test('statistics can render while project-dependent regions are still loading', () => {
  const html = renderOverview({ statsState: 'ready', stats: readyStats })
  assert.match(html, />12</)
  assert.match(html, /分析质量正在加载/)
  assert.match(html, /报告动态正在加载/)
  assert.doesNotMatch(html, /知识库动态正在加载|报告提交总数正在加载/)
})

test('projects can render while the independent statistics request is slow', () => {
  const html = renderOverview({ projectsState: 'ready' })
  assert.match(html, /报告提交总数正在加载/)
  assert.doesNotMatch(html, /分析质量正在加载/)
})

test('initial errors show local failure copy instead of endless skeletons or successful empty states', () => {
  const html = renderOverview({ projectsState: 'error', statsState: 'error' })
  assert.match(html, /暂时无法加载/)
  assert.doesNotMatch(html, /正在加载|yx-overview-skeleton|暂无课题动态|暂无参考资料|>00</)
})

test('each overview mount starts entrance even when data is already available', () => {
  for (let visit = 0; visit < 2; visit += 1) {
    const html = renderOverview({ projectsState: 'ready', statsState: 'ready', stats: readyStats })
    assert.match(html, /data-enter="true"/)
    assert.match(html, />12</)
    assert.doesNotMatch(html, /yx-overview-skeleton/)
  }
})

test('background refresh errors preserve actual statistics', () => {
  const html = renderOverview({ projectsState: 'ready', statsState: settleOverviewLoadState('ready', 'failure'), stats: readyStats, upstreamError: '统计刷新失败，已有内容继续保留。' })
  assert.match(html, /统计刷新失败/)
  assert.match(html, />12</)
  assert.doesNotMatch(html, /yx-overview-skeleton/)
})

test('fill layout preserves a flex chain through both data-region wrappers', () => {
  const html = renderRegion('ready', 'fill')
  assert.match(html, new RegExp('class="' + FILL_CHAIN + '"'))
  assert.match(html, new RegExp('class="yx-overview-data ' + FILL_CHAIN + '"'))
  assert.match(html, /empty-body/)
  assert.equal(countFillChains(html), 2)
})

test('default data region stays a block wrapper so KPI and quality layout is unchanged', () => {
  const html = renderRegion('ready')
  assert.match(html, /class="yx-overview-data"/)
  assert.doesNotMatch(html, /flex min-h-0 flex-1 flex-col/)
  assert.match(html, /empty-body/)
})

test('fill layout keeps named loading and error states', () => {
  const loading = renderRegion('loading', 'fill')
  assert.match(loading, /aria-busy="true"/)
  assert.match(loading, /role="status"/)
  assert.match(loading, /aria-label="报告动态正在加载"/)
  assert.match(loading, /占位/)
  assert.equal(countFillChains(loading), 2)

  const failed = renderRegion('error', 'fill')
  assert.match(failed, /role="status"/)
  assert.match(failed, /报告动态暂时无法加载/)
  assert.match(failed, /flex-1/)
  assert.match(failed, new RegExp('class="' + FILL_CHAIN + '"'))
  assert.doesNotMatch(failed, /empty-body|占位|yx-overview-data/)
})

test('only report and knowledge panel bodies opt into the fill flex chain', () => {
  const html = renderOverview({ projectsState: 'ready', statsState: 'ready', stats: readyStats })
  assert.match(html, /class="yx-overview space-y-6"/)
  assert.equal(countFillChains(html), 4)
  for (const label of ['最新报告动态', '知识库动态']) {
    const panel = panelMarkup(html, label)
    assert.match(panel, new RegExp('class="' + FILL_CHAIN + '"'))
    assert.match(panel, new RegExp('class="yx-overview-data ' + FILL_CHAIN + '"'))
    assert.ok(panel.includes('min-h-[8.5rem] flex-1'))
  }
  const quality = panelMarkup(html, '分析质量全景')
  assert.match(quality, /class="yx-overview-data"/)
  assert.doesNotMatch(quality, /flex min-h-0 flex-1 flex-col/)
  const statsRegion = html.slice(html.indexOf('yx-overview-stat'), html.indexOf('aria-label="分析质量全景"'))
  assert.match(statsRegion, /yx-overview-data/)
  assert.doesNotMatch(statsRegion, /flex min-h-0 flex-1 flex-col/)
})

test('missing scores stay missing while zero remains a valid quality score', () => {
  const missingHtml = renderOverview({
    projectsState: 'ready',
    statsState: 'ready',
    stats: readyStats,
    projects: [nativeProject({ latestSubmission: nativeCard({ aiScore: undefined, completeness: undefined, capabilities: { ...EMPTY_WORKSPACE_CAPABILITIES, analysisAction: 'start', insightAction: 'none', disabledReasons: [] } }) })],
  })
  const missingQuality = panelMarkup(missingHtml, '分析质量全景')
  assert.match(missingQuality, />--</)
  assert.doesNotMatch(missingQuality, /质量标杆/)
  assert.doesNotMatch(missingQuality, /px-1[^>]*>0</)

  const zeroHtml = renderOverview({
    projectsState: 'ready',
    statsState: 'ready',
    stats: readyStats,
    projects: [nativeProject({ latestSubmission: nativeCard({ aiScore: 0, completeness: 0 }) })],
  })
  const zeroQuality = panelMarkup(zeroHtml, '分析质量全景')
  const scoreLabel = zeroQuality.match(/<span class="([^"]*px-1[^"]*)">([0-9]+)</)
  assert.ok(scoreLabel)
  assert.equal(scoreLabel[2], '0')
  assert.match(zeroQuality, />0%</)
  assert.match(zeroQuality, /质量标杆/)
})

test('loading report and knowledge panels keep aria-busy fill wrappers without empty states', () => {
  const html = renderOverview()
  assert.match(html, /class="yx-overview space-y-6"/)
  assert.equal(countFillChains(html), 4)
  for (const [label, status] of [['最新报告动态', '报告动态正在加载'], ['知识库动态', '知识库动态正在加载']] as const) {
    const panel = panelMarkup(html, label)
    assert.match(panel, /aria-busy="true"/)
    assert.match(panel, new RegExp('aria-label="' + status + '"'))
    assert.match(panel, new RegExp('class="' + FILL_CHAIN + '"'))
    assert.doesNotMatch(panel, /yx-overview-data|暂无课题动态|暂无参考资料/)
  }
  assert.doesNotMatch(panelMarkup(html, '分析质量全景'), /flex min-h-0 flex-1 flex-col/)
})

function sparklineSvg(html: string, label: string) {
  const idx = html.indexOf('aria-label="' + label + '"')
  assert.notEqual(idx, -1, 'missing ' + label)
  return html.slice(html.lastIndexOf('<svg', idx), html.indexOf('</svg>', idx) + 6)
}

test('overview sparklines keep original hasData markup for mini, panel and stat charts', () => {
  const html = renderOverview({
    projectsState: 'ready',
    statsState: 'ready',
    stats: readyStats,
    recentReports: [nativeCard({ aiScore: 70 }), nativeCard({ id: 'r2', aiScore: 80 })],
  })
  assert.equal(sparklineSvg(html, '近 7 日已分析课题累计走势'), '<svg viewBox="0 0 48 20" class="mb-0.5 h-5 w-12 shrink-0 overflow-visible" role="img" aria-label="近 7 日已分析课题累计走势"><title>近 7 日已分析课题累计走势</title><defs><linearGradient id="yxAnalyzedTrend" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--yx-brand)" stop-opacity="0.28"></stop><stop offset="100%" stop-color="var(--yx-brand)" stop-opacity="0"></stop></linearGradient></defs><path d="M1.5,18.5 L46.5,1.5 L46.5,20 L1.5,20 Z" fill="url(#yxAnalyzedTrend)"></path><path d="M1.5,18.5 L46.5,1.5" fill="none" stroke="var(--yx-brand)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path><circle cx="46.5" cy="1.5" r="1.8" fill="var(--yx-brand)" stroke="var(--yx-paper)" stroke-width="0.9"></circle></svg>')
  assert.equal(sparklineSvg(html, '最近 2 版报告评分趋势'), '<svg viewBox="0 0 96 28" class="h-7 w-[5.5rem] shrink-0 overflow-visible" role="img" aria-label="最近 2 版报告评分趋势"><title>最近 2 版报告评分趋势</title><defs><linearGradient id="yxRecentReportScoreTrend" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--yx-brand)" stop-opacity="0.28"></stop><stop offset="100%" stop-color="var(--yx-brand)" stop-opacity="0"></stop></linearGradient></defs><path d="M2.0,2.0 L94.0,26.0 L94.0,28 L2.0,28 Z" fill="url(#yxRecentReportScoreTrend)"></path><path d="M2.0,2.0 L94.0,26.0" fill="none" stroke="var(--yx-brand)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path><circle cx="94" cy="26" r="2.2" fill="var(--yx-brand-hover)" stroke="var(--yx-paper)" stroke-width="1"></circle></svg>')
  assert.equal(sparklineSvg(html, '近 7 日趋势'), '<svg viewBox="0 0 96 28" class="h-7 w-[5.5rem] max-w-[46%] shrink-0 overflow-visible" aria-label="近 7 日趋势"><defs><linearGradient id="yxStatTrend-versions" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--yx-brand)" stop-opacity="0.28"></stop><stop offset="100%" stop-color="var(--yx-brand)" stop-opacity="0"></stop></linearGradient></defs><path d="M2.0,26.0 L48.0,14.0 L94.0,2.0 L94.0,28 L2.0,28 Z" fill="url(#yxStatTrend-versions)"></path><path d="M2.0,26.0 L48.0,14.0 L94.0,2.0" fill="none" stroke="var(--yx-brand)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path><circle cx="94" cy="2" r="2.2" fill="var(--yx-brand-hover)" stroke="var(--yx-paper)" stroke-width="1"></circle></svg>')
  assert.equal((html.match(/rotate\(-14 23 26\)/g) || []).length, 2)
  assert.equal((html.match(/M28 12v26/g) || []).length, 2)
  assert.equal((html.match(/M28 8v40M8 28h40/g) || []).length, 1)
  assert.equal((html.match(/M16 16h16M16 22h16M16 28h11M16 34h8/g) || []).length, 1)
  assert.equal((html.match(/M17 22.5 19.5 25 24 20/g) || []).length, 1)
})

test('overview sparkline empty and zero branches keep original dash, area and null rules', () => {
  const empty = renderOverview({
    projectsState: 'ready',
    statsState: 'ready',
    stats: {
      ...readyStats,
      submittedReportCount: 0,
      weeklyNewReports: 0,
      knowledgeCount: 0,
      jobStats: { completed: 0, failed: 0, cancelled: 0, running: 0, queued: 0 },
      trends: { submissions: [], characters: [], successRate: [], knowledge: [], averageScore: [], analyzedProjects: [] },
    },
  })
  assert.equal(sparklineSvg(empty, '近 7 日已分析课题累计走势'), '<svg viewBox="0 0 48 20" class="mb-0.5 h-5 w-12 shrink-0 overflow-visible" role="img" aria-label="近 7 日已分析课题累计走势"><title>近 7 日已分析课题累计走势</title><defs><linearGradient id="yxAnalyzedTrend" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--yx-brand)" stop-opacity="0.28"></stop><stop offset="100%" stop-color="var(--yx-brand)" stop-opacity="0"></stop></linearGradient></defs><path d="M1.5,10.0 L46.5,10.0" fill="none" stroke="var(--yx-line)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="2 3"></path></svg>')
  assert.equal(sparklineSvg(empty, '最近 0 版报告评分趋势'), '<svg viewBox="0 0 96 28" class="h-7 w-[5.5rem] shrink-0 overflow-visible" role="img" aria-label="最近 0 版报告评分趋势"><title>最近 0 版报告评分趋势</title><defs><linearGradient id="yxRecentReportScoreTrend" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--yx-brand)" stop-opacity="0.28"></stop><stop offset="100%" stop-color="var(--yx-brand)" stop-opacity="0"></stop></linearGradient></defs><path d="M2.0,14.0 L94.0,14.0" fill="none" stroke="var(--yx-line)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="3 3"></path></svg>')
  assert.equal((empty.match(/aria-label="近 7 日趋势"/g) || []).length, 0)

  const zeros = renderOverview({
    projectsState: 'ready',
    statsState: 'ready',
    stats: {
      ...readyStats,
      trends: { submissions: [0, 0], characters: [0], successRate: [80, 80, 80], knowledge: [0], averageScore: [], analyzedProjects: [0, 0, 0] },
    },
    recentReports: [nativeCard({ aiScore: 0 })],
  })
  assert.equal(sparklineSvg(zeros, '近 7 日已分析课题累计走势'), '<svg viewBox="0 0 48 20" class="mb-0.5 h-5 w-12 shrink-0 overflow-visible" role="img" aria-label="近 7 日已分析课题累计走势"><title>近 7 日已分析课题累计走势</title><defs><linearGradient id="yxAnalyzedTrend" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--yx-brand)" stop-opacity="0.28"></stop><stop offset="100%" stop-color="var(--yx-brand)" stop-opacity="0"></stop></linearGradient></defs><path d="M1.5,10.0 L24.0,10.0 L46.5,10.0" fill="none" stroke="var(--yx-line)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="2 3"></path></svg>')
  assert.equal(sparklineSvg(zeros, '最近 1 版报告评分趋势'), '<svg viewBox="0 0 96 28" class="h-7 w-[5.5rem] shrink-0 overflow-visible" role="img" aria-label="最近 1 版报告评分趋势"><title>最近 1 版报告评分趋势</title><defs><linearGradient id="yxRecentReportScoreTrend" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--yx-brand)" stop-opacity="0.28"></stop><stop offset="100%" stop-color="var(--yx-brand)" stop-opacity="0"></stop></linearGradient></defs><path d="M2.0,14.0 L94.0,14.0 L94.0,28 L2.0,28 Z" fill="url(#yxRecentReportScoreTrend)"></path><path d="M2.0,14.0 L94.0,14.0" fill="none" stroke="var(--yx-brand)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path><circle cx="94" cy="14" r="2.2" fill="var(--yx-brand-hover)" stroke="var(--yx-paper)" stroke-width="1"></circle></svg>')
  assert.equal(sparklineSvg(zeros, '近 7 日趋势'), '<svg viewBox="0 0 96 28" class="h-7 w-[5.5rem] max-w-[46%] shrink-0 overflow-visible" aria-label="近 7 日趋势"><defs><linearGradient id="yxStatTrend-versions" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--yx-brand)" stop-opacity="0.28"></stop><stop offset="100%" stop-color="var(--yx-brand)" stop-opacity="0"></stop></linearGradient></defs><path d="M2.0,14.0 L94.0,14.0 L94.0,28 L2.0,28 Z" fill="url(#yxStatTrend-versions)"></path><path d="M2.0,14.0 L94.0,14.0" fill="none" stroke="var(--yx-brand)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path><circle cx="94" cy="14" r="2.2" fill="var(--yx-brand-hover)" stroke="var(--yx-paper)" stroke-width="1"></circle></svg>')
  assert.doesNotMatch(sparklineSvg(zeros, '近 7 日已分析课题累计走势'), /<circle/)
  assert.match(sparklineSvg(zeros, '最近 1 版报告评分趋势'), /<circle/)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OverviewDataRegion } from '../components/overview-loading'
import { OverviewWorkspace } from '../components/overview-workspace'
import { combineOverviewLoadStates, settleOverviewLoadState, type OverviewLoadState } from '../lib/overview-loading'

const readyStats = {
  totalReportVersions: 12, totalCharacters: 45000, knowledgeCount: 6, knowledgeCategoryCount: 2,
  weeklyNewReports: 3, weeklyNewKnowledge: 1,
  jobStats: { completed: 4, failed: 1, cancelled: 0, running: 0, queued: 0 },
  trends: { versions: [1, 2, 3], characters: [100, 200, 300], successRate: [80, 80, 80], knowledge: [1, 2, 6], averageScore: [70, 80], analyzedProjects: [1, 2] },
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
  for (const label of ['报告版本总数', '分析质量全景', '最新报告动态', '知识库动态', '进入报告库', '进入知识库']) assert.ok(html.includes(label))
  assert.match(html, /aria-busy="true"/)
  assert.match(html, /报告版本总数正在加载/)
  assert.doesNotMatch(html, /暂无课题动态|暂无参考资料|>00<|>0<|质量标杆/)
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
  assert.doesNotMatch(html, /知识库动态正在加载|报告版本总数正在加载/)
})

test('projects can render while the independent statistics request is slow', () => {
  const html = renderOverview({ projectsState: 'ready' })
  assert.match(html, /报告版本总数正在加载/)
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

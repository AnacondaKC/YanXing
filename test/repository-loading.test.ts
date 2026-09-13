import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FileText } from 'lucide-react'
import { ReportsRepositoryWorkspace } from '../components/reports-repository'
import { KnowledgeBaseWorkspace } from '../components/knowledge-base'
import { RepositoryLoading } from '../components/repository-loading'
import { RepositoryStatCell } from '../components/ui/repository-stats'

const metric = { label: '报告数量', value: '12', unit: '份', icon: FileText, points: [1, 5, 12], trendLabel: '报告数量走势', gradientId: 'test-library-trend' }

test('library statistic loading keeps label but hides placeholder numbers and graphs', () => {
  const html = renderToStaticMarkup(createElement(RepositoryStatCell, { ...metric, dataState: 'loading' }))
  assert.match(html, /报告数量正在加载/)
  assert.match(html, /aria-busy="true"/)
  assert.match(html, /yx-repository-skeleton/)
  assert.doesNotMatch(html, />12<|role="img"/)
})

test('ready library statistics render immediately with their actual value', () => {
  const html = renderToStaticMarkup(createElement(RepositoryStatCell, metric))
  assert.match(html, />12</)
  assert.match(html, /role="img"/)
  assert.doesNotMatch(html, /yx-repository-skeleton/)
})

test('failed initial library statistics have an unavailable state instead of fake zeros', () => {
  const html = renderToStaticMarkup(createElement(RepositoryStatCell, { ...metric, dataState: 'error' }))
  assert.match(html, /报告数量暂时无法加载/)
  assert.doesNotMatch(html, /正在加载|yx-repository-skeleton|>12<|role="img"/)
})

test('statistic stagger is capped so additional columns do not slow down entry', () => {
  const html = renderToStaticMarkup(createElement(RepositoryStatCell, { ...metric, entranceIndex: 20 }))
  assert.match(html, /--repository-index:5/)
})

test('library loading placeholder provides a named status with decorative skeletons', () => {
  const html = renderToStaticMarkup(createElement(RepositoryLoading, { label: '知识库' }))
  assert.match(html, /role="status"/)
  assert.match(html, /aria-label="知识库正在加载"/)
  assert.match(html, /aria-hidden="true"/)
})

for (const workspace of ['reports', 'knowledge'] as const) {
  test(workspace + ' starts entry on each visit without showing false empty results', () => {
    for (let visit = 0; visit < 2; visit += 1) {
      const element = workspace === 'reports'
        ? createElement(ReportsRepositoryWorkspace, { projects: [], reports: [], loading: true, hasLoaded: false, onRetry() {}, onOpenReport() {}, onSelectProject() {} })
        : createElement(KnowledgeBaseWorkspace, { onNotice() {} })
      const html = renderToStaticMarkup(element)
      assert.match(html, /data-enter="true"/)
      assert.match(html, /yx-repository-intro/)
      assert.match(html, /yx-repository-filters/)
      assert.match(html, /yx-repository-stat/)
      assert.match(html, /aria-busy="true"/)
      assert.doesNotMatch(html, /暂无匹配的报告|暂无参考研报|>0</)
    }
  })
}

const nativeCapabilities = {
  canSubmitUpdate: false,
  canSubmitCompletion: false,
  canDelete: false,
  canCancelAnalysisJob: false,
  canCancelInsightJob: false,
  canEditPlan: false,
  analysisAction: 'start' as const,
  insightAction: 'none' as const,
  disabledReasons: [] as string[],
}

const nativeProject = {
  id: 'project-1',
  title: '产业政策课题',
  ownerId: 'owner',
  ownerName: '负责人',
  objective: '研究目标',
  description: '研究说明',
  canManage: true,
  canDelete: false as const,
  canSubmit: true,
  canEditPlan: true,
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-01T00:00:00.000Z',
  submittedReportCount: 1,
  completedStageCount: 0,
  currentStage: { id: 'stage-1', ordinal: 1, title: '开题研究', lifecycleStatus: 'in_progress' as const },
}

function nativeReport(overrides: { aiScore?: number; completeness?: number; submissionSequence?: number } = {}) {
  return {
    id: 'report-' + String(overrides.submissionSequence ?? 2),
    projectId: 'project-1',
    stageId: 'stage-1',
    stageVersion: 2,
    submissionSequence: overrides.submissionSequence ?? 2,
    submittedAs: 'update' as const,
    isCurrentCompletion: false,
    isLatestSubmission: true,
    wasFirstStageSubmission: false,
    title: '研究报告',
    fileName: 'report.docx',
    sourceSize: 1024,
    paragraphCount: 12,
    characterCount: 4000,
    submittedBy: 'owner',
    submittedAt: '2026-03-02T00:00:00.000Z',
    labels: {
      stageLabel: '阶段01 · 开题研究',
      reportLabel: '开题研究 V2',
      compactLabel: '阶段01 V2',
      roleLabel: '阶段更新报告',
    },
    capabilities: nativeCapabilities,
    comparison: { status: 'unavailable' as const, reason: 'no_predecessor' as const },
    ...overrides,
  }
}

test('controlled reports repository keeps original library chrome without fabricated scores', () => {
  const missing = renderToStaticMarkup(createElement(ReportsRepositoryWorkspace, {
    projects: [nativeProject],
    reports: [nativeReport()],
    loading: false,
    hasLoaded: true,
    onRetry() {},
    onOpenReport() {},
    onSelectProject() {},
  }))
  assert.match(missing, /yx-repository-intro/)
  assert.match(missing, /yx-repository-filters/)
  assert.match(missing, /yx-repository-stat/)
  assert.match(missing, /收录报告/)
  assert.match(missing, /总章节数/)
  assert.match(missing, /产业政策课题/)
  assert.match(missing, /评分 <strong class="[^"]*">--<\/strong>/)
  assert.match(missing, /完整度 <strong class="[^"]*">--<\/strong>/)
  assert.doesNotMatch(missing, /getReportStageLabel|latestReport\.version|>V2</)

  const zero = renderToStaticMarkup(createElement(ReportsRepositoryWorkspace, {
    projects: [nativeProject],
    reports: [nativeReport({ aiScore: 0, completeness: 0 })],
    loading: false,
    hasLoaded: true,
    onRetry() {},
    onOpenReport() {},
    onSelectProject() {},
  }))
  assert.match(zero, /评分 <strong class="[^"]*">0<\/strong>/)
  assert.match(zero, /完整度 <strong class="[^"]*">0%<\/strong>/)
})

test('report library stage cells keep the stage badge without a compact version subtitle', () => {
  const source = readFileSync(new URL('../components/reports-repository.tsx', import.meta.url), 'utf8')
  const stageCell = source.match(/<CellCaption label="阶段">([\s\S]*?)<\/CellCaption>/)?.[1]

  assert.ok(stageCell, 'The report row must retain its stage cell')
  assert.match(stageCell, /reportStageLabel\(report\)/)
  assert.doesNotMatch(stageCell, /compactLabel|stageVersion|submissionSequence/)
})

test('controlled reports repository surfaces parent load errors for retry', () => {
  const html = renderToStaticMarkup(createElement(ReportsRepositoryWorkspace, {
    projects: [],
    reports: [],
    loading: false,
    hasLoaded: false,
    loadError: '报告列表读取失败，请重试；已加载的内容会继续保留。',
    onRetry() {},
    onOpenReport() {},
    onSelectProject() {},
  }))
  assert.match(html, /role="alert"/)
  assert.match(html, /报告列表读取失败/)
  assert.match(html, />重试</)
  assert.doesNotMatch(html, /暂无匹配的报告|>0</)
})

function repositorySparkline(points: number[], gradientId: string) {
  const html = renderToStaticMarkup(createElement(RepositoryStatCell, {
    label: '报告数量',
    value: '12',
    unit: '份',
    icon: FileText,
    points,
    trendLabel: '报告数量走势',
    gradientId,
  }))
  const idx = html.indexOf('aria-label="报告数量走势"')
  assert.notEqual(idx, -1)
  return html.slice(html.lastIndexOf('<svg', idx), html.indexOf('</svg>', idx) + 6)
}

test('repository sparkline keeps original smooth area, dual halo and hasData dash branches', () => {
  assert.equal(repositorySparkline([], 'cap-repo-empty'), '<svg viewBox="0 0 56 22" class="mb-0.5 h-[22px] w-14 shrink-0 overflow-visible" role="img" aria-label="报告数量走势"><title>报告数量走势</title><defs><linearGradient id="cap-repo-empty" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--yx-brand)" stop-opacity="0.28"></stop><stop offset="100%" stop-color="var(--yx-brand)" stop-opacity="0"></stop></linearGradient></defs><path d="M2.0,11.0 C10.7,11.0 45.3,11.0 54.0,11.0" fill="none" stroke="var(--yx-line)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="2 3"></path></svg>')
  assert.equal(repositorySparkline([0, 0, 0], 'cap-repo-zeros'), '<svg viewBox="0 0 56 22" class="mb-0.5 h-[22px] w-14 shrink-0 overflow-visible" role="img" aria-label="报告数量走势"><title>报告数量走势</title><defs><linearGradient id="cap-repo-zeros" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--yx-brand)" stop-opacity="0.28"></stop><stop offset="100%" stop-color="var(--yx-brand)" stop-opacity="0"></stop></linearGradient></defs><path d="M2.0,11.0 C6.3,11.0 19.3,11.0 28.0,11.0 C36.7,11.0 49.7,11.0 54.0,11.0" fill="none" stroke="var(--yx-line)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="2 3"></path></svg>')
  assert.equal(repositorySparkline([5], 'cap-repo-one-positive'), '<svg viewBox="0 0 56 22" class="mb-0.5 h-[22px] w-14 shrink-0 overflow-visible" role="img" aria-label="报告数量走势"><title>报告数量走势</title><defs><linearGradient id="cap-repo-one-positive" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--yx-brand)" stop-opacity="0.28"></stop><stop offset="100%" stop-color="var(--yx-brand)" stop-opacity="0"></stop></linearGradient></defs><path d="M2.0,11.0 C10.7,11.0 45.3,11.0 54.0,11.0 L54.0,22 L2.0,22 Z" fill="url(#cap-repo-one-positive)"></path><path d="M2.0,11.0 C10.7,11.0 45.3,11.0 54.0,11.0" fill="none" stroke="var(--yx-brand)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path><circle cx="54" cy="11" r="3.1" fill="var(--yx-brand)" opacity="0.18"></circle><circle cx="54" cy="11" r="1.7" fill="var(--yx-brand)" stroke="var(--yx-paper)" stroke-width="0.9"></circle></svg>')
  const rising = repositorySparkline([1, 5, 12], 'cap-repo-rising')
  assert.equal(rising, '<svg viewBox="0 0 56 22" class="mb-0.5 h-[22px] w-14 shrink-0 overflow-visible" role="img" aria-label="报告数量走势"><title>报告数量走势</title><defs><linearGradient id="cap-repo-rising" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--yx-brand)" stop-opacity="0.28"></stop><stop offset="100%" stop-color="var(--yx-brand)" stop-opacity="0"></stop></linearGradient></defs><path d="M2.0,20.0 C6.3,18.9 19.3,16.5 28.0,13.5 C36.7,10.5 49.7,3.9 54.0,2.0 L54.0,22 L2.0,22 Z" fill="url(#cap-repo-rising)"></path><path d="M2.0,20.0 C6.3,18.9 19.3,16.5 28.0,13.5 C36.7,10.5 49.7,3.9 54.0,2.0" fill="none" stroke="var(--yx-brand)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path><circle cx="54" cy="2" r="3.1" fill="var(--yx-brand)" opacity="0.18"></circle><circle cx="54" cy="2" r="1.7" fill="var(--yx-brand)" stroke="var(--yx-paper)" stroke-width="0.9"></circle></svg>')
  assert.match(rising, / C6\.3,18\.9 /)
  assert.doesNotMatch(rising, /d="M2.0,20.0 L28.0,13.5 L54.0,2.0 L54.0,22/)
  assert.equal((rising.match(/<circle /g) || []).length, 2)
})

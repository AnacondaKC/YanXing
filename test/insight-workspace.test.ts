import assert from 'node:assert/strict'
import { EMPTY_WORKSPACE_CAPABILITIES } from './helpers/workspace-capabilities'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { InsightWorkspace, canDispatchInsight } from '../components/insight-workspace'
import { InsightEmptyState } from '../components/insight-empty-state'
import { type WorkspaceReportCard } from '../lib/workspace-submission'
import type { ReportInsightOutput } from '../modules/insights/domain'
import type { SubmissionTask } from '../modules/reports/submission-task-domain'

const sampleInsight: ReportInsightOutput = {
  title: '阶段研究报告简页',
  summary: '主旨提要',
  readingMinutes: 6,
  sections: [{ id: 's1', label: '核心论点' }],
  html: '<h1>阶段研究报告简页</h1><p>论点与建议</p>',
}

function reportCard(overrides: Partial<WorkspaceReportCard> = {}): WorkspaceReportCard {
  const capabilities = {
    ...EMPTY_WORKSPACE_CAPABILITIES,
    insightAction: 'start' as const,
    ...overrides.capabilities,
  }
  return {
    id: 'report-insight',
    projectId: 'project-insight',
    stageId: 'stage-1',
    stageVersion: 3,
    submissionSequence: 3,
    title: '阶段研究报告',
    fileName: 'phase-report.docx',
    sourceSize: 1024,
    paragraphCount: 80,
    characterCount: 20000,
    submittedAs: 'update',
    submittedAt: '2026-08-01T00:00:00Z',
    submittedBy: 'owner',
    wasFirstStageSubmission: false,
    isCurrentCompletion: false,
    isLatestSubmission: true,
    labels: {
      stageLabel: '阶段01 · 开题研究',
      reportLabel: '开题研究 V3',
      compactLabel: '阶段01 V3',
      roleLabel: '阶段更新报告',
    },
    comparison: { status: 'unavailable', reason: 'no_predecessor' },
    ...overrides,
    capabilities,
  }
}

function insightTask(overrides: Partial<SubmissionTask> = {}): SubmissionTask {
  return {
    id: 'job-insight',
    reportId: 'report-insight',
    projectId: 'project-insight',
    actorId: 'user-1',
    operation: 'insight',
    generation: 1,
    status: 'running',
    stage: 'page_analysis',
    stageIndex: 1,
    attempts: 1,
    cancelRequested: false,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    ...overrides,
  }
}

function renderWorkspace(overrides: Partial<ComponentProps<typeof InsightWorkspace>> = {}) {
  return renderToStaticMarkup(createElement(InsightWorkspace, {
    canManage: true,
    onGenerate() {},
    onCancel() {},
    ...overrides,
  }))
}

test('controlled insight workspace does not fetch, poll, or enforce regeneration limits', () => {
  const source = readFileSync(new URL('../components/insight-workspace.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /apiFetch|mutationHeaders|\/api\/reports\/.+\/insight/)
  assert.doesNotMatch(source, /MAX_INSIGHT_REGENERATIONS|regenerationCount|INSIGHT_POLL_MS|isInsightGenerationInFlight/)
  assert.match(source, /report\?\.capabilities\.insightAction/)
  assert.match(source, /canCancelInsightJob/)
  assert.equal(canDispatchInsight('start'), true)
  assert.equal(canDispatchInsight('retry'), true)
  assert.equal(canDispatchInsight('rerun'), true)
  assert.equal(canDispatchInsight('view'), false)
  assert.equal(canDispatchInsight('none'), false)
  assert.equal(canDispatchInsight(undefined), false)
})

test('missing-report empty state keeps the original lead, upload action, and brief figure', () => {
  const html = renderWorkspace({ canManage: true })
  assert.match(html, /开启决策洞察/)
  assert.match(html, /前往上传报告/)
  assert.match(html, /报告简页/)
  assert.doesNotMatch(html, /<figcaption|报告简页样式示意/)
  assert.match(html, /data-enter="true"/)
  assert.doesNotMatch(html, /<iframe/)
})

test('read-only missing-report empty state explains upload permissions', () => {
  const html = renderWorkspace({ canManage: false })
  assert.match(html, /请联系课题负责人上传报告后再查看洞察/)
  assert.doesNotMatch(html, /<button/)
})

test('ready empty state uses insightAction start and selected native report version', () => {
  const html = renderWorkspace({ report: reportCard() })
  assert.match(html, /生成报告洞察/)
  assert.match(html, /已选报告/)
  assert.match(html, />V3</)
  assert.ok(html.includes('phase-report.docx'))
  assert.match(html, />生成洞察</)
  assert.doesNotMatch(html, /停止洞察|重新生成洞察|regenerationCount/)
})

test('retry and rerun empty states use native action labels without auto-starting', () => {
  const retry = renderWorkspace({ report: reportCard({ capabilities: { ...EMPTY_WORKSPACE_CAPABILITIES, insightAction: 'retry' } }) })
  const rerun = renderWorkspace({ report: reportCard({ capabilities: { ...EMPTY_WORKSPACE_CAPABILITIES, insightAction: 'rerun' } }) })
  assert.match(retry, />再次生成洞察</)
  assert.match(rerun, />更新洞察</)
  assert.doesNotMatch(retry, /正在整理报告简页/)
  assert.doesNotMatch(rerun, /正在整理报告简页/)
})

test('unknown and view insight actions never offer generate or retry automatically', () => {
  const unknown = renderWorkspace({
    report: reportCard({ capabilities: { ...EMPTY_WORKSPACE_CAPABILITIES, insightAction: 'none' } }),
    dispatchError: '结果未确认。',
  })
  const view = renderWorkspace({
    report: reportCard({ capabilities: { ...EMPTY_WORKSPACE_CAPABILITIES, insightAction: 'view' } }),
  })
  assert.match(unknown, /历史报告仅支持查看已经生成的洞察/)
  assert.match(unknown, /结果未确认/)
  assert.doesNotMatch(unknown, />生成洞察<|>再次生成洞察<|>更新洞察<|>重试</)
  assert.match(view, /历史报告仅支持查看已经生成的洞察/)
  assert.doesNotMatch(view, /<button/)
})

test('native in-flight empty state shows original progress copy and cancel when allowed', () => {
  const running = insightTask()
  const html = renderWorkspace({
    report: reportCard({ capabilities: { ...EMPTY_WORKSPACE_CAPABILITIES, insightAction: 'start', canCancelInsightJob: true } }),
    insightTask: running,
  })
  assert.match(html, /正在编排洞察/)
  assert.match(html, /role="status"/)
  assert.match(html, /正在整理报告简页，完成后将自动进入阅读/)
  assert.match(html, />停止洞察</)
  assert.doesNotMatch(html, />生成洞察<|>重试</)
})

test('in-flight empty state hides cancel when canCancelInsightJob is false', () => {
  const html = renderWorkspace({
    report: reportCard({ capabilities: { ...EMPTY_WORKSPACE_CAPABILITIES, insightAction: 'start', canCancelInsightJob: false } }),
    generating: true,
  })
  assert.match(html, /正在整理报告简页，完成后将自动进入阅读/)
  assert.doesNotMatch(html, /停止洞察|<button/)
})

test('successful insight keeps original reader toolbar, iframe theme document, and fullscreen control', () => {
  const html = renderWorkspace({ report: reportCard({ capabilities: { ...EMPTY_WORKSPACE_CAPABILITIES, insightAction: 'rerun' } }), insight: sampleInsight })
  assert.match(html, /aria-label="报告洞察阅读器"/)
  assert.match(html, /aria-label="阅读工具"/)
  assert.match(html, /约 6 分钟/)
  assert.match(html, /aria-label="重新生成洞察"/)
  assert.match(html, /aria-label="全屏阅读"/)
  assert.match(html, /title="阶段研究报告简页 - 报告洞察"/)
  assert.match(html, /sandbox="allow-same-origin"/)
  assert.match(html, /yx-detail-reader/)
  assert.match(html, /color-scheme: only light/)
  assert.doesNotMatch(html, /regenerationCount|MAX_INSIGHT_REGENERATIONS|停止洞察/)
})

test('reader regenerate is omitted for view-only insight and cancel appears for a live native job', () => {
  const viewOnly = renderWorkspace({
    report: reportCard({ capabilities: { ...EMPTY_WORKSPACE_CAPABILITIES, insightAction: 'view' } }),
    insight: sampleInsight,
  })
  const live = renderWorkspace({
    report: reportCard({ capabilities: { ...EMPTY_WORKSPACE_CAPABILITIES, insightAction: 'rerun', canCancelInsightJob: true } }),
    insight: sampleInsight,
    insightTask: insightTask({ status: 'queued' }),
  })
  assert.doesNotMatch(viewOnly, /aria-label="重新生成洞察"|停止洞察/)
  assert.match(live, /正在重新生成洞察/)
  assert.match(live, /yx-insight-wait-dots/)
  assert.match(live, /aria-label="停止洞察"/)
  assert.match(live, /aria-label="重新生成洞察"/)
  assert.match(live, /disabled=""/)
})

test('dispatch errors render in the original reader alert without dropping the successful insight', () => {
  const html = renderWorkspace({
    report: reportCard({ capabilities: { ...EMPTY_WORKSPACE_CAPABILITIES, insightAction: 'retry' } }),
    insight: sampleInsight,
    dispatchError: '洞察任务结果未确认。',
  })
  assert.match(html, /role="alert"/)
  assert.match(html, /洞察任务结果未确认/)
  assert.match(html, /sandbox="allow-same-origin"/)
  assert.match(html, /aria-label="重新生成洞察"/)
})

test('empty-state cancel stays inside the original generating panel', () => {
  const html = renderToStaticMarkup(createElement(InsightEmptyState, {
    report: { title: '阶段研究报告', fileName: 'phase-report.docx', stageVersion: 3 },
    canManage: true,
    generating: true,
    canCancel: true,
    error: '',
    onGenerate() {},
    onCancel() {},
  }))
  assert.match(html, /正在整理报告简页，完成后将自动进入阅读/)
  assert.match(html, />停止洞察</)
  assert.match(html, /报告简页/)
  assert.doesNotMatch(html, /<figcaption|报告简页样式示意/)
})

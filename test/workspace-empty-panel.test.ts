import assert from 'node:assert/strict'
import { EMPTY_WORKSPACE_CAPABILITIES } from './helpers/workspace-capabilities'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DashboardView } from '../components/dashboard-view'
import { InsightEmptyState } from '../components/insight-empty-state'
import { ReportDocumentViewer } from '../components/report-document-viewer'
import { ReportHistoryView } from '../components/report-history-view'
import { emptyPanelPreviewBodyClassName, emptyPanelPreviewCardClassName, workspaceEmptyPanelClassName, workspacePanelChromeClassName } from '../components/workspace-empty-panel'
import { SKIPPED_EMPTY_COPY, type WorkspaceStageGroup } from '../lib/workspace-submission'

function panelClass(html: string) {
  const panel = html.match(/<section aria-label="[^"]+" class="([^"]*)"/)
  assert.ok(panel, 'expected a labeled empty panel')
  return panel[1]
}

function assertSharedChrome(html: string) {
  const classNames = new Set(panelClass(html).split(/\s+/).filter(Boolean))
  for (const token of workspaceEmptyPanelClassName.split(/\s+/).filter(Boolean)) {
    assert.equal(classNames.has(token), true, token)
  }
  assert.match(html, /yx-detail-content/)
  assert.doesNotMatch(html, /<figcaption/)
  assert.doesNotMatch(html, /非实际生成内容|样式示意/)
  assert.match(html, /bg-yx-brand-bright\/12/)
  assert.match(html, /border-dashed border-yx-brand\/\[0\.08\]/)
  assert.doesNotMatch(html, /via-yx-brand-bright\/30/)
  assert.doesNotMatch(html, /blur-3xl/)
  assert.ok(html.includes(emptyPanelPreviewCardClassName))
  assert.ok(html.includes(emptyPanelPreviewBodyClassName))
}

test('analysis, insight, original and history empty states share the insight launch chrome', () => {
  const pages = [
    renderToStaticMarkup(createElement(DashboardView, { canManage: false, async onCancelAnalysis() {} })),
    renderToStaticMarkup(createElement(InsightEmptyState, { canManage: true, generating: false, error: '', onGenerate() {} })),
    renderToStaticMarkup(createElement(ReportDocumentViewer)),
    renderToStaticMarkup(createElement(ReportHistoryView, { groups: [], onOpenReport() {} })),
  ]
  for (const html of pages) assertSharedChrome(html)
})

const filledHistoryGroups: WorkspaceStageGroup[] = [
  {
    stage: {
      id: 's1',
      projectId: 'p1',
      ordinal: 1,
      title: '开题研究',
      lifecycleStatus: 'completed',
      completionReason: 'skipped',
      nextReportVersion: 1,
      stateRevision: 0,
      completionRevision: 0,
    },
    stageLabel: '阶段01 · 开题研究',
    skippedEmpty: true,
    reports: [],
    canSubmitUpdate: false,
    canSubmitCompletion: true,
  },
  {
    stage: {
      id: 's2',
      projectId: 'p1',
      ordinal: 2,
      title: '事实调研',
      lifecycleStatus: 'in_progress',
      nextReportVersion: 2,
      stateRevision: 0,
      completionRevision: 0,
    },
    stageLabel: '阶段02 · 事实调研',
    skippedEmpty: false,
    reports: [{
      id: 'r2',
      projectId: 'p1',
      stageId: 's2',
      stageVersion: 1,
      submissionSequence: 1,
      submittedAs: 'update',
      isCurrentCompletion: false,
      isLatestSubmission: true,
      wasFirstStageSubmission: true,
      title: '调研阶段报告',
      fileName: 'survey.docx',
      sourceSize: 2048,
      paragraphCount: 20,
      characterCount: 8000,
      aiScore: 82,
      completeness: 76,
      submittedBy: 'owner',
      submittedAt: '2026-08-01T00:00:00.000Z',
      labels: {
        stageLabel: '阶段02 · 事实调研',
        reportLabel: '事实调研 V1',
        compactLabel: '阶段02 V1',
        roleLabel: '阶段更新报告',
      },
      capabilities: { ...EMPTY_WORKSPACE_CAPABILITIES, canDelete: true, analysisAction: 'start' },
      comparison: { status: 'unavailable', reason: 'first_stage_submission' },
    }],
    canSubmitUpdate: true,
    canSubmitCompletion: true,
  },
]

test('filled history keeps the empty-panel chrome and original facts inside one card', () => {
  const html = renderToStaticMarkup(createElement(ReportHistoryView, {
    groups: filledHistoryGroups,
    selectedReportId: 'r2',
    latestSubmissionId: 'r2',
    onOpenReport() {},
    onDeleteReport() {},
  }))
  const classNames = new Set(panelClass(html).split(/\s+/).filter(Boolean))
  for (const token of workspacePanelChromeClassName.split(/\s+/).filter(Boolean)) {
    assert.equal(classNames.has(token), true, token)
  }
  assert.match(html, /bg-yx-brand-bright\/12/)
  assert.match(html, /课题阶段进度/)
  assert.match(html, /共 2 个阶段，已完成 1 个/)
  assert.match(html, /第 2 阶段 · 事实调研/)
  assert.match(html, /调研阶段报告/)
  assert.match(html, /阶段 02 · 事实调研/)
  assert.match(html, /阶段更新报告/)
  assert.match(html, />V1</)
  assert.doesNotMatch(html, /全局 1/)
  assert.match(html, /最近提交/)
  assert.match(html, /正在查看/)
  assert.match(html, /AI评分/)
  assert.match(html, />82<span/)
  assert.match(html, /完整度/)
  assert.match(html, />76<span/)
  assert.match(html, /8,000/)
  assert.match(html, /查看报告/)
  assert.match(html, /删除报告 V1/)
  assert.match(html, new RegExp(SKIPPED_EMPTY_COPY))
  assert.doesNotMatch(html, /提交报告后，报告记录将显示在这里/)
  assert.doesNotMatch(html, /grid gap-3 sm:gap-4/)
})

test('history gives titles flexible space while keeping compact metadata and full timestamps', () => {
  for (const onDeleteReport of [undefined, () => {}]) {
    const html = renderToStaticMarkup(createElement(ReportHistoryView, {
      groups: filledHistoryGroups,
      onOpenReport() {},
      onDeleteReport,
    }))
    assert.ok(html.includes('@container/history'))
    assert.ok(html.includes('@min-[1200px]/history:grid-cols-[400px_minmax(0,1fr)_9rem_3.25rem_3.25rem_5.5rem_4.5rem_auto]'))
    assert.ok(html.includes('max-w-[400px]'))
    assert.ok(html.includes('title="调研阶段报告"'))
    assert.ok(html.includes('<time dateTime="2026-08-01T00:00:00.000Z"'))
    assert.ok(html.includes('2026/08/01'))
    for (const label of ['时间', 'AI评分', '完整度', '字数', '分析完成', '查看报告']) {
      assert.ok(html.includes(label), label)
    }
    assert.equal(html.includes('删除报告 V1'), Boolean(onDeleteReport))
    assert.ok(!html.includes('repeat(5,minmax(0,8rem))'))
  }
})

test('history empty scores show two-line 暂无数据 without a dash placeholder', () => {
  const groups = [{
    ...filledHistoryGroups[1],
    reports: [{
      ...filledHistoryGroups[1].reports[0],
      aiScore: undefined,
      completeness: undefined,
    }],
  }]
  const html = renderToStaticMarkup(createElement(ReportHistoryView, {
    groups,
    onOpenReport() {},
  }))
  assert.match(html, /AI评分/)
  assert.match(html, /暂无数据/)
  assert.doesNotMatch(html, />--</)
})

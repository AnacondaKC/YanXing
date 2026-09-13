import assert from 'node:assert/strict'
import { EMPTY_WORKSPACE_CAPABILITIES } from './helpers/workspace-capabilities'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DashboardView } from '../components/dashboard-view'
import { InsightWorkspace } from '../components/insight-workspace'
import { ReportDocumentViewer } from '../components/report-document-viewer'
import { ReportHistoryView } from '../components/report-history-view'
import { EMPTY_SNAPSHOT } from '../lib/analysis-job-progress'
import { type WorkspaceReportCard } from '../lib/workspace-submission'

const report: WorkspaceReportCard = {
  id: 'report-motion', projectId: 'project-motion', stageId: 'stage-motion', stageVersion: 1, submissionSequence: 1,
  submittedAs: 'update', isCurrentCompletion: false, isLatestSubmission: true, wasFirstStageSubmission: true,
  title: '阶段报告', fileName: 'report.docx', sourceSize: 100,
  paragraphCount: 80, characterCount: 20000, submittedBy: 'user-motion', submittedAt: '2026-08-01T00:00:00Z',
  labels: { stageLabel: '阶段01 · 开题', reportLabel: '开题 V1', compactLabel: '阶段01 V1', roleLabel: '更新报告' },
  capabilities: EMPTY_WORKSPACE_CAPABILITIES,
  comparison: { status: 'unavailable', reason: 'first_stage_submission' },
}

function analysisView(activeReport?: WorkspaceReportCard) {
  return createElement(DashboardView, { report: activeReport, snapshot: EMPTY_SNAPSHOT, canManage: false, async onCancelAnalysis() {} })
}

for (const view of ['analysis', 'insight', 'document', 'history'] as const) {
  test(view + ' starts a lightweight entrance on every new mount', () => {
    for (let visit = 0; visit < 2; visit += 1) {
      const element = view === 'analysis' ? analysisView(report)
        : view === 'insight' ? createElement(InsightWorkspace, { report, canManage: false, onGenerate() {}, onCancel() {} })
        : view === 'document' ? createElement(ReportDocumentViewer, { report })
        : createElement(ReportHistoryView, { groups: [], onOpenReport() {}, onDeleteReport() {} })
      const html = renderToStaticMarkup(element)
      assert.match(html, /data-enter="true"/)
      assert.match(html, /yx-detail/)
    }
  })
}

test('analysis animates cards without placing fullscreen visualization inside a moving wrapper', () => {
  const html = renderToStaticMarkup(analysisView(report))
  assert.match(html, /yx-detail-card/)
  assert.match(html, /yx-detail-secondary/)
  assert.match(html, /yx-detail-fade order-5/)
})

test('pending DOCX reader keeps its sandboxed frame and waits before entry', () => {
  const html = renderToStaticMarkup(createElement(ReportDocumentViewer, { report }))
  assert.doesNotMatch(html, /yx-detail-reader/)
  assert.match(html, /sandbox="allow-same-origin"/)
  assert.match(html, /title="阶段报告 - Word 原文"/)
  assert.match(html, /aria-label="下载原文件"/)
})

test('missing-report views remain informative and participate in entry', () => {
  for (const element of [analysisView(), createElement(InsightWorkspace, { canManage: false, onGenerate() {}, onCancel() {} }), createElement(ReportDocumentViewer)]) {
    const html = renderToStaticMarkup(element)
    assert.match(html, /data-enter="true"/)
    assert.match(html, /yx-detail-(content|fade)/)
    assert.match(html, /报告/)
  }
})

test('controlled history renders supplied empty groups without starting a legacy fetch', () => {
  const html = renderToStaticMarkup(createElement(ReportHistoryView, { groups: [], onOpenReport() {}, onDeleteReport() {} }))
  assert.match(html, /yx-detail-content/)
  assert.match(html, /aria-label="报告版本历史"/)
  assert.doesNotMatch(html, /aria-busy="true"/)
  assert.match(html, /暂无报告/)
})

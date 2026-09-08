import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DashboardView } from '../components/dashboard-view'
import { InsightWorkspace } from '../components/insight-workspace'
import { ReportDocumentViewer } from '../components/report-document-viewer'
import { ReportHistoryView } from '../components/report-history-view'
import { EMPTY_SNAPSHOT } from '../lib/analysis-job-progress'
import type { ProjectWithCapabilities } from '../modules/projects/domain'
import type { ReportVersion } from '../modules/reports/domain'

const project: ProjectWithCapabilities = {
  id: 'project-motion', ownerId: 'user-motion', ownerName: '研究员', title: '产业政策研究',
  objective: '', description: '', status: 'in_progress', milestones: [], canManage: true, canDelete: true,
  createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
}
const report: ReportVersion = {
  id: 'report-motion', projectId: project.id, version: 1, title: '阶段报告', fileName: 'report.docx', fileHash: 'motion-document-hash',
  paragraphCount: 80, characterCount: 20000, parseStatus: 'ready', createdAt: '2026-08-01T00:00:00Z', sourceUpdatedAt: '2026-08-01T00:00:00Z',
}

function analysisView(activeReport?: ReportVersion, reportState: 'loading' | 'ready' | 'error' = 'ready') {
  return createElement(DashboardView, { project, report: activeReport, reportState, onRetryReportLoad() {}, snapshot: EMPTY_SNAPSHOT, analyzing: false, cancelling: false, moduleStates: [], canManage: false, viewGeneration: 0, async onCancelAnalysis() {} })
}

for (const view of ['analysis', 'insight', 'document', 'history'] as const) {
  test(view + ' starts a lightweight entrance on every new mount', () => {
    for (let visit = 0; visit < 2; visit += 1) {
      const element = view === 'analysis' ? analysisView(report)
        : view === 'insight' ? createElement(InsightWorkspace, { report, canManage: false })
        : view === 'document' ? createElement(ReportDocumentViewer, { report })
        : createElement(ReportHistoryView, { project, onOpenReport() {}, onDeleteReport() {}, onReplaceReport() {} })
      const html = renderToStaticMarkup(element)
      assert.match(html, /data-enter="true"/)
      assert.match(html, /yx-detail/)
    }
  })
}

test('analysis pending state preserves entrance without prematurely showing upload onboarding', () => {
  const html = renderToStaticMarkup(analysisView(undefined, 'loading'))
  assert.match(html, /data-enter="true"/)
  assert.match(html, /aria-busy="true"/)
  assert.match(html, /正在读取课题报告/)
  assert.doesNotMatch(html, /yx-detail-card|yx-detail-fade|上传报告/)
})

test('analysis initial failure offers retry instead of falsely reporting no document', () => {
  const html = renderToStaticMarkup(analysisView(undefined, 'error'))
  assert.match(html, /aria-busy="false"/)
  assert.match(html, /课题报告读取失败/)
  assert.match(html, /重新加载报告/)
  assert.doesNotMatch(html, /yx-detail-fade|上传报告/)
})

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
  for (const element of [analysisView(), createElement(InsightWorkspace, { canManage: false }), createElement(ReportDocumentViewer)]) {
    const html = renderToStaticMarkup(element)
    assert.match(html, /data-enter="true"/)
    assert.match(html, /yx-detail-(content|fade)/)
    assert.match(html, /报告/)
  }
})

test('history waits for initial data without announcing a false empty list', () => {
  const html = renderToStaticMarkup(createElement(ReportHistoryView, { project, onOpenReport() {}, onDeleteReport() {}, onReplaceReport() {} }))
  assert.match(html, /yx-detail-intro/)
  assert.match(html, /aria-busy="true"/)
  assert.doesNotMatch(html, /暂无报告版本|yx-detail-content/)
})

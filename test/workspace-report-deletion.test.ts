import assert from 'node:assert/strict'
import { EMPTY_WORKSPACE_CAPABILITIES } from './helpers/workspace-capabilities'
import test from 'node:test'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { WorkspaceDeleteReportDialog } from '../components/workspace-native-dialogs'
import { reportDeleteBlocked, shouldPollReport, type WorkspaceReportCard } from '../lib/workspace-submission'
import type { SubmissionTask } from '../modules/reports/submission-task-domain'

const report: WorkspaceReportCard = {
  id: 'report-1', projectId: 'project-1', stageId: 'stage-1', stageVersion: 1, submissionSequence: 1,
  title: '研究报告', fileName: 'report.docx', sourceSize: 100, paragraphCount: 1, characterCount: 4,
  submittedAs: 'update', submittedBy: 'owner', submittedAt: '2030-01-01T00:00:00.000Z',
  wasFirstStageSubmission: true, isCurrentCompletion: false, isLatestSubmission: true,
  labels: { stageLabel: '阶段01 · 课题立项与大纲拟定', reportLabel: '课题立项与大纲拟定 V1', compactLabel: '阶段01 V1', roleLabel: '阶段更新报告' },
  capabilities: { ...EMPTY_WORKSPACE_CAPABILITIES, canDelete: true },
  comparison: { status: 'unavailable', reason: 'no_predecessor' },
}

function task(overrides: Partial<SubmissionTask> = {}): SubmissionTask {
  return {
    id: 'task-1', reportId: report.id, projectId: report.projectId, actorId: 'owner', operation: 'analysis',
    generation: 1, status: 'queued', stage: 'validating', stageIndex: 0, attempts: 0, cancelRequested: false,
    createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z', ...overrides,
  }
}

function renderDialog(overrides: Partial<ComponentProps<typeof WorkspaceDeleteReportDialog>> = {}) {
  return renderToStaticMarkup(createElement(WorkspaceDeleteReportDialog, {
    report, onClose() {}, async onDelete() {}, ...overrides,
  }))
}

function confirmButton(html: string): string {
  const button = (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []).find(item => item.includes('确认删除'))
  assert.ok(button, 'deletion confirmation button must be rendered')
  return button
}

for (const status of ['pending', 'leased']) {
  for (const errorCode of [undefined, 'TASK_EXECUTION_OR_CONFIGURATION_FAILED']) {
    test(status + ' dispatch with ' + (errorCode ?? 'no error') + ' keeps polling without blocking deletion', () => {
      const input = { canDelete: true, dispatch: { status, errorCode }, outboxPending: true }
      assert.equal(shouldPollReport(input), true)
      assert.equal(reportDeleteBlocked(input), false)
      assert.equal(reportDeleteBlocked({ ...input, canDelete: false }), true)
    })
  }
}

test('an outbox-only pending flag is not an active analysis task', () => {
  const input = { canDelete: true, outboxPending: true }
  assert.equal(shouldPollReport(input), true)
  assert.equal(reportDeleteBlocked(input), false)
})

test('deletable report renders an enabled confirmation without a misleading task warning', () => {
  const html = renderDialog()
  assert.doesNotMatch(confirmButton(html), /disabled=/)
  assert.doesNotMatch(html, /role="alert"/)
  assert.match(html, /删除原因/)
})

for (const operation of ['analysis', 'insight'] as const) {
  for (const status of ['queued', 'running'] as const) {
    for (const cancelRequested of [false, true]) {
      test(operation + ' ' + status + ' cancelRequested=' + cancelRequested + ' blocks with a visible explanation', () => {
        const activeTask = task({ operation, status, cancelRequested })
        const tasks = operation === 'analysis' ? { analysisTask: activeTask } : { insightTask: activeTask }
        assert.equal(reportDeleteBlocked({ canDelete: true, ...tasks }), true)
        const html = renderDialog(tasks)
        assert.match(confirmButton(html), /disabled=/)
        assert.match(html, /role="alert"[^>]*>分析或洞察仍在进行（含取消中），请等待任务结束后再删除。/)
      })
    }
  }
  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    test(operation + ' ' + status + ' releases deletion even with a retained cancellation flag', () => {
      const terminalTask = task({ operation, status, cancelRequested: true })
      const tasks = operation === 'analysis' ? { analysisTask: terminalTask } : { insightTask: terminalTask }
      assert.equal(reportDeleteBlocked({ canDelete: true, ...tasks }), false)
      assert.doesNotMatch(confirmButton(renderDialog(tasks)), /disabled=/)
    })
  }
}

const deniedCases = [
  { code: 'REPORT_WRITE_FORBIDDEN', message: '你没有删除此报告的权限。' },
  { code: 'COMPLETION_REPORT_PROTECTED', message: '当前阶段完结报告不能直接删除，请先替换完结报告。' },
  { code: 'REPORT_PROCESSING', message: '分析或洞察仍在进行（含取消中），请等待任务结束后再删除。' },
  { code: 'REPORT_STATE_INVALID', message: '当前报告暂不可删除，请刷新后重试。' },
]

for (const { code, message } of deniedCases) {
  test('server denial ' + code + ' disables confirmation and explains why before clicking', () => {
    const html = renderDialog({ report: { ...report, capabilities: { ...report.capabilities, canDelete: false, disabledReasons: [code] } } })
    assert.match(confirmButton(html), /disabled=/)
    assert.ok(html.includes(message))
    assert.match(html, /role="alert"/)
  })
}

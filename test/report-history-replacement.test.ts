import assert from 'node:assert/strict'
import { EMPTY_WORKSPACE_CAPABILITIES } from './helpers/workspace-capabilities'
import test from 'node:test'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReportHistoryView, type ReportHistoryViewProps } from '../components/report-history-view'
import { WorkspaceSubmitDialog } from '../components/workspace-submit-flow'
import { getSubmissionDisplayLabels } from '../modules/reports/submission-query'
import {
  previewSubmissionImpact,
  type WorkspaceReportCard,
  type WorkspaceStageGroup,
  type WorkspaceSubmitPhase,
} from '../lib/workspace-submission'

const completedStage: WorkspaceStageGroup['stage'] = {
  id: 'past-stage', projectId: 'project-1', ordinal: 1, title: '开题研究',
  lifecycleStatus: 'completed', completionReason: 'report_completion',
  currentCompletionReportId: 'current-completion',
  nextReportVersion: 4, stateRevision: 2, completionRevision: 1,
}

function report(overrides: Partial<WorkspaceReportCard> = {}): WorkspaceReportCard {
  const card: WorkspaceReportCard = {
    id: 'current-completion', projectId: completedStage.projectId, stageId: completedStage.id,
    stageVersion: 2, submissionSequence: 2, title: '开题完结原报告', fileName: 'original.docx',
    sourceSize: 1024, paragraphCount: 12, characterCount: 4000,
    submittedAs: 'completion', submittedAt: '2026-03-02T00:00:00.000Z', submittedBy: 'owner',
    wasFirstStageSubmission: false, isCurrentCompletion: true, isLatestSubmission: false,
    labels: { stageLabel: '', reportLabel: '', compactLabel: '', roleLabel: '' },
    capabilities: { ...EMPTY_WORKSPACE_CAPABILITIES, canSubmitCompletion: true, canDelete: true },
    comparison: { status: 'unavailable', reason: 'no_predecessor' },
    ...overrides,
  }
  return { ...card, labels: getSubmissionDisplayLabels({ stage: completedStage, report: card }) }
}

function completedGroup(overrides: Partial<WorkspaceStageGroup> = {}): WorkspaceStageGroup {
  return {
    stage: completedStage, stageLabel: '阶段01 · 开题研究', skippedEmpty: false,
    reports: [report()], currentCompletionReportId: 'current-completion',
    canSubmitUpdate: false, canSubmitCompletion: true, ...overrides,
  }
}

const laterGroup: WorkspaceStageGroup = {
  stage: {
    id: 'later-stage', projectId: 'project-1', ordinal: 2, title: '事实调研',
    lifecycleStatus: 'in_progress', nextReportVersion: 1, stateRevision: 0, completionRevision: 0,
  },
  stageLabel: '阶段02 · 事实调研', skippedEmpty: false, reports: [],
  canSubmitUpdate: true, canSubmitCompletion: true,
}

function renderHistory(overrides: Partial<ReportHistoryViewProps> = {}) {
  return renderToStaticMarkup(createElement(ReportHistoryView, {
    groups: [completedGroup()], onOpenReport() {}, onReplaceReport() {}, onDeleteReport() {},
    ...overrides,
  }))
}

function buttons(html: string) {
  return html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []
}

function buttonWithText(html: string, text: string) {
  const button = buttons(html).find((item) => item.replace(/<[^>]*>/g, '') === text)
  assert.ok(button, 'expected button: ' + text)
  return button
}

function submissionSummary(html: string) {
  assert.doesNotMatch(html, /<select\b|type="radio"|<fieldset\b/)
  const summary = html.match(/<section aria-label="报告提交说明"[^>]*>([\s\S]*?)<\/section>/)?.[1]
  assert.ok(summary, 'expected a plain-language submission summary')
  assert.doesNotMatch(summary, /<div\b/, 'submission summary must not render the removed impact hint')
  return summary.replace(/<[^>]*>/g, '')
}

test('only the current completion offers replacement immediately after viewing and before deletion', () => {
  const html = renderHistory({ groups: [completedGroup({ reports: [
    report(),
    report({ id: 'superseded', stageVersion: 1, isCurrentCompletion: false }),
    report({ id: 'ordinary', stageVersion: 3, submittedAs: 'update', isCurrentCompletion: false, isLatestSubmission: true }),
  ] })] })
  const rows = html.match(/<article\b[^>]*>[\s\S]*?<\/article>/g) ?? []
  assert.equal(rows.length, 3)
  const actions = buttons(rows[0])
  assert.equal(actions.length, 3)
  assert.match(actions[0], /查看报告/)
  assert.match(actions[1], /aria-label="替换完结报告 V2"/)
  assert.match(actions[2], /aria-label="删除报告 V2"/)
  assert.equal((html.match(/aria-label="替换完结报告/g) ?? []).length, 1)
  for (const row of rows.slice(1)) {
    assert.doesNotMatch(row, /替换完结报告/)
    assert.match(row, /阶段更新报告/)
    assert.match(row, /查看报告/)
  }
})

const deniedHistories: Array<{ name: string; props: Partial<ReportHistoryViewProps> }> = [
  { name: 'no replacement handler', props: { onReplaceReport: undefined } },
  { name: 'read-only capabilities', props: { groups: [completedGroup({ canSubmitCompletion: false, reports: [report({ capabilities: EMPTY_WORKSPACE_CAPABILITIES })] })] } },
  { name: 'stage denies completion', props: { groups: [completedGroup({ canSubmitCompletion: false })] } },
  { name: 'report denies completion', props: { groups: [completedGroup({ reports: [report({ capabilities: { ...EMPTY_WORKSPACE_CAPABILITIES, canDelete: true } })] })] } },
  { name: 'stale current completion pointer', props: { groups: [completedGroup({ currentCompletionReportId: 'newer-completion' })] } },
  { name: 'missing current completion pointer', props: { groups: [completedGroup({ currentCompletionReportId: undefined })] } },
  { name: 'superseded completion even with matching pointer', props: { groups: [completedGroup({ reports: [report({ isCurrentCompletion: false })] })] } },
  { name: 'ordinary update even with matching pointer', props: { groups: [completedGroup({ reports: [report({ submittedAs: 'update', isCurrentCompletion: false })] })] } },
]

for (const { name, props } of deniedHistories) {
  test('history hides replacement for ' + name, () => {
    const html = renderHistory(props)
    assert.match(html, /查看报告/)
    assert.doesNotMatch(html, /替换完结报告|>替换</)
  })
}

function historyBadges(html: string) {
  return [...html.matchAll(/<span\b[^>]*class="([^"]+)"[^>]*><span class="truncate">([^<]*)<\/span><\/span>/g)]
    .map((match) => ({ className: match[1], label: match[2] }))
}

for (const kind of ['update', 'completion'] as const) {
  test('history ' + kind + ' badges share all geometry and typography, differing only in color', () => {
    const card = report({ submittedAs: kind, isCurrentCompletion: kind === 'completion', stageVersion: 1 })
    const html = renderHistory({
      groups: [completedGroup({ reports: [card] })],
      selectedReportId: card.id,
      latestSubmissionId: card.id,
    })
    const badges = historyBadges(html)
    assert.deepEqual(badges.map((badge) => badge.label), [
      '阶段 01 · 开题研究', card.labels.roleLabel, 'V1',
      ...(kind === 'completion' ? ['当前完结'] : []), '最近提交', '正在查看',
    ])
    const colorClass = /^(?:bg|text|border)-yx-/
    const sharedClasses = badges[0].className.split(' ').filter((name) => !colorClass.test(name))
    for (const badge of badges) {
      const classes = badge.className.split(' ')
      assert.deepEqual(classes.filter((name) => !colorClass.test(name)), sharedClasses)
      for (const name of ['inline-flex', 'h-5', 'items-center', 'justify-center', 'rounded-md', 'border', 'px-1.5', 'text-[9px]', 'font-medium', 'leading-none']) {
        assert.ok(classes.includes(name), badge.label + ' must include ' + name)
      }
      assert.equal(classes.filter((name) => colorClass.test(name)).length, 3)
    }
    assert.equal(new Set(badges.map((badge) => badge.className)).size, badges.length)
  })
}

test('history badges wrap instead of clipping and preserve long stage titles and version labels', () => {
  const title = '课题立项与大纲拟定'.repeat(8)
  const card = report({ stageVersion: 12345 })
  const html = renderHistory({ groups: [completedGroup({ stage: { ...completedStage, title }, reports: [card] })] })
  const badges = historyBadges(html)
  assert.equal(badges[0].label, '阶段 01 · ' + title)
  assert.match(html, new RegExp('title="阶段 01 · ' + title + '"'))
  assert.equal(badges[2].label, 'V12345')
  assert.match(badges[0].className, /max-w-full min-w-0/)
  assert.match(html, /mt-1\.5 flex min-w-0 flex-wrap items-center gap-1\.5/)
  assert.doesNotMatch(html, /flex-nowrap/)
})

const file = new File(['replacement document'], 'replacement.docx')
const impact = previewSubmissionImpact({ stages: [completedStage, laterGroup.stage], targetStageId: completedStage.id, reportKind: 'completion' })
const configured = { file, stageId: completedStage.id, reportKind: 'completion' as const, impact }
const preparedPhase: WorkspaceSubmitPhase = {
  ...configured, step: 'prepared',
  upload: {
    id: 'upload-1', projectId: 'project-1', status: 'ready', fileName: file.name,
    createdAt: '2026-03-03T00:00:00.000Z', expiresAt: '2026-03-04T00:00:00.000Z',
    preview: { title: '替换后的报告', paragraphCount: 15, characterCount: 5000 },
  },
}

function renderDialog(overrides: Partial<ComponentProps<typeof WorkspaceSubmitDialog>> = {}) {
  return renderToStaticMarkup(createElement(WorkspaceSubmitDialog, {
    groups: [completedGroup(), laterGroup], defaultStageId: laterGroup.stage.id,
    replacementReport: report(), canSubmit: true, currentProjectId: 'project-1', phase: { step: 'idle' },
    onFile() {}, onConfigure() {}, onPrepare() {}, onCommit() {}, onClose() {}, ...overrides,
  }))
}

function assertReplacementExplanation(html: string) {
  assert.match(html, /开题研究 V2 · 开题完结原报告/)
  assert.match(html, /原报告变为阶段更新报告/)
  assert.match(html, /原文件及已有分析、洞察保留/)
  assert.match(html, /课题进度不变/)
}

const replacementPhases: WorkspaceSubmitPhase[] = [
  { step: 'idle' }, { step: 'configure', file },
  { ...configured, step: 'confirm' }, { ...configured, step: 'preparing' },
  { ...configured, step: 'failed', error: '解析失败' }, preparedPhase,
]

for (const phase of replacementPhases) {
  test('replacement explanation is visible during ' + phase.step, () => {
    assertReplacementExplanation(renderDialog({ phase }))
  })
}

test('replacement explains the clicked past stage and completion kind without options', () => {
  const html = renderDialog({ phase: { step: 'configure', file } })
  assert.match(submissionSummary(html), /本次提交的是「开题研究」阶段的完结报告。/)
  assert.doesNotMatch(submissionSummary(html), /事实调研|阶段报告/)
  assert.match(html, /本阶段已完成，本次补交或更新完结成果，课题进度不变。/)
  assert.doesNotMatch(html, /确认替换/)
})

test('prepared replacement offers enabled final confirmation with retained-report warning', () => {
  const html = renderDialog({ phase: preparedPhase })
  assertReplacementExplanation(html)
  assert.doesNotMatch(buttonWithText(html, '确认替换'), /disabled=/)
  assert.match(html, /确认后才会写入课题/)
  assert.doesNotMatch(html, />确认提交</)
})

test('ordinary submission explains the default stage and update kind without options', () => {
  const html = renderDialog({ replacementReport: undefined, phase: { step: 'configure', file } })
  assert.match(html, /提交研究报告/)
  assert.match(submissionSummary(html), /本次提交的是「事实调研」阶段的阶段报告。/)
  assert.match(html, /用于记录本阶段进展，不会结束本阶段。/)
  assert.doesNotMatch(submissionSummary(html), /完结报告/)
  assert.doesNotMatch(html, /原报告变为|原文件及已有分析|确认替换/)
  const preparedHtml = renderDialog({ replacementReport: undefined, phase: {
    ...preparedPhase, stageId: laterGroup.stage.id, reportKind: 'update',
    impact: previewSubmissionImpact({ stages: [completedStage, laterGroup.stage], targetStageId: laterGroup.stage.id, reportKind: 'update' }),
  } })
  assert.doesNotMatch(buttonWithText(preparedHtml, '确认提交'), /disabled=/)
  assert.doesNotMatch(preparedHtml, /确认替换|原报告变为/)
})

test('preparing shows parsing status and no enabled submit action', () => {
  const html = renderDialog({ replacementReport: undefined, phase: {
    ...configured, step: 'preparing', stageId: laterGroup.stage.id,
  } })
  assert.equal(buttons(html).some((button) => /解析文件|重试解析/.test(button.replace(/<[^>]*>/g, ''))), false)
  assert.match(buttonWithText(html, '确认提交'), /disabled=/)
  assert.doesNotMatch(html, /<select\b/)
  assert.match(submissionSummary(html), /本次提交的是「事实调研」阶段的完结报告。/)
  assert.match(html, /正在解析文件/)
  assert.match(html, /正在提取报告内容，请稍候。解析完成后即可确认提交。/)
  assert.match(html, /role="status"/)
})

test('prepared explains the configured report and shows actual parsed counts', () => {
  const html = renderDialog({ replacementReport: undefined, phase: {
    ...preparedPhase, stageId: laterGroup.stage.id, reportKind: 'update',
    impact: previewSubmissionImpact({ stages: [completedStage, laterGroup.stage], targetStageId: laterGroup.stage.id, reportKind: 'update' }),
  } })
  assert.doesNotMatch(html, /<select\b/)
  assert.match(submissionSummary(html), /本次提交的是「事实调研」阶段的阶段报告。/)
  assert.match(html, /解析完成/)
  assert.match(html, /<span[^>]*>15<\/span> 段落 · <span[^>]*>5,000<\/span> 字/)
  assert.match(html, /确认后才会写入课题/)
})

test('completion summary names only the chosen type and explains its stage effect', () => {
  const html = renderDialog({ replacementReport: undefined, phase: {
    ...preparedPhase, stageId: laterGroup.stage.id,
    impact: previewSubmissionImpact({ stages: [completedStage, laterGroup.stage], targetStageId: laterGroup.stage.id, reportKind: 'completion' }),
  } })
  assert.match(submissionSummary(html), /本次提交的是「事实调研」阶段的完结报告。/)
  assert.match(html, /作为本阶段完结成果，确认提交后将完成本阶段。/)
  assert.doesNotMatch(submissionSummary(html), /阶段报告|不会结束本阶段/)
})

test('prepared upload without preview still reports parsed status without counts', () => {
  const html = renderDialog({ phase: { ...preparedPhase, upload: { ...preparedPhase.upload, preview: undefined } } })
  assert.match(html, /解析完成/)
  assert.doesNotMatch(html, /段落 · /)
  assert.doesNotMatch(html, /undefined/)
  assert.match(html, /确认后才会写入课题/)
  assert.doesNotMatch(buttonWithText(html, '确认替换'), /disabled=/)
})

test('failed shows the parse error with retry and never offers confirmation', () => {
  const html = renderDialog({ replacementReport: undefined, phase: {
    step: 'failed', file, stageId: laterGroup.stage.id, reportKind: 'update', error: '解析失败：文档已加密。',
  } })
  assert.match(html, /解析失败：文档已加密。/)
  assert.match(html, /报告尚未提交/)
  assert.match(html, /role="alert"/)
  assert.match(html, /更换报告文件/)
  assert.doesNotMatch(buttonWithText(html, '重试解析'), /disabled=/)
  assert.equal(buttons(html).some((button) => /确认提交|确认替换/.test(button.replace(/<[^>]*>/g, ''))), false)
  assert.doesNotMatch(html, /<select\b/)
  assert.match(submissionSummary(html), /本次提交的是「事实调研」阶段的阶段报告。/)
})

test('uncertain retries the same submission and acknowledged receipt offers no new commit', () => {
  const committedCommand = {
    uploadId: 'upload-1', stageId: completedStage.id, reportKind: 'completion' as const,
    expectedPlanRevision: 0, expectedWorkflowRevision: 0, expectedCompletionRevision: 1,
    expectedCompletionReportId: 'current-completion',
  }
  const uncertainPhase: WorkspaceSubmitPhase = {
    ...configured, step: 'uncertain', upload: preparedPhase.upload, command: committedCommand,
    idempotencyKey: 'retry_key_12345678', error: '网络中断，提交结果未确认。',
  }
  const uncertainHtml = renderDialog({ replacementReport: undefined, phase: uncertainPhase })
  assert.doesNotMatch(buttonWithText(uncertainHtml, '重试同一提交'), /disabled=/)
  assert.doesNotMatch(uncertainHtml, /确认提交|确认替换|解析文件/)
  assert.match(uncertainHtml, /报告可能已保存，请重试同一提交，无需重新上传或解析。/)
  assert.match(uncertainHtml, /正在确认本次提交的结果，请勿重新上传。/)
  assert.match(uncertainHtml, /解析完成/)
  const acknowledgedPhase: WorkspaceSubmitPhase = {
    ...configured, step: 'acknowledged', upload: preparedPhase.upload, command: committedCommand,
    idempotencyKey: 'retry_key_12345678', replayed: true,
    receipt: {
      reportId: 'r-replaced', projectId: 'project-1', stageId: completedStage.id, stageVersion: 3,
      submissionSequence: 3, submittedAs: 'completion', submittedAt: '2026-03-05T00:00:00.000Z', outboxEventId: 'evt-1',
    },
  }
  const acknowledgedHtml = renderDialog({ replacementReport: undefined, phase: acknowledgedPhase })
  assert.equal(acknowledgedHtml.includes('r-replaced'), false)
  assert.doesNotMatch(acknowledgedHtml, /确认提交|确认替换|重试同一提交|重试解析/)
  assert.equal(acknowledgedHtml.includes('工作区刷新失败'), false)
})

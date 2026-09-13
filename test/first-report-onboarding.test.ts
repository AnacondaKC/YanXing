import assert from 'node:assert/strict'
import { EMPTY_WORKSPACE_CAPABILITIES } from './helpers/workspace-capabilities'
import test from 'node:test'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createFirstReportDraft,
  reconcileFirstReportDraft,
  selectFirstReportStage,
  type FirstReportDraftState,
} from '../components/first-report-draft'
import { ProjectFirstReportOnboarding } from '../components/project-first-report-onboarding'
import { ReportUploadForm } from '../components/report-upload-form'
import { WorkspaceUpdateReportDialog } from '../components/workspace-update-report-dialog'
import { WorkspaceProjectHeader } from '../components/workspace-project-header'
import {
  SKIPPED_EMPTY_COPY,
  type WorkspaceProjectDetail,
  type WorkspaceProjectListItem,
  type WorkspaceReportCard,
  type WorkspaceSelection,
  type WorkspaceWorkflow,
} from '../lib/workspace-submission'
import { stageGroup } from '../modules/reports/workspace-query'
import type { ProjectStageRecord } from '../modules/projects/stage-domain'

function stage(overrides: Partial<ProjectStageRecord> = {}): ProjectStageRecord {
  return {
    id: 'stage-1',
    projectId: 'project-1',
    ordinal: 1,
    title: '开题研究',
    description: '梳理研究问题与证据',
    lifecycleStatus: 'in_progress',
    nextReportVersion: 1,
    stateRevision: 0,
    completionRevision: 0,
    ...overrides,
  }
}

function report(): WorkspaceReportCard {
  return {
    id: 'report-1',
    projectId: 'project-1',
    stageId: 'stage-1',
    stageVersion: 1,
    submissionSequence: 1,
    submittedAs: 'update',
    isCurrentCompletion: false,
    isLatestSubmission: true,
    wasFirstStageSubmission: true,
    title: '既有研究报告',
    fileName: 'report.docx',
    sourceSize: 1024,
    paragraphCount: 12,
    characterCount: 4000,
    submittedBy: 'owner',
    submittedAt: '2026-03-02T00:00:00.000Z',
    labels: {
      stageLabel: '阶段01 · 开题研究',
      reportLabel: '开题研究 V1',
      compactLabel: '阶段01 V1',
      roleLabel: '阶段更新报告',
    },
    capabilities: { ...EMPTY_WORKSPACE_CAPABILITIES },
    comparison: { status: 'unavailable', reason: 'first_stage_submission' },
  }
}

interface DetailFixtureOptions {
  stages?: ProjectStageRecord[]
  reports?: WorkspaceReportCard[]
  project?: Partial<WorkspaceProjectListItem>
  workflow?: Partial<WorkspaceWorkflow>
  selected?: WorkspaceSelection
}

function detailFixture(options: DetailFixtureOptions = {}): WorkspaceProjectDetail {
  const stages = options.stages ?? [stage()]
  const reports = options.reports ?? []
  const project: WorkspaceProjectListItem = {
    id: 'project-1',
    title: '产业政策研究课题',
    ownerId: 'owner',
    ownerName: '研究负责人',
    objective: '研究目标',
    description: '研究说明',
    canManage: true,
    canDelete: false,
    canSubmit: true,
    canEditPlan: true,
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    submittedReportCount: reports.length,
    completedStageCount: stages.filter(item => item.lifecycleStatus === 'completed').length,
    ...options.project,
  }
  const workflow: WorkspaceWorkflow = {
    planRevision: 0,
    workflowRevision: 0,
    nextSubmissionSequence: reports.length + 1,
    currentStageId: stages.find(item => item.lifecycleStatus === 'in_progress')?.id,
    ...options.workflow,
  }
  return {
    project,
    workflow,
    stages: [...stages].sort((left, right) => left.ordinal - right.ordinal).map(stage => stageGroup({
      stage, reports: reports.filter(report => report.stageId === stage.id), canWrite: project.canSubmit,
    })),
    latestSubmission: reports.find(item => item.isLatestSubmission),
    currentCompletionByStage: {},
    selected: options.selected ?? { stageId: workflow.currentStageId ?? stages[0]?.id ?? '', source: 'current_stage' },
  }
}

function selectedFile(): File {
  return new File(['完整研究报告'], '研究报告.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
}

type OnboardingOverrides = Partial<Omit<ComponentProps<typeof ProjectFirstReportOnboarding>, 'detail'>>

function renderOnboarding(detail: WorkspaceProjectDetail, overrides: OnboardingOverrides = {}): string {
  return renderToStaticMarkup(createElement(ProjectFirstReportOnboarding, {
    detail,
    onSubmit: () => assert.fail('Rendering must not submit a report'),
    ...overrides,
  }))
}

function buttonMarkup(markup: string, label: string): string {
  const buttons = [...markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0])
  const button = buttons.find(item => item.replace(/<[^>]+>/g, '') === label)
  assert.ok(button, `Expected button: ${label}`)
  return button
}

function inputMarkup(markup: string, type: string): string {
  const input = [...markup.matchAll(/<input\b[^>]*>/g)]
    .map(match => match[0])
    .find(item => item.includes('type="' + type + '"'))
  assert.ok(input, 'Expected input type: ' + type)
  return input
}

function radioMarkup(markup: string, value: string): string {
  const radio = [...markup.matchAll(/<input\b[^>]*>/g)]
    .map(match => match[0])
    .find(item => item.includes('type="radio"') && item.includes('value="' + value + '"'))
  assert.ok(radio, 'Expected report type radio: ' + value)
  return radio
}

function renderUpdateReport(detail: WorkspaceProjectDetail): string {
  return renderToStaticMarkup(createElement(WorkspaceUpdateReportDialog, {
    detail,
    onSubmit: () => assert.fail('Rendering must not submit a report'),
    onClose: () => assert.fail('Rendering must not close the dialog'),
  }))
}

test('update report dialog labels its modal and reuses the complete upload form without onboarding', () => {
  const markup = renderUpdateReport(detailFixture({ reports: [report()], project: { canManage: false } }))
  const dialog = markup.match(/<div\b[^>]*role="dialog"[^>]*>/)?.[0]
  assert.ok(dialog)
  assert.match(dialog, /aria-modal="true"/)
  const titleId = dialog.match(/aria-labelledby="([^"]+)"/)?.[1]
  const descriptionId = dialog.match(/aria-describedby="([^"]+)"/)?.[1]
  assert.ok(titleId)
  assert.ok(descriptionId)
  assert.ok(markup.includes('id="' + titleId + '"'))
  assert.ok(markup.includes('id="' + descriptionId + '"'))
  assert.match(markup, />更新报告<\/h2>/)
  assert.match(markup, /已有报告及分析结果将保留/)
  assert.match(markup, /<form\b[^>]*aria-label="上传研究报告"/)
  assert.match(markup, /aria-label="本次交付阶段"/)
  assert.match(markup, /所属阶段/)
  assert.match(markup, /报告文件/)
  assert.match(radioMarkup(markup, 'update'), /\schecked=""/)
  assert.doesNotMatch(radioMarkup(markup, 'completion'), /\schecked=""|\sdisabled=""/)
  assert.match(inputMarkup(markup, 'file'), /accept="(?=[^"]*\.pdf)(?=[^"]*\.docx)/)
  assert.doesNotMatch(inputMarkup(markup, 'file'), /\sdisabled=""/)
  assert.match(buttonMarkup(markup, '上传报告'), /\sdisabled=""/)
  assert.match(markup, /上传后先解析文件，确认提交后正式归档/)
  assert.doesNotMatch(markup, /研究报告交付引导|综合研判|继续处理已有提交/)
})

test('update report dialog keeps completed stages completion-only', () => {
  const markup = renderUpdateReport(detailFixture({ stages: [stage({ lifecycleStatus: 'completed', completionReason: 'skipped' })] }))
  assert.match(radioMarkup(markup, 'update'), /\sdisabled=""/)
  assert.doesNotMatch(radioMarkup(markup, 'update'), /\schecked=""/)
  assert.match(radioMarkup(markup, 'completion'), /\schecked=""/)
  assert.doesNotMatch(radioMarkup(markup, 'completion'), /\sdisabled=""/)
  assert.doesNotMatch(inputMarkup(markup, 'file'), /\sdisabled=""/)
  assert.ok(markup.includes(SKIPPED_EMPTY_COPY))
  assert.match(markup, /不回退课题进度/)
})

test('update report dialog disables uploads for missing plans and unavailable stage capabilities', () => {
  const unavailable = detailFixture()
  unavailable.stages = unavailable.stages.map(group => ({ ...group, canSubmitUpdate: false, canSubmitCompletion: false }))
  for (const detail of [detailFixture({ stages: [] }), unavailable]) {
    const markup = renderUpdateReport(detail)
    assert.match(radioMarkup(markup, 'update'), /\sdisabled=""/)
    assert.match(radioMarkup(markup, 'completion'), /\sdisabled=""/)
    assert.match(inputMarkup(markup, 'file'), /\sdisabled=""/)
    assert.match(buttonMarkup(markup, '上传报告'), /\sdisabled=""/)
    assert.match(markup, /配置交付阶段|当前阶段暂不支持提交报告/)
  }
})

test('update report dialog enforces read-only submission permission even for managers', () => {
  const markup = renderUpdateReport(detailFixture({ reports: [report()], project: { canSubmit: false, canManage: true } }))
  assert.match(markup, /您当前以只读权限查看该课题/)
  assert.doesNotMatch(markup, /<form|type="file"|type="radio"|aria-label="本次交付阶段"/)
})

for (const canSubmit of [true, false]) {
  test('shared upload form preserves pending submission recovery with canSubmit=' + canSubmit, () => {
    const markup = renderToStaticMarkup(createElement(ReportUploadForm, {
      detail: detailFixture({ reports: [report()], project: { canSubmit } }),
      onSubmit: () => assert.fail('Pending submissions must not trigger a new upload'),
      onResumeSubmit: () => {},
    }))
    assert.ok(buttonMarkup(markup, '继续处理已有提交'))
    assert.match(markup, /不要重新上传|此处不会新建提交/)
    assert.doesNotMatch(markup, /<form|type="file"|type="radio"/)
  })
}

test('first-report draft prefers explicit stage, then current stage, then the first planned stage', () => {
  const stages = [stage(), stage({ id: 'stage-2', ordinal: 2, title: '调研', lifecycleStatus: 'not_started' })]
  const scenarios = [
    { selectedStageId: 'stage-2', currentStageId: 'stage-1', expectedStageId: 'stage-2' },
    { selectedStageId: 'removed-stage', currentStageId: 'stage-1', expectedStageId: 'stage-1' },
    { selectedStageId: '', currentStageId: 'removed-stage', expectedStageId: 'stage-1' },
  ]
  for (const scenario of scenarios) {
    const detail = detailFixture({
      stages,
      selected: { stageId: scenario.selectedStageId, source: 'explicit' },
      workflow: { currentStageId: scenario.currentStageId },
    })
    assert.deepEqual(createFirstReportDraft(detail), {
      stageId: scenario.expectedStageId,
      reportKind: 'update',
    })
  }
})

test('initial completed stage may default to completion with both report types visible', () => {
  const detail = detailFixture({ stages: [stage({ lifecycleStatus: 'completed', completionReason: 'skipped' })] })
  assert.deepEqual(createFirstReportDraft(detail), { stageId: 'stage-1', reportKind: 'completion' })
  const markup = renderOnboarding(detail)
  assert.match(markup, /aria-label="本次交付阶段"/)
  assert.ok(markup.includes(SKIPPED_EMPTY_COPY))
  assert.match(radioMarkup(markup, 'update'), /\sdisabled=""/)
  assert.doesNotMatch(radioMarkup(markup, 'update'), /\schecked=""/)
  assert.match(radioMarkup(markup, 'completion'), /\schecked=""/)
  assert.doesNotMatch(radioMarkup(markup, 'completion'), /\sdisabled=""/)
  assert.match(markup, /阶段报告/)
  assert.match(markup, /完结报告/)
  assert.match(inputMarkup(markup, 'file'), /accept="(?=[^"]*\.pdf)(?=[^"]*\.docx)/)
  assert.match(buttonMarkup(markup, '上传报告'), /\sdisabled=""/)
})

test('stable stage ids preserve the exact draft through renamed, reordered and expanded plans', () => {
  const file = selectedFile()
  const draft: FirstReportDraftState = { stageId: 'stage-2', reportKind: 'completion', file }
  const originalStages = [stage(), stage({ id: 'stage-2', ordinal: 2, title: '调研', lifecycleStatus: 'not_started' })]
  const revisedStages = [
    stage({ id: 'stage-2', ordinal: 1, title: '更新后的调研', description: '新的阶段说明', lifecycleStatus: 'not_started' }),
    stage({ ordinal: 2 }),
    stage({ id: 'stage-3', ordinal: 3, title: '成果形成', lifecycleStatus: 'not_started' }),
  ]
  for (const stages of [originalStages, revisedStages]) {
    const detail = detailFixture({ stages, workflow: { planRevision: 2 } })
    const reconciled = reconcileFirstReportDraft(draft, detail.stages)
    assert.equal(reconciled, draft)
    assert.equal(reconciled.file, file)
    assert.equal(reconciled.stageId, 'stage-2')
  }
})

test('removing the selected stage preserves its file and requires a new stage selection', () => {
  const file = selectedFile()
  const draft: FirstReportDraftState = { stageId: 'stage-2', reportKind: 'update', file }
  const remaining = detailFixture().stages
  const reconciled = reconcileFirstReportDraft(draft, remaining)
  assert.notEqual(reconciled, draft)
  assert.equal(reconciled.stageId, '')
  assert.equal(reconciled.reportKind, undefined)
  assert.equal(reconciled.file, file)
  assert.match(reconciled.notice ?? '', /阶段已移除/)
  assert.match(reconciled.notice ?? '', /已选文件会保留/)
  assert.equal(draft.stageId, 'stage-2')
  assert.equal(reconcileFirstReportDraft(reconciled, remaining), reconciled)
  assert.equal(reconcileFirstReportDraft(reconciled, []), reconciled)
})

test('a completed update target requires explicit type selection and never silently becomes completion', () => {
  const groups = detailFixture({ stages: [stage({ lifecycleStatus: 'completed', completionReason: 'skipped' })] }).stages
  const file = selectedFile()
  const draft: FirstReportDraftState = { stageId: 'stage-1', reportKind: 'update', file }
  const reconciled = reconcileFirstReportDraft(draft, groups)
  assert.equal(reconciled.stageId, draft.stageId)
  assert.equal(reconciled.reportKind, undefined)
  assert.equal(reconciled.file, file)
  assert.match(reconciled.notice ?? '', /不再接受阶段报告/)
  assert.match(reconciled.notice ?? '', /已选文件会保留/)
  assert.equal(draft.reportKind, 'update')
  assert.equal(reconcileFirstReportDraft(reconciled, groups), reconciled)
})

test('manually changing an update draft to a completed stage preserves the file and clears the invalid type', () => {
  const target = detailFixture({ stages: [stage({ id: 'completed-stage', lifecycleStatus: 'completed', completionReason: 'skipped' })] }).stages[0]
  const file = selectedFile()
  const draft: FirstReportDraftState = { stageId: 'stage-1', reportKind: 'update', file }
  const selected = selectFirstReportStage(draft, target)
  assert.equal(selected.stageId, 'completed-stage')
  assert.equal(selected.reportKind, undefined)
  assert.equal(selected.file, file)
  assert.match(selected.notice ?? '', /重新选择报告类型/)
  assert.deepEqual(draft, { stageId: 'stage-1', reportKind: 'update', file })
})

test('completion drafts remain valid on completed stages and valid stage changes clear obsolete notices', () => {
  const target = detailFixture({ stages: [stage({ id: 'completed-stage', lifecycleStatus: 'completed', completionReason: 'skipped' })] }).stages[0]
  const file = selectedFile()
  const draft: FirstReportDraftState = { stageId: 'stage-1', reportKind: 'completion', file, notice: '旧提示' }
  const selected = selectFirstReportStage(draft, target)
  assert.equal(selected.stageId, target.stage.id)
  assert.equal(selected.reportKind, 'completion')
  assert.equal(selected.file, file)
  assert.equal(selected.notice, undefined)
  assert.equal(reconcileFirstReportDraft(selected, [target]), selected)
})

test('choosing a replacement stage does not auto-select a type cleared by plan reconciliation', () => {
  const detail = detailFixture()
  const draft: FirstReportDraftState = { stageId: '', file: selectedFile(), notice: '原阶段已移除' }
  const selected = selectFirstReportStage(draft, detail.stages[0])
  assert.equal(selected.stageId, 'stage-1')
  assert.equal(selected.reportKind, undefined)
  assert.equal(selected.file, draft.file)
  assert.equal(selected.notice, undefined)
})

test('onboarding initially displays stage, native report radios and upload together', () => {
  const markup = renderOnboarding(detailFixture())
  assert.match(markup, /aria-label="研究报告交付引导"/)
  assert.match(markup, /aria-label="本次交付阶段"/)
  assert.match(markup, /<fieldset\b[^>]*aria-label="本次报告类型"/)
  assert.match(markup, /<legend\b[^>]*>报告类型<\/legend>/)
  const update = radioMarkup(markup, 'update')
  const completion = radioMarkup(markup, 'completion')
  assert.match(update, /\schecked=""/)
  assert.doesNotMatch(completion, /\schecked=""/)
  assert.doesNotMatch(update + completion, /\sdisabled=""/)
  const name = update.match(/\sname="([^"]+)"/)?.[1]
  assert.ok(name)
  assert.equal(completion.match(/\sname="([^"]+)"/)?.[1], name)
  assert.match(markup, /阶段报告/)
  assert.match(markup, /完结报告/)
  assert.match(inputMarkup(markup, 'file'), /accept="(?=[^"]*\.pdf)(?=[^"]*\.docx)/)
  assert.doesNotMatch(inputMarkup(markup, 'file'), /\sdisabled=""/)
  assert.match(buttonMarkup(markup, '上传报告'), /\sdisabled=""/)
  assert.match(markup, /上传后先解析文件，确认提交后正式归档。/)
  assert.doesNotMatch(markup, /下一步:|上一步|上传并确认提交/)
  assert.match(markup, /综合研判/)
  assert.doesNotMatch(markup, /<figcaption|分析工作台样式示意/)
  assert.match(markup, /h-full/)
  assert.match(markup, /flex-1/)
  assert.match(markup, /overflow-y-auto/)
})

test('separate upload forms isolate native radio groups', () => {
  const detail = detailFixture()
  const markup = renderToStaticMarkup(createElement('div', null,
    createElement(ProjectFirstReportOnboarding, { detail, onSubmit: () => {} }),
    createElement(ProjectFirstReportOnboarding, { detail, onSubmit: () => {} }),
  ))
  const names = [...markup.matchAll(/<input\b[^>]*>/g)]
    .map(match => match[0])
    .filter(input => input.includes('type="radio"'))
    .map(input => input.match(/\sname="([^"]+)"/)?.[1])
  assert.equal(names.length, 4)
  assert.ok(names.every(Boolean))
  assert.equal(names[0], names[1])
  assert.equal(names[2], names[3])
  assert.notEqual(names[0], names[2])
})

test('cross-stage update warns about every unfinished predecessor and retains existing reports', () => {
  const detail = detailFixture({
    stages: [stage({ nextReportVersion: 2 }),
      stage({ id: 'stage-2', ordinal: 2, lifecycleStatus: 'not_started' }),
      stage({ id: 'stage-3', ordinal: 3, lifecycleStatus: 'not_started' })],
    reports: [report()],
    selected: { stageId: 'stage-3', source: 'explicit' },
  })
  const markup = renderOnboarding(detail)
  assert.match(radioMarkup(markup, 'update'), /\schecked=""/)
  assert.ok(markup.includes('确认提交后，将跳过并完成 2 个前置阶段，已有报告仍会保留。具体影响将在提交前供你确认。'))
  assert.match(buttonMarkup(markup, '上传报告'), /\sdisabled=""/)
  assert.doesNotMatch(renderOnboarding(detailFixture()), /将跳过并完成/)
})

test('empty plans keep all upload controls visible but disabled with a reason', () => {
  const detail = detailFixture({ stages: [] })
  const draft = createFirstReportDraft(detail)
  assert.deepEqual(draft, { stageId: '', reportKind: undefined })
  assert.equal(reconcileFirstReportDraft(draft, []), draft)
  const markup = renderOnboarding(detail)
  assert.match(markup, /请先调整研究计划，配置交付阶段/)
  assert.match(markup, /<button\b[^>]*aria-label="本次交付阶段"[^>]*disabled=""/)
  assert.match(radioMarkup(markup, 'update'), /\sdisabled=""/)
  assert.match(radioMarkup(markup, 'completion'), /\sdisabled=""/)
  assert.match(inputMarkup(markup, 'file'), /\sdisabled=""/)
  assert.match(buttonMarkup(markup, '上传报告'), /\sdisabled=""/)
  assert.doesNotMatch(markup, />调整研究计划<|>编辑课题信息</)
})

test('stage capabilities disable upload independently of project permission and explain why', () => {
  const detail = detailFixture()
  detail.stages = detail.stages.map(group => ({ ...group, canSubmitUpdate: false, canSubmitCompletion: false }))
  const markup = renderOnboarding(detail)
  assert.match(markup, /aria-label="本次交付阶段"/)
  assert.match(radioMarkup(markup, 'update'), /\sdisabled=""/)
  assert.match(radioMarkup(markup, 'completion'), /\sdisabled=""/)
  assert.match(inputMarkup(markup, 'file'), /\sdisabled=""/)
  assert.match(buttonMarkup(markup, '上传报告'), /\sdisabled=""/)
  assert.match(markup, /当前阶段.*(?:无法|不可|不支持|没有|无).*提交|没有.*提交权限/)
})

test('submission permission controls first-screen write actions without plan or metadata editors', () => {
  for (const canSubmit of [true, false]) {
    const markup = renderOnboarding(detailFixture({ project: { canSubmit, canManage: true, canEditPlan: true } }))
    assert.equal(markup.includes('aria-label="本次交付阶段"'), canSubmit)
    assert.equal(markup.includes('aria-label="本次报告类型"'), canSubmit)
    assert.equal(markup.includes('type="file"'), canSubmit)
    assert.equal(markup.includes('您当前以只读权限查看该课题'), !canSubmit)
    assert.doesNotMatch(markup, />调整研究计划<|>编辑课题信息</)
  }
})

test('empty stages omit the removed report footer for submitters and readers', () => {
  for (const canSubmit of [true, false]) {
    const detail = detailFixture({
      stages: [stage({ nextReportVersion: 2 }), stage({ id: 'stage-2', ordinal: 2, title: '调研', lifecycleStatus: 'not_started' })],
      reports: [report()],
      project: { canSubmit, canManage: canSubmit, canEditPlan: canSubmit },
      selected: { stageId: 'stage-2', source: 'explicit' },
    })
    const markup = renderOnboarding(detail)
    assert.match(markup, /本阶段暂无报告/)
    assert.doesNotMatch(markup, /已有报告入口|查看已有报告|查看全部历史|开题研究 V1|最近提交|当前完结/)
  }
  const firstReport = renderOnboarding(detailFixture())
  assert.doesNotMatch(firstReport, /aria-label="已有报告入口"|查看已有报告|查看全部历史/)
})

test('pending submissions retain recovery without the removed report footer', () => {
  const detail = detailFixture({ reports: [report()] })
  const markup = renderOnboarding(detail, { onResumeSubmit: () => {} })
  assert.ok(buttonMarkup(markup, '继续处理已有提交'))
  assert.match(markup, /不要重新上传/)
  assert.doesNotMatch(markup, /aria-label="本次交付阶段"|aria-label="本次报告类型"|type="file"|下一步:/)
  assert.doesNotMatch(markup, /已有报告入口|查看已有报告|查看全部历史|开题研究 V1|最近提交|当前完结/)
})

test('read-only projects can return to an existing submission without exposing new write actions', () => {
  const markup = renderOnboarding(detailFixture({ project: { canSubmit: false, canManage: false, canEditPlan: false } }), { onResumeSubmit: () => {} })
  assert.match(markup, /您当前以只读权限查看该课题/)
  assert.ok(buttonMarkup(markup, '继续处理已有提交'))
  assert.match(markup, /可返回原课题核对结果；此处不会新建提交/)
  assert.doesNotMatch(markup, /aria-label="本次交付阶段"|type="file"|下一步:|编辑课题信息|调整研究计划/)
})

test('project header keeps its executive summary when no action children are composed', () => {
  const detail = detailFixture()
  const markup = renderToStaticMarkup(createElement(WorkspaceProjectHeader, { detail }))
  assert.match(markup, /<h1\b[^>]*>产业政策研究课题<\/h1>/)
  assert.match(markup, /负责人：研究负责人/)
  assert.match(markup, /阶段 1\/1/)
  assert.doesNotMatch(markup, /阶段与报告选择|查看阶段|查看提交|提交报告|课题信息|研究计划/)
})


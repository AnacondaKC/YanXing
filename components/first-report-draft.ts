import { allowedReportKinds, type WorkspaceProjectDetail, type WorkspaceStageGroup } from '@/lib/workspace-submission'
import type { ReportSubmissionKind } from '@/modules/reports/submission-domain'

export interface FirstReportDraft {
  file: File
  stageId: string
  reportKind: ReportSubmissionKind
}

export interface FirstReportDraftState {
  stageId: string
  reportKind?: ReportSubmissionKind
  file?: File
  notice?: string
}

export function createFirstReportDraft(detail: WorkspaceProjectDetail): FirstReportDraftState {
  const initial = detail.stages.find(group => group.stage.id === detail.selected.stageId)
    ?? detail.stages.find(group => group.stage.id === detail.workflow.currentStageId)
    ?? detail.stages[0]
  return {
    stageId: initial?.stage.id ?? '',
    reportKind: initial ? allowedReportKinds(initial.stage)[0] : undefined,
  }
}

export function reconcileFirstReportDraft(draft: FirstReportDraftState, groups: WorkspaceStageGroup[]): FirstReportDraftState {
  const group = groups.find(item => item.stage.id === draft.stageId)
  if (draft.stageId && !group) {
    return {
      ...draft,
      stageId: '',
      reportKind: undefined,
      notice: '研究计划已更新，原交付阶段已移除。请重新选择阶段，已选文件会保留。',
    }
  }
  if (group && draft.reportKind && !allowedReportKinds(group.stage).includes(draft.reportKind)) {
    return {
      ...draft,
      reportKind: undefined,
      notice: '该阶段已完成，不再接受阶段报告。请重新选择报告类型，已选文件会保留。',
    }
  }
  return draft
}

export function selectFirstReportStage(draft: FirstReportDraftState, group: WorkspaceStageGroup): FirstReportDraftState {
  const selected = { ...draft, stageId: group.stage.id, notice: undefined }
  return reconcileFirstReportDraft(selected, [group])
}

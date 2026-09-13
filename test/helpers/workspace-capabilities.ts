import type { WorkspaceCapabilities } from '../../modules/contracts/submission-workspace'

export const EMPTY_WORKSPACE_CAPABILITIES: WorkspaceCapabilities = {
  canSubmitUpdate: false,
  canSubmitCompletion: false,
  canDelete: false,
  canCancelAnalysisJob: false,
  canCancelInsightJob: false,
  canEditPlan: false,
  analysisAction: 'none',
  insightAction: 'none',
  disabledReasons: [],
}

import type { AnalysisJob } from '@/modules/analysis/domain'
import type { AnalysisSnapshotPayload, AnalysisModuleState } from '@/modules/contracts/analysis'
import type { ReportVersion } from '@/modules/reports/domain'

export interface DashboardReportState {
  activeReportId?: string
  activeReport?: ReportVersion
  latestReport?: ReportVersion
  analysisSnapshot?: AnalysisSnapshotPayload
  activeJobId?: string
  analysisJob?: AnalysisJob
  analysisModuleStates: AnalysisModuleState[]
}

export function resetDashboardAnalysisState(state: DashboardReportState): DashboardReportState {
  return {
    ...state,
    analysisSnapshot: undefined,
    activeJobId: undefined,
    analysisJob: undefined,
    analysisModuleStates: [],
  }
}

export function resetDashboardReportState(state: DashboardReportState): DashboardReportState {
  return {
    ...resetDashboardAnalysisState(state),
    activeReportId: undefined,
    activeReport: undefined,
    latestReport: undefined,
  }
}

export function activateDashboardReport(state: DashboardReportState, report: ReportVersion): DashboardReportState {
  return {
    ...resetDashboardAnalysisState(state),
    activeReportId: report.id,
    activeReport: report,
    analysisSnapshot: undefined,
  }
}

export function refreshActiveDashboardReport(state: DashboardReportState, report: ReportVersion): DashboardReportState {
  return {
    ...resetDashboardAnalysisState(state),
    activeReportId: report.id,
    activeReport: report,
    analysisSnapshot: state.analysisSnapshot,
  }
}

export function emptyDashboardReportState(): DashboardReportState {
  return {
    activeReportId: undefined,
    activeReport: undefined,
    latestReport: undefined,
    analysisSnapshot: undefined,
    activeJobId: undefined,
    analysisJob: undefined,
    analysisModuleStates: [],
  }
}

export type WorkspaceReportIdentity = { projectId: string; reportId?: string }
export type UploadedReportContext = { projectId: string; viewGeneration: number }

export function sameWorkspaceReportIdentity(current: WorkspaceReportIdentity, next: WorkspaceReportIdentity) {
  if (current.projectId !== next.projectId) return false
  if (!next.reportId) return true
  return next.reportId === current.reportId
}

export function activateDashboardReportForProject(
  state: DashboardReportState,
  report: ReportVersion,
  currentProjectId: string,
): DashboardReportState {
  const base = report.projectId === currentProjectId ? state : emptyDashboardReportState()
  return activateDashboardReport(base, report)
}

export function acceptUploadedDashboardReport(report: ReportVersion): DashboardReportState {
  return {
    ...emptyDashboardReportState(),
    activeReportId: report.id,
    activeReport: report,
    latestReport: report,
  }
}

export function replaceActiveDashboardReport(state: DashboardReportState, report: ReportVersion): DashboardReportState {
  return {
    ...resetDashboardAnalysisState(state),
    activeReportId: report.id,
    activeReport: report,
    latestReport: state.latestReport?.id === report.id ? report : state.latestReport,
    analysisSnapshot: undefined,
  }
}

export function shouldAcceptUploadedReport(captured: UploadedReportContext, current: UploadedReportContext) {
  return captured.projectId === current.projectId && captured.viewGeneration === current.viewGeneration
}

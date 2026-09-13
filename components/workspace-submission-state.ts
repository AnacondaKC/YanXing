import { preferDisplayedAnalysisPayload, snapshotHasDisplayableResults } from '@/lib/analysis-job-progress'
import type { AnalysisSnapshotPayload } from '@/modules/contracts/analysis'
import type { SubmissionTask } from '@/modules/reports/submission-task-domain'
import type { WorkspaceDispatchError, WorkspaceOutboxDispatch, WorkspaceReportCard, WorkspaceSelection } from '@/lib/workspace-submission'

export type WorkspaceReportViewState = {
  selection: WorkspaceSelection
  selectedReport?: WorkspaceReportCard
  latestSubmission?: WorkspaceReportCard
  snapshot?: AnalysisSnapshotPayload
  analysisTask?: SubmissionTask
  insightTask?: SubmissionTask
  outboxPending: boolean
  dispatch?: WorkspaceOutboxDispatch
  dispatchError?: WorkspaceDispatchError
}

export function emptyWorkspaceReportView(selection: WorkspaceSelection = { stageId: '', source: 'current_stage' }): WorkspaceReportViewState {
  return { selection, outboxPending: false }
}

export function selectWorkspaceReport(state: WorkspaceReportViewState, input: {
  selection: WorkspaceSelection
  report?: WorkspaceReportCard
  latestSubmission?: WorkspaceReportCard
}): WorkspaceReportViewState {
  const sameReport = state.selectedReport?.id === input.report?.id
  return {
    selection: input.selection,
    selectedReport: input.report,
    latestSubmission: input.latestSubmission ?? state.latestSubmission,
    snapshot: sameReport ? state.snapshot : undefined,
    analysisTask: sameReport ? state.analysisTask : undefined,
    insightTask: sameReport ? state.insightTask : undefined,
    outboxPending: sameReport ? state.outboxPending : false,
    dispatch: sameReport ? state.dispatch : undefined,
    dispatchError: sameReport ? state.dispatchError : undefined,
  }
}

export function taskWouldRegress(current: SubmissionTask | undefined, incoming: SubmissionTask | undefined) {
  if (!current) return false
  if (!incoming) return true
  if (incoming.generation !== current.generation) return incoming.generation < current.generation
  if (incoming.id !== current.id) return true
  if (current.cancelRequested && !incoming.cancelRequested) return true
  return isTerminalTask(current) && incoming.status !== current.status
}

export function isTerminalTask(task: SubmissionTask) {
  return task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled'
}

export function applyWorkspaceReportDetail(state: WorkspaceReportViewState, input: {
  report: WorkspaceReportCard
  snapshot?: AnalysisSnapshotPayload
  analysisTask?: SubmissionTask
  insightTask?: SubmissionTask
  outboxPending?: boolean
  dispatch?: WorkspaceOutboxDispatch
  dispatchError?: WorkspaceDispatchError
}): WorkspaceReportViewState {
  if (state.selectedReport && state.selectedReport.id !== input.report.id) return state
  if (taskWouldRegress(state.analysisTask, input.analysisTask) || taskWouldRegress(state.insightTask, input.insightTask)) return state
  const nextSnapshot = input.snapshot && snapshotHasDisplayableResults(input.snapshot)
    ? preferDisplayedAnalysisPayload(state.snapshot, input.snapshot)
    : state.snapshot
  return {
    ...state,
    selectedReport: input.report,
    latestSubmission: state.latestSubmission?.id === input.report.id ? input.report : state.latestSubmission,
    snapshot: nextSnapshot,
    analysisTask: input.analysisTask ?? state.analysisTask,
    insightTask: input.insightTask ?? state.insightTask,
    outboxPending: input.outboxPending ?? Boolean(input.dispatch && (input.dispatch.status === 'pending' || input.dispatch.status === 'leased')),
    dispatch: input.dispatch ?? state.dispatch,
    dispatchError: input.dispatchError,
  }
}

export function applyWorkspaceAnalysisTask(state: WorkspaceReportViewState, task: SubmissionTask): WorkspaceReportViewState {
  if (state.selectedReport && task.reportId !== state.selectedReport.id) return state
  if (task.operation !== 'analysis' || taskWouldRegress(state.analysisTask, task)) return state
  return { ...state, analysisTask: task, dispatchError: undefined }
}

export function applyWorkspaceInsightTask(state: WorkspaceReportViewState, task: SubmissionTask): WorkspaceReportViewState {
  if (state.selectedReport && task.reportId !== state.selectedReport.id) return state
  if (task.operation !== 'insight' || taskWouldRegress(state.insightTask, task)) return state
  return { ...state, insightTask: task, dispatchError: undefined }
}

export function removeWorkspaceReport(state: WorkspaceReportViewState, reportId: string): WorkspaceReportViewState {
  if (state.selectedReport?.id !== reportId) return state
  return emptyWorkspaceReportView({ stageId: state.selection.stageId, source: 'explicit' })
}

export async function refreshWorkspaceProjections(refreshes: Array<() => Promise<unknown>>) {
  const results = await Promise.allSettled(refreshes.map((refresh) => Promise.resolve().then(refresh)))
  return results.every((result) => result.status === 'fulfilled' && result.value !== false)
}

type ReportReadIdentity = { reportId: string; generation: number }

// One request per report; notifications during a request schedule one authoritative reread.
export function createWorkspaceReportReader<T>(options: {
  fetch: (reportId: string, signal: AbortSignal) => Promise<T>
  apply: (identity: ReportReadIdentity, value: T) => boolean | void
  error: (identity: ReportReadIdentity, cause: unknown) => void
}) {
  const epochs = new Map<string, number>()
  const flights = new Map<string, { pending?: ReportReadIdentity; controller: AbortController; promise: Promise<void> }>()
  function invalidate(reportId: string) {
    epochs.set(reportId, (epochs.get(reportId) ?? 0) + 1)
  }
  function read(identity: ReportReadIdentity): Promise<void> {
    const existing = flights.get(identity.reportId)
    if (existing) {
      existing.pending = identity
      return existing.promise
    }
    const flight = { controller: new AbortController(), pending: undefined as ReportReadIdentity | undefined, promise: Promise.resolve() }
    flights.set(identity.reportId, flight)
    flight.promise = (async () => {
      let next: ReportReadIdentity | undefined = identity
      let retriedRegression = false
      while (next && !flight.controller.signal.aborted) {
        const current: ReportReadIdentity = next
        const epoch = epochs.get(current.reportId) ?? 0
        flight.pending = undefined
        try {
          const value = await options.fetch(current.reportId, flight.controller.signal)
          if (!flight.controller.signal.aborted && epoch === (epochs.get(current.reportId) ?? 0)) {
            if (options.apply(current, value) === false && !retriedRegression) {
              retriedRegression = true
              flight.pending ??= current
            }
          }
        } catch (cause) {
          if (!flight.controller.signal.aborted && epoch === (epochs.get(current.reportId) ?? 0)) options.error(current, cause)
        }
        next = flight.pending
      }
    })().finally(() => { if (flights.get(identity.reportId) === flight) flights.delete(identity.reportId) })
    return flight.promise
  }
  return {
    read,
    invalidate,
    dispose() {
      for (const flight of flights.values()) flight.controller.abort()
      flights.clear()
      epochs.clear()
    },
  }
}


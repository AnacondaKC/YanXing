import { apiFetch, fetchAllPages, mutationHeaders } from '@/lib/client-request'
import { WORKSPACE_API, emptyOverviewStats } from '@/lib/workspace-submission'
import type { ReportSubmissionCommand } from '@/modules/contracts/report-submission'
import type { StagePlanEdit, StageProjectCreate, WorkspaceProjectSafeEdit } from '@/modules/contracts/submission-workspace'
import type { KnowledgeItem } from '@/components/workspace-types'
import type {
  WorkspaceConfirmConflict,
  WorkspaceConfirmResponse,
  WorkspaceOverview,
  WorkspaceOverviewStats,
  WorkspaceProjectDetail,
  WorkspaceProjectListItem,
  WorkspaceReportCard,
  WorkspaceReportDetail,
  WorkspaceTaskResponse,
  WorkspaceUploadStatus,
} from '@/lib/workspace-submission'

export { WORKSPACE_API }

export type WorkspaceApiError = {
  status: number
  code?: string
  error: string
  details?: Record<string, string | number | null>
}

export class WorkspaceRequestError extends Error {
  constructor(readonly payload: WorkspaceApiError) {
    super(payload.error)
    this.name = 'WorkspaceRequestError'
  }
}

export function workspacePath(template: string, params: Record<string, string>) {
  return template.replace(/:([A-Za-z]+)/g, (_, key: string) => encodeURIComponent(params[key] ?? ''))
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  if (!text.trim()) return {}
  try {
    const body = JSON.parse(text) as unknown
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

async function expectOk(response: Response): Promise<Record<string, unknown>> {
  const body = await readJson(response)
  if (response.ok) return body
  throw new WorkspaceRequestError({
    status: response.status,
    code: typeof body.code === 'string' ? body.code : undefined,
    error: typeof body.error === 'string' ? body.error : '请求失败（HTTP ' + response.status + '）。',
    details: isRecord(body.details) ? asDetailRecord(body.details) : undefined,
  })
}

async function readTyped<T>(response: Response): Promise<T> {
  return await expectOk(response) as unknown as T
}

function asDetailRecord(value: Record<string, unknown>) {
  const details: Record<string, string | number | null> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' || typeof item === 'number' || item === null) details[key] = item
  }
  return details
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function asSafeInt(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function conflictFromError(error: WorkspaceRequestError): WorkspaceConfirmConflict {
  return {
    code: error.payload.code ?? 'REPORT_SUBMISSION_FAILED',
    error: error.payload.error,
    details: error.payload.details,
  }
}

export async function fetchWorkspaceProjects(signal?: AbortSignal) {
  return fetchAllPages<WorkspaceProjectListItem>(WORKSPACE_API.projects, 'projects', { cache: 'no-store', signal })
}

export async function fetchWorkspaceReports(signal?: AbortSignal) {
  return fetchAllPages<WorkspaceReportCard>(WORKSPACE_API.reports, 'reports', { cache: 'no-store', signal })
}

export async function fetchWorkspaceProject(projectId: string, signal?: AbortSignal, selection?: { stageId?: string; reportId?: string }) {
  const path = workspacePath(WORKSPACE_API.project, { projectId })
  const url = new URL(path, typeof window === 'undefined' ? 'http://workspace.local' : window.location.origin)
  if (selection?.stageId) url.searchParams.set('stageId', selection.stageId)
  if (selection?.reportId) url.searchParams.set('reportId', selection.reportId)
  const response = await apiFetch(url.pathname + url.search, { cache: 'no-store', signal })
  return readTyped<WorkspaceProjectDetail>(response)
}

export async function createWorkspaceProject(project: StageProjectCreate) {
  const response = await apiFetch(WORKSPACE_API.projects, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(project),
  })
  return readTyped<WorkspaceProjectDetail>(response)
}

export async function editWorkspaceProject(projectId: string, edit: WorkspaceProjectSafeEdit) {
  const response = await apiFetch(workspacePath(WORKSPACE_API.project, { projectId }), {
    method: 'PATCH',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(edit),
  })
  return expectOk(response)
}

export async function editWorkspaceStages(projectId: string, edit: StagePlanEdit) {
  const response = await apiFetch(workspacePath(WORKSPACE_API.stages, { projectId }), {
    method: 'PATCH',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(edit),
  })
  return expectOk(response)
}

export async function prepareWorkspaceUpload(input: { projectId: string; file: File; signal?: AbortSignal }) {
  const response = await apiFetch(workspacePath(WORKSPACE_API.reportUploads, { projectId: input.projectId }) + '?fileName=' + encodeURIComponent(input.file.name), {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': input.file.type || 'application/octet-stream' }),
    body: input.file,
    signal: input.signal,
  })
  return readTyped<WorkspaceUploadStatus>(response)
}

export async function readWorkspaceUpload(projectId: string, uploadId: string, signal?: AbortSignal) {
  const response = await apiFetch(workspacePath(WORKSPACE_API.reportUpload, { projectId, uploadId }), { cache: 'no-store', signal })
  return readTyped<WorkspaceUploadStatus>(response)
}

export async function confirmWorkspaceSubmission(input: {
  projectId: string
  command: ReportSubmissionCommand
  idempotencyKey: string
}) {
  const response = await apiFetch(workspacePath(WORKSPACE_API.projectReports, { projectId: input.projectId }), {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey }),
    body: JSON.stringify(input.command),
  })
  return readTyped<WorkspaceConfirmResponse>(response)
}

export async function fetchWorkspaceReport(reportId: string, signal?: AbortSignal) {
  const response = await apiFetch(workspacePath(WORKSPACE_API.report, { reportId }), { cache: 'no-store', signal })
  return readTyped<WorkspaceReportDetail>(response)
}

export async function deleteWorkspaceReport(reportId: string, reason: string) {
  const response = await apiFetch(workspacePath(WORKSPACE_API.report, { reportId }), {
    method: 'DELETE',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ reason }),
  })
  return expectOk(response)
}

export async function startWorkspaceTask(path: string) {
  const response = await apiFetch(path, { method: 'POST', headers: mutationHeaders() })
  const body = await expectOk(response)
  return body as unknown as WorkspaceTaskResponse
}

export async function cancelWorkspaceTask(jobId: string) {
  const response = await apiFetch(workspacePath(WORKSPACE_API.jobCancel, { jobId }), { method: 'POST', headers: mutationHeaders() })
  const body = await expectOk(response) as unknown as WorkspaceTaskResponse
  if (!body.job) throw new WorkspaceRequestError({ status: 503, error: '任务响应缺少 job。', code: 'TASK_RESPONSE_INVALID' })
  return body.job
}

export async function fetchWorkspaceOverview(signal?: AbortSignal) {
  const response = await apiFetch(WORKSPACE_API.overview, { cache: 'no-store', signal })
  const body = await expectOk(response)
  const stats = parseOverviewStats(body.stats ?? body)
  return {
    stats,
    recentReports: Array.isArray(body.recentReports) ? body.recentReports : [],
    activityReports: Array.isArray(body.activityReports) ? body.activityReports : [],
    recentKnowledge: Array.isArray(body.recentKnowledge) ? body.recentKnowledge as KnowledgeItem[] : [],
  } as WorkspaceOverview
}

export function parseOverviewStats(value: unknown): WorkspaceOverviewStats {
  const fallback = emptyOverviewStats()
  if (!isRecord(value)) return fallback
  const jobStats = isRecord(value.jobStats) ? value.jobStats : {}
  const trends = isRecord(value.trends) ? value.trends : {}
  return {
    submittedReportCount: asSafeInt(value.submittedReportCount) ?? 0,
    completedStageCount: asSafeInt(value.completedStageCount) ?? 0,
    totalCharacters: asSafeInt(value.totalCharacters) ?? 0,
    knowledgeCount: asSafeInt(value.knowledgeCount) ?? 0,
    knowledgeCategoryCount: asSafeInt(value.knowledgeCategoryCount) ?? 0,
    weeklyNewReports: asSafeInt(value.weeklyNewReports) ?? 0,
    weeklyNewKnowledge: asSafeInt(value.weeklyNewKnowledge) ?? 0,
    jobStats: {
      completed: asSafeInt(jobStats.completed) ?? 0,
      failed: asSafeInt(jobStats.failed) ?? 0,
      cancelled: asSafeInt(jobStats.cancelled) ?? 0,
      running: asSafeInt(jobStats.running) ?? 0,
      queued: asSafeInt(jobStats.queued) ?? 0,
    },
    trends: {
      submissions: numberSeries(trends.submissions),
      characters: numberSeries(trends.characters),
      successRate: numberSeries(trends.successRate),
      knowledge: numberSeries(trends.knowledge),
      averageScore: numberSeries(trends.averageScore),
      analyzedProjects: numberSeries(trends.analyzedProjects),
    },
  }
}

function numberSeries(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item)) : []
}

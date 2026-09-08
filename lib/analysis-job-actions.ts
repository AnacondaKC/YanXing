import { apiFetch, mutationHeaders } from '@/lib/client-request'
import type { AnalysisJob } from '@/modules/analysis/domain'
import type { AnalysisModuleState } from '@/modules/contracts/analysis'
import type { ReportVersion } from '@/modules/reports/domain'

export type AnalysisJobMutationBody = { error?: string; code?: string; job?: AnalysisJob; moduleStates?: AnalysisModuleState[] }
export type AnalysisJobMutationResult = { ok: boolean; body: AnalysisJobMutationBody }
export type StartAnalysisGate = { type: 'block' } | { type: 'assign-stage'; report: ReportVersion } | { type: 'proceed'; reportId: string }

export function startAnalysisPath(reportId: string) { return '/api/reports/' + reportId + '/analyze' }
export function cancelAnalysisPath(jobId: string) { return '/api/jobs/' + jobId + '/cancel' }

export function startAnalysisGate({ canManage, reportId, report, activeJobId, starting, stageConfirmed }: { canManage: boolean; reportId?: string; report?: ReportVersion; activeJobId?: string; starting: boolean; stageConfirmed: boolean }): StartAnalysisGate {
  if (!canManage || !reportId || activeJobId || starting) return { type: 'block' }
  if (!stageConfirmed && report && !report.milestoneId) return { type: 'assign-stage', report }
  return { type: 'proceed', reportId }
}

export function startAnalysisFailureAction(body: Pick<AnalysisJobMutationBody, 'code'>, report?: ReportVersion) {
  if ((body.code === 'REPORT_STAGE_REQUIRED' || body.code === 'REPORT_STAGE_NOT_FOUND') && report) return 'assign-stage' as const
  if (body.code === 'PROJECT_CONTEXT_INCOMPLETE') return 'edit-project' as const
  return 'notice' as const
}

export async function postAnalysisJob(url: string): Promise<AnalysisJobMutationResult> {
  const response = await apiFetch(url, { method: 'POST', headers: mutationHeaders() }).catch(() => null)
  const body = await response?.json().catch(() => null) as AnalysisJobMutationBody | null
  return { ok: Boolean(response?.ok && body?.job), body: body ?? {} }
}

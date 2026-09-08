import type { ReportVersion } from '@/modules/reports/domain'

export type ReportLoadState = 'loading' | 'ready' | 'error'

export interface ReportListResult {
  projectId: string
  reloadKey: number
  status: 'ready' | 'error'
}

export function reportLoadState({ projectId, reloadKey, report, result }: {
  projectId: string
  reloadKey: number
  report?: Pick<ReportVersion, 'projectId'>
  result?: ReportListResult
}): ReportLoadState {
  if (report?.projectId === projectId) return 'ready'
  if (result?.projectId !== projectId || result.reloadKey !== reloadKey) return 'loading'
  return result.status
}

import type { ReportVersion } from '@/modules/reports/domain'

export function selectActiveReportAfterDeletion(
  reports: ReportVersion[],
  previousActiveReportId: string | undefined,
  deletedReportId: string,
  fetchedActiveReport?: ReportVersion,
  previousActiveReport?: ReportVersion,
) {
  const latest = reports[0]
  if (previousActiveReportId === deletedReportId) return { latest, active: latest }
  const active = fetchedActiveReport?.id === previousActiveReportId
    ? fetchedActiveReport
    : previousActiveReport?.id === previousActiveReportId
      ? previousActiveReport
      : latest
  return { latest, active }
}

export function toggleHiddenProjectId(hiddenIds: readonly string[], projectId: string) {
  return hiddenIds.includes(projectId)
    ? hiddenIds.filter((id) => id !== projectId)
    : [...hiddenIds, projectId]
}

export function parseHiddenProjectIds(raw: string | null) {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
  } catch {
    return []
  }
}

import type { Milestone } from '@/modules/projects/domain'
import type { ReportVersion } from '@/modules/reports/domain'

export function getReportStageLabel(
  report: Pick<ReportVersion, 'milestoneId'>,
  milestones: readonly Pick<Milestone, 'id' | 'title'>[] = [],
): string {
  if (!report.milestoneId) return '未分配'
  const milestone = milestones.find((milestone) => milestone.id === report.milestoneId)
  return milestone?.title.trim() || '未分配'
}

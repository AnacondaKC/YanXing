import type { Milestone } from '@/modules/projects/domain'
import type { ReportVersion } from '@/modules/reports/domain'

function milestoneIndexMap(milestones: Milestone[]) {
  return new Map(milestones.map((milestone, index) => [milestone.id, index]))
}

export function latestReportedMilestoneIndex(milestones: Milestone[], reports: ReportVersion[]) {
  const indexes = milestoneIndexMap(milestones)
  return reports.reduce((latestIndex, report) => {
    const index = report.milestoneId ? indexes.get(report.milestoneId) : undefined
    return index === undefined ? latestIndex : Math.max(latestIndex, index)
  }, -1)
}

export function canDeleteReportFromHistory(report: ReportVersion, milestones: Milestone[], reports: ReportVersion[]) {
  const reportIndex = report.milestoneId
    ? milestones.findIndex((milestone) => milestone.id === report.milestoneId)
    : -1
  if (milestones.length === 0) return reports.length === 1 && report.milestoneId === undefined
  return reportIndex >= 0 && reportIndex === latestReportedMilestoneIndex(milestones, reports)
}

export function canReplaceReportFromHistory(report: ReportVersion, milestones: Milestone[], reports: ReportVersion[]) {
  const reportIndex = report.milestoneId
    ? milestones.findIndex((milestone) => milestone.id === report.milestoneId)
    : -1
  return reportIndex >= 0
    && reportIndex < latestReportedMilestoneIndex(milestones, reports)
    && milestones[reportIndex]?.status === 'completed'
}

import type { Milestone } from '@/modules/projects/domain'
import { PROJECT_FIELD_LIMITS } from '@/modules/projects/validation'
import type { ReportDeliveryType } from '@/modules/reports/domain'

export function resolveDeliveryMilestoneId(
  milestones: Milestone[],
  milestoneId: string,
  deliveryType: ReportDeliveryType,
) {
  const targetId = deliveryType === 'final' ? milestones.at(-1)?.id : milestoneId
  if (!targetId || !milestones.some((milestone) => milestone.id === targetId)) {
    throw new Error('所选研究阶段不存在。')
  }
  return targetId
}

/** 上传或关联报告后，由服务端推进阶段状态，避免前端用过期课题快照覆盖。 */
export function applyReportDeliveryToMilestones(
  milestones: Milestone[],
  reportId: string,
  milestoneId: string,
  deliveryType: ReportDeliveryType,
) {
  const targetMilestoneId = resolveDeliveryMilestoneId(milestones, milestoneId, deliveryType)
  const targetIndex = milestones.findIndex((milestone) => milestone.id === targetMilestoneId)
  const originalReportIndex = milestones.findIndex((milestone) => (milestone.reportIds ?? []).includes(reportId))
  const targetReportIds = milestones[targetIndex]?.reportIds ?? []
  if (!targetReportIds.includes(reportId) && targetReportIds.length >= PROJECT_FIELD_LIMITS.milestoneReports) {
    throw new Error(`单个阶段最多关联 ${PROJECT_FIELD_LIMITS.milestoneReports} 份报告。`)
  }
  if (deliveryType === 'stage') {
    const blockingMilestone = milestones.slice(0, targetIndex).find((milestone) => milestone.status !== 'completed')
    if (blockingMilestone) throw new Error(`请先完成阶段「${blockingMilestone.title}」。`)
  }
  const next = milestones.map((milestone) => {
    const reportIds = (milestone.reportIds ?? []).filter((id) => id !== reportId)
    const isTarget = milestone.id === targetMilestoneId
    if (deliveryType === 'final') {
      return {
        ...milestone,
        status: 'completed' as const,
        reportIds: isTarget ? [reportId, ...reportIds] : reportIds,
      }
    }
    if (isTarget) {
      return {
        ...milestone,
        status: 'completed' as const,
        reportIds: [reportId, ...reportIds],
      }
    }
    return { ...milestone, reportIds }
  })

  if (
    deliveryType === 'stage'
    && originalReportIndex >= 0
    && originalReportIndex < targetIndex
    && milestones[originalReportIndex]?.status === 'completed'
    && (next[originalReportIndex]?.reportIds ?? []).length === 0
  ) {
    throw new Error('不能将已完成阶段的唯一交付报告移至后续阶段。')
  }

  if (deliveryType === 'stage') {
    const following = next[targetIndex + 1]
    if (following?.status === 'not_started') {
      next[targetIndex + 1] = { ...following, status: 'in_progress' }
    }
    if (originalReportIndex > targetIndex) {
      let openedNextStage = false
      for (let index = targetIndex + 1; index < next.length; index += 1) {
        const milestone = next[index]
        if (!openedNextStage && (milestone.reportIds ?? []).length > 0) {
          next[index] = { ...milestone, status: 'completed' }
        } else if (!openedNextStage) {
          next[index] = { ...milestone, status: 'in_progress' }
          openedNextStage = true
        } else {
          next[index] = { ...milestone, status: 'not_started' }
        }
      }
    }
  }

  return { milestones: next, targetMilestoneId }
}

export type ReportDeliveryReference = {
  milestoneId?: string | null
  deliveryType?: ReportDeliveryType | null
}

/** 调整或删除后只要仍有终稿，全部阶段保持完成。 */
export function completeMilestonesWhenFinalRemains(
  milestones: Milestone[],
  reports: ReportDeliveryReference[],
): Milestone[] {
  if (!reports.some((report) => report.deliveryType === 'final')) return milestones
  return milestones.map((milestone) => ({ ...milestone, status: 'completed' as const }))
}

/** 删除报告后从数据库中的剩余交付记录重建阶段状态，避免保留过期完成标记。 */
export function reconcileMilestonesAfterReportDeletion(
  milestones: Milestone[],
  reports: ReportDeliveryReference[],
): Milestone[] {
  if (!milestones.length) return []
  const completedMilestoneIds = new Set(
    reports
      .filter((report) => report.deliveryType === 'stage' && typeof report.milestoneId === 'string')
      .map((report) => report.milestoneId as string),
  )
  if (reports.some((report) => report.deliveryType === 'final')) {
    return completeMilestonesWhenFinalRemains(milestones, reports)
  }

  const hasRemainingReports = reports.length > 0
  let foundIncomplete = false
  return milestones.map((milestone) => {
    if (!foundIncomplete && completedMilestoneIds.has(milestone.id)) {
      return { ...milestone, status: 'completed' as const }
    }
    if (!foundIncomplete) {
      foundIncomplete = true
      return { ...milestone, status: hasRemainingReports ? 'in_progress' as const : 'not_started' as const }
    }
    return { ...milestone, status: 'not_started' as const }
  })
}


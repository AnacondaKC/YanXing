import type { ReportEvaluationContext } from '@/modules/contracts/analysis'
export function parseReportEvaluationContext(value: unknown): ReportEvaluationContext | undefined {
  let candidate: unknown = value
  if (typeof candidate === 'string') {
    try { candidate = JSON.parse(candidate) } catch { return undefined }
  }
  if (!isRecord(candidate)) return undefined
  const milestone = candidate.milestone
  if (!isNonBlankString(candidate.projectId)
    || !isNonBlankString(candidate.projectTitle)
    || !isNonBlankString(candidate.researchObjective)
    || !isNonBlankString(candidate.researchBackground)
    || !isRecord(milestone)
    || !isNonBlankString(milestone.id)
    || !isNonBlankString(milestone.title)
    || !isNonBlankString(milestone.targetDate)
    || !isNonBlankString(milestone.workAndExpectedOutcomes)) return undefined
  return {
    projectId: candidate.projectId,
    projectTitle: candidate.projectTitle,
    researchObjective: candidate.researchObjective,
    researchBackground: candidate.researchBackground,
    milestone: {
      id: milestone.id,
      title: milestone.title,
      targetDate: milestone.targetDate,
      workAndExpectedOutcomes: milestone.workAndExpectedOutcomes,
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

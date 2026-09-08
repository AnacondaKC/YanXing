import type { ReportEvaluationContext } from '@/modules/contracts/analysis'
import type { Project } from '@/modules/projects/domain'
import type { ReportVersion } from '@/modules/reports/domain'

export type EvaluationContextIssueCode =
  | 'REPORT_STAGE_REQUIRED'
  | 'REPORT_STAGE_NOT_FOUND'
  | 'PROJECT_CONTEXT_INCOMPLETE'

export type EvaluationContextResolution =
  | { context: ReportEvaluationContext; issue?: never }
  | { context?: never; issue: { code: EvaluationContextIssueCode; message: string } }

export function resolveReportEvaluationContext(
  project: Project | undefined,
  report: ReportVersion | undefined,
): EvaluationContextResolution {
  if (!project || !report || project.id !== report.projectId) {
    return { issue: { code: 'PROJECT_CONTEXT_INCOMPLETE', message: '报告所属课题不存在，无法启动 AI 分析。' } }
  }

  if (!report.milestoneId) {
    return { issue: { code: 'REPORT_STAGE_REQUIRED', message: '请先为该报告选择所属研究阶段。' } }
  }

  const milestone = project.milestones.find((item) => item.id === report.milestoneId)
  if (!milestone) {
    return { issue: { code: 'REPORT_STAGE_NOT_FOUND', message: '报告所属研究阶段已不存在，请重新选择阶段。' } }
  }

  const researchObjective = project.objective.trim()
  const researchBackground = project.description.trim()
  const milestoneTitle = milestone.title.trim()
  const targetDate = milestone.targetDate?.trim() ?? ''
  const workAndExpectedOutcomes = milestone.description?.trim() ?? ''
  if (!researchObjective || !researchBackground || !milestoneTitle || !targetDate || !workAndExpectedOutcomes) {
    return {
      issue: {
        code: 'PROJECT_CONTEXT_INCOMPLETE',
        message: '请先补齐研究目标与核心问题、研究背景与说明，以及所属阶段的名称、日期和工作内容与预期成果。',
      },
    }
  }

  return {
    context: {
      projectId: project.id,
      projectTitle: project.title.trim(),
      researchObjective,
      researchBackground,
      milestone: {
        id: milestone.id,
        title: milestoneTitle,
        targetDate,
        workAndExpectedOutcomes,
      },
    },
  }
}

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

export function evaluationContextsEqual(
  left: ReportEvaluationContext | undefined,
  right: ReportEvaluationContext | undefined,
) {
  const parsedLeft = parseReportEvaluationContext(left)
  const parsedRight = parseReportEvaluationContext(right)
  if (!parsedLeft || !parsedRight) return false
  return parsedLeft.projectId === parsedRight.projectId
    && parsedLeft.projectTitle === parsedRight.projectTitle
    && parsedLeft.researchObjective === parsedRight.researchObjective
    && parsedLeft.researchBackground === parsedRight.researchBackground
    && parsedLeft.milestone.id === parsedRight.milestone.id
    && parsedLeft.milestone.title === parsedRight.milestone.title
    && parsedLeft.milestone.targetDate === parsedRight.milestone.targetDate
    && parsedLeft.milestone.workAndExpectedOutcomes === parsedRight.milestone.workAndExpectedOutcomes
}

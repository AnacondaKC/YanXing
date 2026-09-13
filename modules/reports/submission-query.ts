import type { ReportSubmission, SubmissionIdentity } from '@/modules/reports/submission-domain'

export function selectLatestSubmission<T extends SubmissionIdentity>(reports: readonly T[], projectId: string): T | undefined {
  return reports.reduce<T | undefined>((latest, report) => {
    if (report.projectId !== projectId || report.deletedAt) return latest
    return !latest || report.submissionSequence > latest.submissionSequence ? report : latest
  }, undefined)
}

export interface ComparisonSubmission extends SubmissionIdentity {
  readonly wasFirstStageSubmission: boolean
  readonly characterCount: number
  readonly aiScore?: number
  readonly analysisId?: string
}

export type SubmissionComparison =
  | { status: 'unavailable'; reason: 'report_deleted' | 'first_stage_submission' | 'no_predecessor' }
  | { status: 'available'; baselineReportId: string; baselineStageId: string; baselineStageVersion: number;
      characterDelta: number; scoreDelta?: number; baselineAnalysisId?: string; currentAnalysisId?: string }

export function resolveSubmissionComparison(input: {
  report: ComparisonSubmission
  submissions: readonly ComparisonSubmission[]
}): SubmissionComparison {
  const { report, submissions } = input
  if (report.deletedAt) return { status: 'unavailable', reason: 'report_deleted' }
  if (report.wasFirstStageSubmission) return { status: 'unavailable', reason: 'first_stage_submission' }
  const predecessors = submissions.filter((candidate) => candidate.id !== report.id && candidate.submissionSequence < report.submissionSequence)
  const baseline = selectLatestSubmission(predecessors, report.projectId)
  if (!baseline) return { status: 'unavailable', reason: 'no_predecessor' }
  const hasScores = [report.aiScore, baseline.aiScore].every((score) => typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 100)
  return {
    status: 'available', baselineReportId: baseline.id, baselineStageId: baseline.stageId,
    baselineStageVersion: baseline.stageVersion, characterDelta: report.characterCount - baseline.characterCount,
    scoreDelta: hasScores ? report.aiScore! - baseline.aiScore! : undefined,
    baselineAnalysisId: baseline.analysisId, currentAnalysisId: report.analysisId,
  }
}

export function getSubmissionDisplayLabels(input: {
  stage: { id: string; projectId: string; ordinal: number; title: string; currentCompletionReportId?: string }
  report: Pick<ReportSubmission, 'id' | 'projectId' | 'stageId' | 'stageVersion' | 'submittedAs'>
}) {
  const { stage, report } = input
  if (report.stageId !== stage.id || report.projectId !== stage.projectId) throw new Error('报告与阶段归属不一致。')
  if (!Number.isSafeInteger(stage.ordinal) || stage.ordinal < 1 || !Number.isSafeInteger(report.stageVersion) || report.stageVersion < 1) {
    throw new Error('阶段位置和报告版本必须为正安全整数。')
  }
  const positionLabel = '阶段' + String(stage.ordinal).padStart(2, '0')
  const stageName = stage.title.trim() || positionLabel
  const versionLabel = 'V' + report.stageVersion
  const isCurrentCompletion = stage.currentCompletionReportId === report.id
  return {
    stageLabel: stageName === positionLabel ? positionLabel : positionLabel + ' · ' + stageName,
    reportLabel: stageName + ' ' + versionLabel,
    compactLabel: positionLabel + ' ' + versionLabel,
    roleLabel: isCurrentCompletion ? '阶段完结报告' : '阶段更新报告',
    completionLabel: isCurrentCompletion ? stageName + '完结报告' : undefined,
  }
}

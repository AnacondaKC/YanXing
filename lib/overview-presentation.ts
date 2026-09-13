import { hasCompletedFullAnalysis, type WorkspaceOverviewStats, type WorkspaceProjectListItem, type WorkspaceReportCard } from '@/lib/workspace-submission'

export type QualityBand = 'excellent' | 'good' | 'weak' | 'unanalyzed'
export type ProjectActivityKind = 'analyzing' | 'analyzed' | 'failed' | 'upload' | 'edit' | 'created'

export type ProjectActivity = {
  id: string
  project: WorkspaceProjectListItem
  report?: WorkspaceReportCard
  kind: ProjectActivityKind
  at: string
  label: string
  detail: string
}

export type OverviewSubtitleInput = {
  runningJobs: number
  queuedJobs: number
  atRiskCount: number
  activeProjectsCount: number
  submittedReportCount: number
  weeklyNewReports: number
  averageAiScore?: number
  hasProjects: boolean
  hasReports: boolean
}

export type RepositoryProjectGroup = {
  projectId: string
  projectTitle: string
  reports: WorkspaceReportCard[]
}

const QUALITY_EXCELLENT_MIN = 80
const QUALITY_GOOD_MIN = 60
const ACTIVITY_TIMESTAMP_NEAR_MS = 2500
const REPORT_PROCESSING_REASON = 'REPORT_PROCESSING'
const WEEK_MS = 7 * 24 * 3600 * 1000

export function qualityBandOf(score: number | undefined): QualityBand {
  if (score === undefined) return 'unanalyzed'
  if (score >= QUALITY_EXCELLENT_MIN) return 'excellent'
  if (score >= QUALITY_GOOD_MIN) return 'good'
  return 'weak'
}

export function isDefinedScore(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function meanOfDefinedScores(values: Array<number | undefined>) {
  const defined = values.filter(isDefinedScore)
  if (!defined.length) return undefined
  return defined.reduce((sum, value) => sum + value, 0) / defined.length
}

export function averageDefinedInteger(values: Array<number | undefined>) {
  const mean = meanOfDefinedScores(values)
  return mean === undefined ? undefined : Math.round(mean)
}

export function averageDefinedTenth(values: Array<number | undefined>) {
  const mean = meanOfDefinedScores(values)
  return mean === undefined ? undefined : Math.round(mean * 10) / 10
}

export function isActiveProject(project: Pick<WorkspaceProjectListItem, 'currentStage'>) {
  return project.currentStage?.lifecycleStatus !== 'completed'
}

export function isQualityRiskProject(project: Pick<WorkspaceProjectListItem, 'latestSubmission'>) {
  return qualityBandOf(project.latestSubmission?.aiScore) === 'weak'
}

export function reportStageLabel(report: Pick<WorkspaceReportCard, 'labels'>) {
  return report.labels.stageLabel
}

export function reportCompactLabel(report: Pick<WorkspaceReportCard, 'labels'>) {
  return report.labels.compactLabel
}

export function projectLatestLabel(project: Pick<WorkspaceProjectListItem, 'latestSubmission'>) {
  return project.latestSubmission ? reportCompactLabel(project.latestSubmission) : undefined
}

export function submittedReportCountOf(stats: WorkspaceOverviewStats | undefined, fallback = 0) {
  return stats?.submittedReportCount ?? fallback
}

export function submissionTrendOf(stats: WorkspaceOverviewStats | undefined) {
  return stats?.trends.submissions ?? []
}

export function compareReportsBySequence(left: Pick<WorkspaceReportCard, 'submissionSequence' | 'submittedAt'>, right: Pick<WorkspaceReportCard, 'submissionSequence' | 'submittedAt'>) {
  return right.submissionSequence - left.submissionSequence || right.submittedAt.localeCompare(left.submittedAt)
}

export function isReportAnalyzing(report: Pick<WorkspaceReportCard, 'capabilities'>) {
  return report.capabilities.canCancelAnalysisJob
    || report.capabilities.canCancelInsightJob
    || report.capabilities.disabledReasons.includes(REPORT_PROCESSING_REASON)
}

export function timestampsNear(left: string, right: string, ms = ACTIVITY_TIMESTAMP_NEAR_MS) {
  const a = new Date(left).getTime()
  const b = new Date(right).getTime()
  if (Number.isNaN(a) || Number.isNaN(b)) return false
  return Math.abs(a - b) <= ms
}

export function reportsForProjectActivity(project: WorkspaceProjectListItem, activityReports: WorkspaceReportCard[]) {
  const reports = activityReports.filter((report) => report.projectId === project.id)
  if (project.latestSubmission && !reports.some((report) => report.id === project.latestSubmission?.id)) {
    reports.push(project.latestSubmission)
  }
  reports.sort(compareReportsBySequence)
  return reports
}

export function latestProjectActivity(project: WorkspaceProjectListItem, projectReports: WorkspaceReportCard[]): ProjectActivity {
  const latestReport = projectReports[0] ?? project.latestSubmission
  const analyzingReport = projectReports.find(isReportAnalyzing)
  const looksLikeUpload = projectReports.some((report) => timestampsNear(project.updatedAt, report.submittedAt))
  const isFreshCreate = timestampsNear(project.updatedAt, project.createdAt)

  if (analyzingReport) {
    return {
      id: project.id,
      project,
      report: analyzingReport,
      kind: 'analyzing',
      at: analyzingReport.submittedAt,
      label: '正在分析',
      detail: reportCompactLabel(analyzingReport),
    }
  }

  let activity: ProjectActivity
  if (latestReport?.capabilities.analysisAction === 'retry') {
    activity = {
      id: project.id,
      project,
      report: latestReport,
      kind: 'failed',
      at: latestReport.submittedAt,
      label: '分析失败',
      detail: reportCompactLabel(latestReport),
    }
  } else if (latestReport && (isDefinedScore(latestReport.aiScore) || hasCompletedFullAnalysis(latestReport))) {
    activity = {
      id: project.id,
      project,
      report: latestReport,
      kind: 'analyzed',
      at: latestReport.submittedAt,
      label: '完成分析',
      detail: isDefinedScore(latestReport.aiScore) ? latestReport.aiScore + ' 分' : reportCompactLabel(latestReport),
    }
  } else if (latestReport) {
    activity = {
      id: project.id,
      project,
      report: latestReport,
      kind: 'upload',
      at: latestReport.submittedAt,
      label: '上传报告',
      detail: reportCompactLabel(latestReport),
    }
  } else if (!isFreshCreate) {
    activity = { id: project.id, project, kind: 'edit', at: project.updatedAt, label: '更新课题', detail: '课题信息已修改' }
  } else {
    activity = { id: project.id, project, kind: 'created', at: project.createdAt, label: '新设立课题', detail: '等待上传报告' }
  }

  if (activity.kind !== 'analyzing' && !isFreshCreate && !looksLikeUpload && project.updatedAt > activity.at) {
    return { id: project.id, project, kind: 'edit', at: project.updatedAt, label: '更新课题', detail: '课题信息已修改' }
  }
  return activity
}

export function recentProjectActivities(projects: WorkspaceProjectListItem[], activityReports: WorkspaceReportCard[], limit = 4) {
  return projects.reduce<ProjectActivity[]>((recent, project) => {
    const activity = latestProjectActivity(project, reportsForProjectActivity(project, activityReports))
    const insertAt = recent.findIndex((item) => item.at < activity.at)
    if (insertAt < 0 && recent.length >= limit) return recent
    recent.splice(insertAt < 0 ? recent.length : insertAt, 0, activity)
    if (recent.length > limit) recent.pop()
    return recent
  }, [])
}

export function greetingOf(date: Date) {
  const hour = date.getHours()
  if (hour < 5) return '夜深了'
  if (hour < 9) return '早上好'
  if (hour < 12) return '上午好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

export function dynamicOverviewSubtitle(input: OverviewSubtitleInput) {
  if (!input.hasProjects) {
    return '当前暂无在研课题，建议创建新课题以开启全流程分析与报告追踪。'
  }
  if (!input.hasReports) {
    return '已纳管 ' + input.activeProjectsCount + ' 个在研课题，上传首份报告即可自动触发全维度 AI 深度分析。'
  }
  const pendingJobs = input.runningJobs + input.queuedJobs
  if (pendingJobs > 0) {
    return '当前有 ' + pendingJobs + ' 个分析任务正在处理中，分析结果与质量评分将实时同步。'
  }
  if (input.atRiskCount > 0) {
    return '共有 ' + input.activeProjectsCount + ' 个在研课题，其中 ' + input.atRiskCount + ' 个课题评分偏低或存在风险，建议优先查阅。'
  }
  if (input.weeklyNewReports > 0) {
    const scoreText = isDefinedScore(input.averageAiScore) ? input.averageAiScore + ' 分' : '--'
    return '近 7 天已更新 ' + input.weeklyNewReports + ' 版报告，平均 AI 分析得分为 ' + scoreText + '，研究进展活跃。'
  }
  if (isDefinedScore(input.averageAiScore) && input.averageAiScore >= QUALITY_EXCELLENT_MIN) {
    return '在研课题整体质量表现优秀（平均 ' + input.averageAiScore + ' 分），持续为研究决策提供高质量支撑。'
  }
  return '全库纳管 ' + input.activeProjectsCount + ' 个在研课题与 ' + input.submittedReportCount + ' 版研报，AI 深度分析与质量全景保持最新。'
}

export function countSince(timestamps: string[], now = Date.now(), windowMs = WEEK_MS) {
  const start = now - windowMs
  return timestamps.filter((value) => {
    const time = new Date(value).getTime()
    return !Number.isNaN(time) && time >= start
  }).length
}

export function reportMatchesLibraryQuery(input: {
  report: WorkspaceReportCard
  search: string
  projectFilter: string
  projectTitle: string
}) {
  const needle = input.search.trim().toLowerCase()
  const haystacks = [input.report.title, input.report.fileName, input.projectTitle]
  const matchesSearch = !needle || haystacks.some((value) => value.toLowerCase().includes(needle))
  if (!matchesSearch) return false
  return input.projectFilter === 'all' || input.report.projectId === input.projectFilter
}

export function groupReportsByProject(input: {
  reports: WorkspaceReportCard[]
  projects: WorkspaceProjectListItem[]
}): RepositoryProjectGroup[] {
  const titleById = new Map(input.projects.map((project) => [project.id, project.title]))
  const groups = new Map<string, RepositoryProjectGroup>()
  for (const report of input.reports) {
    const existing = groups.get(report.projectId)
    if (existing) existing.reports.push(report)
    else groups.set(report.projectId, {
      projectId: report.projectId,
      projectTitle: report.projectTitle ?? titleById.get(report.projectId) ?? '课题',
      reports: [report],
    })
  }
  for (const group of groups.values()) group.reports.sort(compareReportsBySequence)
  const ordered: RepositoryProjectGroup[] = []
  for (const project of input.projects) {
    const group = groups.get(project.id)
    if (!group) continue
    ordered.push(group)
    groups.delete(project.id)
  }
  ordered.push(...groups.values())
  return ordered
}

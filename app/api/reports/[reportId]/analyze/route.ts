import { NextResponse } from 'next/server'
import { PromptBudgetError } from '@/lib/ai/prompt-budget'
import { getLatestJobForReport, getProject, getReport, ReportAuthorizationChangedError, ReportEvaluationContextChangedError, startReportAnalysis, userCanManageProject } from '@/lib/db/repository'
import { resolveReportEvaluationContext } from '@/modules/analysis/evaluation-context'
import { recordActivity } from '@/lib/notifications'
import { notificationActions } from '@/modules/notifications/domain'
import { getRequestUser } from '@/lib/auth/request'
import { logUnexpectedError, publicErrorMessage } from '@/lib/http/public-error'
import { AiBudgetError, aiBudgetHttpFailure } from '@/lib/ai/budget'

export const runtime = 'nodejs'

export async function POST(
  request: Request,
  context: { params: Promise<{ reportId: string }> },
) {
  const { reportId } = await context.params
  const user = getRequestUser(request)
  if (!user) return NextResponse.json({ error: '未登录。' }, { status: 401 })
  const report = getReport(reportId)
  if (!report) {
    return NextResponse.json({ error: '报告版本不存在。' }, { status: 404 })
  }
  if (!userCanManageProject(report.projectId, user)) {
    return NextResponse.json({ error: '只有课题负责人或编辑可以启动分析任务。' }, { status: 403 })
  }
  const contextResolution = resolveReportEvaluationContext(getProject(report.projectId), report)
  if (contextResolution.issue) {
    return NextResponse.json({ error: contextResolution.issue.message, code: contextResolution.issue.code }, { status: 409 })
  }

  const previousJob = getLatestJobForReport(reportId)
  try {
    const result = startReportAnalysis(reportId, user)
    if (!result) return NextResponse.json({ error: '报告不存在或无法启动分析。' }, { status: 404 })
    if (!previousJob || previousJob.id !== result.job.id) {
      const project = getProject(report.projectId)
      recordActivity({
        action: notificationActions.analysisStarted,
        actor: user,
        projectId: report.projectId,
        projectTitle: project?.title,
        reportId: report.id,
        reportTitle: report.title,
        summary: '开始分析报告「' + report.title + '」',
        detail: user.displayName + ' 启动了课题「' + (project?.title ?? '未知课题') + '」中报告「' + report.title + '」的分析任务。',
      })
    }
    return NextResponse.json(result, { status: 202 })
  } catch (error) {
    if (error instanceof PromptBudgetError) {
      return NextResponse.json({ error: error.message, code: error.code, requiredCharacters: error.requiredCharacters, maxContextCharacters: error.maxContextCharacters }, { status: 409 })
    }
    if (error instanceof AiBudgetError) {
      const mapped = aiBudgetHttpFailure(error)
      return NextResponse.json(mapped.body, { status: mapped.status, headers: mapped.headers })
    }
    if (error instanceof ReportAuthorizationChangedError) {
      return NextResponse.json({ error: error.message }, { status: 403 })
    }
    if (error instanceof ReportEvaluationContextChangedError) {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
    logUnexpectedError('reports.analyze', error)
    return NextResponse.json({ error: publicErrorMessage(error, '启动分析失败。') }, { status: 500 })
  }
}

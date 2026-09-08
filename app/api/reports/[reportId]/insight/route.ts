import { NextResponse } from 'next/server'
import { getRequestUser } from '@/lib/auth/request'
import {
  createInsightGenerationJob,
  getProject,
  getReport,
  getReportIdentity,
  getLatestInsightJobForReport,
  getReportInsight,
  isReportInsightGenerating,
  ReportAuthorizationChangedError,
  ReportInsightLimitError,
  userCanManageProject,
} from '@/lib/db/repository'
import { AiBudgetError, aiBudgetHttpFailure } from '@/lib/ai/budget'
import { publicErrorMessage } from '@/lib/http/public-error'
import { recordActivity } from '@/lib/notifications'
import { notificationActions } from '@/modules/notifications/domain'
import type { AnalysisJob } from '@/modules/analysis/domain'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type PublicInsightJob = Pick<AnalysisJob, 'id' | 'status' | 'stage' | 'stageIndex' | 'createdAt' | 'updatedAt'> & Partial<Pick<AnalysisJob, 'terminalAt' | 'errorMessage'>>

function toPublicInsightJob(job: AnalysisJob | undefined): PublicInsightJob | undefined {
  if (!job) return undefined
  const fallback = '报告洞察生成失败，请稍后重试。'
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    stageIndex: job.stageIndex,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    terminalAt: job.terminalAt,
    errorMessage: job.errorMessage ? publicErrorMessage(new Error(job.errorMessage), fallback) : undefined,
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ reportId: string }> },
) {
  try {
    const { reportId } = await context.params
    const user = getRequestUser(request)
    if (!user) return NextResponse.json({ error: '未登录。' }, { status: 401 })
    const report = getReportIdentity(reportId)
    if (!report) {
      return NextResponse.json({ error: '报告版本不存在。' }, { status: 404 })
    }
    const insight = getReportInsight(report.id)
    const generating = isReportInsightGenerating(report.id)
    const job = getLatestInsightJobForReport(report.id)
    return NextResponse.json({ insight, generating, job: toPublicInsightJob(job) })
  } catch (error) {
    console.error('[report-insight] 读取失败', error)
    return NextResponse.json({ error: '洞察读取失败，请稍后重试。' }, { status: 500 })
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ reportId: string }> },
) {
  try {
    const { reportId } = await context.params
    const user = getRequestUser(request)
    if (!user) return NextResponse.json({ error: '未登录。' }, { status: 401 })
    const report = getReportIdentity(reportId)
    if (!report) {
      return NextResponse.json({ error: '报告版本不存在。' }, { status: 404 })
    }
    if (!userCanManageProject(report.projectId, user)) {
      return NextResponse.json({ error: '只有课题负责人或编辑可以生成洞察。' }, { status: 403 })
    }

    const job = createInsightGenerationJob(report.id, user)
    const reportDetails = getReport(report.id)
    const project = getProject(report.projectId)
    if (reportDetails) {
      recordActivity({
        action: notificationActions.insightStarted,
        actor: user,
        projectId: report.projectId,
        projectTitle: project?.title,
        reportId: report.id,
        reportTitle: reportDetails.title,
        summary: '生成报告洞察「' + reportDetails.title + '」',
        detail: user.displayName + ' 为课题「' + (project?.title ?? '未知课题') + '」的报告「' + reportDetails.title + '」发起了洞察生成。',
      })
    }
    return NextResponse.json({ job: toPublicInsightJob(job), generating: true }, { status: 202 })
  } catch (error) {
    if (error instanceof AiBudgetError) {
      const mapped = aiBudgetHttpFailure(error)
      return NextResponse.json(mapped.body, { status: mapped.status, headers: mapped.headers })
    }
    if (error instanceof ReportAuthorizationChangedError) {
      return NextResponse.json({ error: error.message }, { status: 403 })
    }
    if (error instanceof ReportInsightLimitError) {
      return NextResponse.json({ error: error.message, code: 'INSIGHT_REGENERATION_LIMIT' }, { status: 409 })
    }
    const message = error instanceof Error ? error.message : '洞察生成暂时不可用，请稍后重试。'
    if (message.includes('洞察正在生成')) {
      return NextResponse.json({ error: message, generating: true, code: 'INSIGHT_GENERATING' }, { status: 409 })
    }
    if (message.includes('报告版本不存在')) {
      return NextResponse.json({ error: message }, { status: 404 })
    }
    if (message.includes('历史报告版本不可执行此操作') || message.includes('没有可用') || message.includes('课题') || message.includes('阶段')) {
      return NextResponse.json({ error: message }, { status: 409 })
    }
    console.error('[insight] 入队失败', error)
    return NextResponse.json({ error: '洞察生成暂时不可用，请稍后重试。' }, { status: 502 })
  }
}

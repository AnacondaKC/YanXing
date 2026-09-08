import { NextResponse } from 'next/server'
import { cancelJob, getJob, getProject, getReport, ReportAuthorizationChangedError, userCanManageJob } from '@/lib/db/repository'
import { getRequestUser } from '@/lib/auth/request'
import { recordActivity } from '@/lib/notifications'
import { notificationActions } from '@/modules/notifications/domain'
import { terminalAnalysisJobStatuses } from '@/lib/analysis-job-progress'

export const runtime = 'nodejs'

export async function POST(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params
  const user = getRequestUser(_request)
  if (!user) return NextResponse.json({ error: '未登录。' }, { status: 401 })
  const job = getJob(jobId)
  if (!job) return NextResponse.json({ error: '任务不存在。' }, { status: 404 })
  if (!userCanManageJob(jobId, user)) {
    return NextResponse.json({ error: '只有课题负责人或编辑可以取消任务。' }, { status: 403 })
  }
  if (job.status !== 'cancelled' && terminalAnalysisJobStatuses.has(job.status)) {
    return NextResponse.json({ error: '终态任务不能取消。', job }, { status: 409 })
  }
  const report = getReport(job.reportVersionId)
  const project = report ? getProject(report.projectId) : undefined
  const alreadyCancelled = job.status === 'cancelled'
  try {
    const cancelledJob = cancelJob(jobId, user)
    if (!cancelledJob) return NextResponse.json({ error: '任务不存在。' }, { status: 404 })
    if (cancelledJob.status === 'cancelled') {
      if (report && !alreadyCancelled) {
        recordActivity({
          action: notificationActions.analysisCancelled,
          actor: user,
          projectId: report.projectId,
          projectTitle: project?.title,
          reportId: report.id,
          reportTitle: report.title,
          summary: '取消分析任务「' + report.title + '」',
          detail: user.displayName + ' 取消了课题「' + (project?.title ?? '未知课题') + '」中报告「' + report.title + '」的分析任务。',
        })
      }
      return NextResponse.json({ job: cancelledJob })
    }
    if (terminalAnalysisJobStatuses.has(cancelledJob.status)) {
      return NextResponse.json({ error: '终态任务不能取消。', job: cancelledJob }, { status: 409 })
    }
    return NextResponse.json({ error: '任务未能取消。', job: cancelledJob }, { status: 409 })
  } catch (error) {
    if (error instanceof ReportAuthorizationChangedError) return NextResponse.json({ error: error.message }, { status: 403 })
    throw error
  }
}

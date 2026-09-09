import { NextResponse } from 'next/server'
import { PromptBudgetError } from '@/lib/ai/prompt-budget'
import {
  assignReportMilestone,
  deleteReportVersion,
  DuplicateReportError,
  getLatestJobForReport,
  getLatestPartialSnapshotForJob,
  getProject,
  getReport,
  getReportDetail,
  listModuleStates,
  getProjectForUser,
  listReports,
  removeStoredReportFile,
  replaceReportVersionSource,
  ReportAnalysisInProgressError,
  ReportAuthorizationChangedError,
  ReportHistoryPolicyConflictError,
  ReportInsightInProgressError,
  ReportReplacementBusyError,
  userCanDeleteProject,
  userCanManageProject,
} from '@/lib/db/repository'
import { selectDisplayedAnalysisSnapshot } from '@/lib/analysis-job-progress'
import { getRequestUser } from '@/lib/auth/request'
import { logUnexpectedError } from '@/lib/http/public-error'
import { releaseStorageReservation, reserveStorageQuota, StorageQuotaError } from '@/lib/storage/quota'
import { jsonBodyFailureResponse } from '@/lib/http/json-body-response'
import { readJsonBody, RequestBodyTimeoutError, RequestBodyTooLargeError } from '@/lib/http/request-body'
import { canDeleteReportFromHistory, canReplaceReportFromHistory } from '@/modules/reports/history-policy'
import { createReportId, maxUploadBytes, parseContentLengthHeader, persistReportStream, ReportUploadError } from '@/lib/documents/report-storage'
import { recordActivity } from '@/lib/notifications'
import { notificationActions } from '@/modules/notifications/domain'

export const runtime = 'nodejs'

const docxMimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const pdfMimeType = 'application/pdf'

function throwIfUploadAborted(request: Request) {
  if (request.signal.aborted) throw new ReportUploadError('报告上传已取消。', 408)
}

function uploadAbortedResponse(request: Request) {
  return request.signal.aborted ? NextResponse.json({ error: '报告上传已取消。' }, { status: 408 }) : undefined
}

function requestAbortedResponse(request: Request, message: string) {
  return request.signal.aborted ? NextResponse.json({ error: message }, { status: 408 }) : undefined
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ reportId: string }> },
) {
  const { reportId } = await context.params
  const user = getRequestUser(_request)
  if (!user) return NextResponse.json({ error: '未登录。' }, { status: 401 })
  const detail = getReportDetail(reportId)
  if (!detail) return NextResponse.json({ error: '报告版本不存在。' }, { status: 404 })
  const report = detail.report
  const project = getProject(report.projectId)
  const finalSnapshot = detail.snapshot
  const job = getLatestJobForReport(report.id)
  const partialSnapshot = job && ['queued', 'running'].includes(job.status)
    ? getLatestPartialSnapshotForJob(job.id)
    : undefined
  const snapshot = selectDisplayedAnalysisSnapshot(finalSnapshot, partialSnapshot)
  return NextResponse.json({
    report,
    project,
    job,
    moduleStates: job ? listModuleStates(job.id) : [],
    snapshot: snapshot ? { payload: snapshot.payload } : undefined,
  })
}

export async function PATCH(
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
    return NextResponse.json({ error: '当前账号没有调整报告所属阶段的权限。' }, { status: 403 })
  }
  const activeJob = getLatestJobForReport(reportId)
  if (activeJob && (activeJob.status === 'queued' || activeJob.status === 'running')) {
    return NextResponse.json({ error: '报告正在分析，暂时不能调整所属阶段。' }, { status: 409 })
  }

  const abortedBeforeBody = requestAbortedResponse(request, '请求已取消。')
  if (abortedBeforeBody) return abortedBeforeBody
  let body: { milestoneId?: string; deliveryType?: string } | null
  try {
    body = await readJsonBody(request, 16 * 1024)
  } catch (error) {
    if (request.signal.aborted) return NextResponse.json({ error: '请求已取消。' }, { status: 408 })
    if (error instanceof RequestBodyTimeoutError) return jsonBodyFailureResponse(408)
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: '请求体超过大小限制。' }, { status: 413 })
    }
    throw error
  }
  const abortedAfterBody = requestAbortedResponse(request, '请求已取消。')
  if (abortedAfterBody) return abortedAfterBody
  const milestoneId = typeof body?.milestoneId === 'string' ? body.milestoneId.trim() : ''
  const project = getProject(report.projectId)
  const deliveryType = body?.deliveryType === 'stage' || body?.deliveryType === 'final'
    ? body.deliveryType
    : report.deliveryType ?? 'stage'
  const effectiveMilestoneId = deliveryType === 'final' ? project?.milestones.at(-1)?.id : milestoneId
  if (!effectiveMilestoneId || !project?.milestones.some((milestone) => milestone.id === effectiveMilestoneId)) {
    return NextResponse.json({ error: '请选择当前课题中的有效研究阶段。' }, { status: 400 })
  }

  let updatedReport
  try {
    throwIfUploadAborted(request)
    updatedReport = assignReportMilestone(reportId, effectiveMilestoneId, deliveryType, user)
  } catch (error) {
    if (request.signal.aborted) {
      return NextResponse.json({ error: '请求已取消。' }, { status: 408 })
    }
    if (error instanceof ReportAuthorizationChangedError) {
      return NextResponse.json({ error: error.message }, { status: 403 })
    }
    if (error instanceof ReportAnalysisInProgressError) {
      return NextResponse.json({ error: '报告正在分析，暂时不能调整所属阶段。' }, { status: 409 })
    }
    throw error
  }
  if (updatedReport) {
    recordActivity({
      action: notificationActions.reportAssigned,
      actor: user,
      projectId: report.projectId,
      projectTitle: project?.title,
      reportId: updatedReport.id,
      reportTitle: updatedReport.title,
      summary: '更新报告所属阶段「' + (project?.milestones.find((milestone) => milestone.id === effectiveMilestoneId)?.title ?? '未命名阶段') + '」',
      detail: user.displayName + ' 将报告「' + updatedReport.title + '」调整至课题「' + (project?.title ?? '未知课题') + '」的阶段「' + (project?.milestones.find((milestone) => milestone.id === effectiveMilestoneId)?.title ?? '未命名阶段') + '」。',
    })
  }
  return updatedReport
    ? NextResponse.json({
      report: updatedReport,
      project: getProjectForUser(user, report.projectId),
    })
    : NextResponse.json({ error: '报告版本不存在。' }, { status: 404 })
}

export async function PUT(
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
    return NextResponse.json({ error: '只有课题负责人或协作者可以替换报告。' }, { status: 403 })
  }
  const project = getProject(report.projectId)
  if (!project || !canReplaceReportFromHistory(report, project.milestones, listReports(report.projectId))) {
    return NextResponse.json({ error: '仅历史办结阶段的报告可以替换。' }, { status: 409 })
  }

  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== docxMimeType && contentType !== pdfMimeType && contentType !== 'application/octet-stream') {
    return NextResponse.json({ error: '请直接上传 DOCX 或 PDF 文件内容。' }, { status: 415 })
  }
  const encodedFileName = request.headers.get('x-file-name') ?? ''
  let fileName = ''
  try { fileName = decodeURIComponent(encodedFileName) } catch { /* handled below */ }
  if (!fileName || fileName.length > 240 || /[\u0000-\u001f\u007f]/.test(fileName) || !/\.(docx|pdf)$/i.test(fileName)) {
    return NextResponse.json({ error: '报告文件名无效，仅支持 DOCX 或 PDF。' }, { status: 400 })
  }
  let contentLength: number | undefined
  try {
    contentLength = parseContentLengthHeader(request.headers.get('content-length'))
  } catch (error) {
    if (error instanceof ReportUploadError) return NextResponse.json({ error: error.message }, { status: error.status })
    throw error
  }
  if (contentLength !== undefined && contentLength > maxUploadBytes) {
    return NextResponse.json({ error: '报告文件超过大小限制。' }, { status: 413 })
  }

  let source: Awaited<ReturnType<typeof persistReportStream>> | undefined
  let storageReservationId: string | undefined
  let committed = false
  const abortedBeforeUpload = uploadAbortedResponse(request)
  if (abortedBeforeUpload) return abortedBeforeUpload
  try {
    throwIfUploadAborted(request)
    storageReservationId = reserveStorageQuota({ userId: user.id, projectId: report.projectId, expectedBytes: contentLength !== undefined && contentLength > 0 ? contentLength : maxUploadBytes, ownerType: 'report' })
    source = await persistReportStream({ reportId: createReportId(), fileName, body: request.body, contentLength, signal: request.signal })
    // Keep replacement atomic from the request's perspective: once aborted,
    // the newly persisted source must not enter the report transaction.
    throwIfUploadAborted(request)
    const result = await replaceReportVersionSource(reportId, fileName, source, { enforceHistoryPolicy: true, actor: user, storageReservationId })
    if (!result) {
      await removeStoredReportFile(source).catch(() => undefined)
      // 未找到业务行时不会进入 catch，必须显式释放已占用的配额。
      if (storageReservationId) {
        try {
          releaseStorageReservation(storageReservationId)
        } catch (cleanupError) {
          console.error('[reports.replace] 存储预留清理失败', cleanupError)
        }
      }
      return NextResponse.json({ error: '报告版本不存在。' }, { status: 404 })
    }
    committed = true
    recordActivity({
      action: notificationActions.reportReplaced,
      actor: user,
      projectId: report.projectId,
      projectTitle: project.title,
      reportId: result.report.id,
      reportTitle: result.report.title,
      summary: '替换报告「' + result.report.fileName + '」',
      detail: user.displayName + ' 替换了课题「' + project.title + '」的报告「' + result.report.fileName + '」，报告将重新进入分析队列。',
    })
    return NextResponse.json({
      report: result.report,
      project: getProjectForUser(user, report.projectId),
    }, { status: 202 })
  } catch (error) {
    if (source && !committed) await removeStoredReportFile(source).catch(() => undefined)
    if (storageReservationId && !committed) {
      try {
        releaseStorageReservation(storageReservationId)
      } catch (cleanupError) {
        console.error('[reports.replace] 存储预留清理失败', cleanupError)
      }
    }
    if (request.signal.aborted && !committed) {
      return NextResponse.json({ error: '报告上传已取消。' }, { status: 408 })
    }
    if (error instanceof PromptBudgetError) {
      return NextResponse.json({ error: error.message, code: error.code, requiredCharacters: error.requiredCharacters, maxContextCharacters: error.maxContextCharacters }, { status: 409 })
    }
    if (error instanceof StorageQuotaError) {
      return NextResponse.json({ error: error.message }, { status: 507, headers: { 'Retry-After': '30' } })
    }
    if (error instanceof ReportAuthorizationChangedError) {
      return NextResponse.json({ error: error.message }, { status: 403 })
    }
    if (error instanceof DuplicateReportError) {
      return NextResponse.json({ error: error.message, report: error.report }, { status: 409 })
    }
    if (error instanceof ReportReplacementBusyError || error instanceof ReportHistoryPolicyConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
    if (error instanceof ReportUploadError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    logUnexpectedError('reports.replace', error)
    return NextResponse.json({ error: '替换报告失败，请稍后重试。' }, { status: 500 })
  }
}

export async function DELETE(
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
  if (!userCanDeleteProject(report.projectId, user)) {
    return NextResponse.json({ error: '只有课题负责人可以删除报告版本。' }, { status: 403 })
  }
  const project = getProject(report.projectId)
  if (!project || !canDeleteReportFromHistory(report, project.milestones, listReports(report.projectId))) {
    return NextResponse.json({ error: '仅最新办结阶段的报告可以删除；历史办结阶段请使用替换报告。' }, { status: 409 })
  }
  const abortedBeforeDelete = requestAbortedResponse(request, '请求已取消。')
  if (abortedBeforeDelete) return abortedBeforeDelete
  try {
    if (!await deleteReportVersion(reportId, { enforceHistoryPolicy: true, actor: user })) {
      return NextResponse.json({ error: '报告版本不存在。' }, { status: 404 })
    }
  } catch (error) {
    if (request.signal.aborted) {
      return NextResponse.json({ error: '请求已取消。' }, { status: 408 })
    }
    if (error instanceof ReportAuthorizationChangedError) {
      return NextResponse.json({ error: error.message }, { status: 403 })
    }
    if (error instanceof ReportHistoryPolicyConflictError || error instanceof ReportInsightInProgressError) {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
    throw error
  }
  recordActivity({
    action: notificationActions.reportDeleted,
    actor: user,
    projectId: report.projectId,
    projectTitle: project.title,
    reportId: report.id,
    reportTitle: report.title,
    summary: '删除报告「' + report.title + '」',
    detail: user.displayName + ' 删除了课题「' + project.title + '」中的第 ' + report.version + ' 版报告「' + report.title + '」。',
  })
  return NextResponse.json({ ok: true, projectId: report.projectId })
}

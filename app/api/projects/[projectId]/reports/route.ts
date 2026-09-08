import { NextResponse } from 'next/server'
import { countReports, createReportJob, DuplicateReportError, getProject, getProjectForUser, listReports, removeStoredReportFile, ReportAuthorizationChangedError, projectExistsReadable, userCanManageProject } from '@/lib/db/repository'
import { pageResult, parsePagination, paginationRangeFailure } from '@/lib/http/pagination'
import type { ReportDeliveryType } from '@/modules/reports/domain'
import { getRequestUser } from '@/lib/auth/request'
import { createReportId, maxUploadBytes, parseContentLengthHeader, persistReportStream, ReportUploadError } from '@/lib/documents/report-storage'
import { logUnexpectedError } from '@/lib/http/public-error'
import { releaseStorageReservation, reserveStorageQuota, StorageQuotaError } from '@/lib/storage/quota'
import { recordActivity } from '@/lib/notifications'
import { notificationActions } from '@/modules/notifications/domain'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const docxMimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const pdfMimeType = 'application/pdf'

function throwIfUploadAborted(request: Request) {
  if (request.signal.aborted) throw new ReportUploadError('报告上传已取消。', 408)
}

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params
  const user = getRequestUser(request)
  if (!user) return NextResponse.json({ error: '未登录。' }, { status: 401 })
  if (!projectExistsReadable(projectId)) return NextResponse.json({ error: '课题不存在。' }, { status: 404 })
  try {
    const pagination = parsePagination(request, { limit: 100, maxLimit: 100 })
    const result = pageResult(listReports(projectId, pagination), countReports(projectId), pagination)
    return NextResponse.json({ reports: result.items, total: result.total, limit: result.limit, offset: result.offset, hasMore: result.hasMore })
  } catch (error) {
    const failure = paginationRangeFailure(error)
    if (failure) return NextResponse.json({ error: failure.error }, { status: failure.status })
    throw error
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params
  const user = getRequestUser(request)
  if (!user) return NextResponse.json({ error: '未登录。' }, { status: 401 })
  if (!projectExistsReadable(projectId)) return NextResponse.json({ error: '课题不存在。' }, { status: 404 })
  if (!userCanManageProject(projectId, user)) {
    return NextResponse.json({ error: '只有课题负责人或编辑可以上传报告。' }, { status: 403 })
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

  const deliveryType = request.headers.get('x-report-delivery-type')?.trim() as ReportDeliveryType | undefined
  if (deliveryType !== 'stage' && deliveryType !== 'final') {
    return NextResponse.json({ error: '请选择阶段报告或最终报告。' }, { status: 400 })
  }

  const rawMilestoneId = request.headers.get('x-milestone-id') ?? ''
  let requestedMilestoneId = ''
  try {
    requestedMilestoneId = decodeURIComponent(rawMilestoneId).trim()
  } catch {
    return NextResponse.json({ error: '研究阶段参数无效。' }, { status: 400 })
  }
  const project = getProject(projectId)
  const milestoneId = deliveryType === 'final'
    ? project?.milestones.at(-1)?.id
    : requestedMilestoneId
  if (!milestoneId || !project?.milestones.some((milestone) => milestone.id === milestoneId)) {
    return NextResponse.json({ error: deliveryType === 'final' ? '课题尚未配置可归档的最终阶段。' : '请选择有效的报告所属阶段。' }, { status: 400 })
  }

  const reportId = createReportId()
  let source: Awaited<ReturnType<typeof persistReportStream>> | undefined
  let storageReservationId: string | undefined
  let committed = false
  try {
    throwIfUploadAborted(request)
    storageReservationId = reserveStorageQuota({ userId: user.id, projectId, expectedBytes: contentLength !== undefined && contentLength > 0 ? contentLength : maxUploadBytes, ownerType: 'report' })
    source = await persistReportStream({ reportId, fileName, body: request.body, contentLength, signal: request.signal })
    // The upload can finish just before the client aborts. Do not create the
    // database row once the request is no longer live.
    throwIfUploadAborted(request)
    const { report } = createReportJob({
      projectId: projectId,
      fileName: fileName,
      source: source,
      reportId: reportId,
      milestoneId: milestoneId,
      autoAnalyze: false,
      deliveryType: deliveryType,
      actor: user,
      storageReservationId: storageReservationId,
    })
    committed = true
    recordActivity({
      action: notificationActions.reportUploaded,
      actor: user,
      projectId,
      projectTitle: project.title,
      reportId: report.id,
      reportTitle: report.title,
      summary: '上传报告「' + report.fileName + '」',
      detail: user.displayName + ' 向课题「' + project.title + '」上传了第 ' + report.version + ' 版' + (deliveryType === 'final' ? '最终' : '阶段') + '报告「' + report.fileName + '」，归属阶段：' + (project.milestones.find((milestone) => milestone.id === milestoneId)?.title ?? '未命名阶段') + '。',
    })
    return NextResponse.json({
      report,
      project: getProjectForUser(user, projectId),
    }, { status: 202 })
  } catch (error) {
    if (source && !committed) await removeStoredReportFile(source).catch(() => undefined)
    if (storageReservationId && !committed) {
      try {
        releaseStorageReservation(storageReservationId)
      } catch (cleanupError) {
        console.error('[projects.report-upload] 存储预留清理失败', cleanupError)
      }
    }
    if (request.signal.aborted && !committed) {
      return NextResponse.json({ error: '报告上传已取消。' }, { status: 408 })
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
    if (error instanceof ReportUploadError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    logUnexpectedError('projects.report-upload', error)
    return NextResponse.json({ error: '报告上传失败，请稍后重试。' }, { status: 500 })
  }
}

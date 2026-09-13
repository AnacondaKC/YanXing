import {createJobEventStream} from '@/lib/http/submission-task-events'
import type { SessionUser as AuthUser } from '@/modules/users/domain'
import { jsonBodyFailureResponse } from '@/lib/http/json-body-response'
import { parsePagination, paginationRangeFailure } from '@/lib/http/pagination'
import { logUnexpectedError } from '@/lib/http/public-error'
import { checkRateLimit } from '@/lib/security/rate-limit'
import { rateLimitFailure } from '@/lib/http/rate-limit-response'
import { readJsonBodyOrTooLarge } from '@/lib/http/request-body'
import { isNativeSchemaError, publicNativeSchemaFailure } from '@/lib/db/native-schema-error'
import type { SubmissionWorkspaceRepository } from '@/lib/db/submission-workspace-repository'
import { AiQueueFullError, aiQueueHttpFailure } from '@/lib/ai/queue-policy'
import { isStagePlanEdit, isStageProjectCreate } from '@/modules/projects/stage-project-contract'
import { StageWorkflowError } from '@/modules/projects/stage-domain'
import { notificationActions } from '@/modules/notifications/domain'
import { ReportSubmissionError } from '@/modules/reports/upload-domain'
import { SubmissionTaskError } from '@/modules/reports/submission-task-domain'
import {
  isWorkspaceProjectSafeEdit, isWorkspaceReportDelete, WORKSPACE_RETIRED_CODES, WORKSPACE_RETIRED_PROJECT_FIELDS,
  type WorkspaceSelectionSource,
} from '@/modules/contracts/submission-workspace'
import type { createSubmissionProcessingRuntime } from '@/lib/reports/submission-processing-runtime'

type ProcessingRuntime = ReturnType<typeof createSubmissionProcessingRuntime>
const JSON_BODY_LIMIT = 64 * 1024
const DELETE_BODY_LIMIT = 8 * 1024
const CREATE_RETIRED_FIELDS = ['milestones', 'progress', 'stage', 'status', 'reportIds'] as const
const UPLOAD_TYPES = ['application/octet-stream', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'multipart/form-data']

export function createSubmissionWorkspaceHandlers(input: {
  processing: ProcessingRuntime
  workspace: SubmissionWorkspaceRepository
  getCurrentUser: (request: Request) => AuthUser | undefined
}) {
  const { processing, workspace, getCurrentUser } = input

  async function asActor(request: Request) {
    const user = getCurrentUser(request)
    if (!user) throw new SubmissionTaskError('UNAUTHENTICATED', '未登录。', 401)
    return workspace.actor(user.id)
  }

  async function guarded(request: Request, action: () => Promise<Response>) {
    try {
      if (request.signal.aborted) return json({ error: '请求已取消。', code: 'REQUEST_ABORTED' }, 408)
      return await action()
    }
    catch (error) { return mapError(error) }
  }

  function withPagination(request: Request, defaults: { limit: number; maxLimit: number }, read: (pagination: { limit: number; offset: number }) => unknown) {
    return guarded(request, async () => {
      await asActor(request)
      let pagination
      try { pagination = parsePagination(request, defaults) }
      catch (error) {
        const failure = paginationRangeFailure(error)
        if (failure) return json({ error: failure.error, code: 'PAGINATION_RANGE' }, failure.status)
        throw error
      }
      return json(read(pagination))
    })
  }

  return {
    listProjects(request: Request) {
      return withPagination(request, { limit: 100, maxLimit: 100 }, (pagination) => {
        const page = workspace.listProjects({ actorId: getCurrentUser(request)!.id, pagination })
        return { projects: page.projects, total: page.total, limit: page.limit, offset: page.offset, hasMore: page.hasMore }
      })
    },
    createProject(request: Request) {
      return guarded(request, async () => {
        const actor = await asActor(request)
        const parsed = await readJsonBodyOrTooLarge<Record<string, unknown>>(request, JSON_BODY_LIMIT)
        if (!parsed.ok) return jsonBodyFailureResponse(parsed.status)
        const body = parsed.body && typeof parsed.body === 'object' ? { ...parsed.body } : {}
        if (hasFields(body, CREATE_RETIRED_FIELDS)) return retired('PROJECT_FIELD_RETIRED', '请使用 stages 创建研究计划，不要提交 milestones。')
        if (typeof body.ownerId !== 'string' || !body.ownerId.trim()) body.ownerId = actor.id
        if (!isStageProjectCreate(body)) return json({ error: '课题或阶段参数无效。', code: 'INVALID_SUBMISSION' }, 400)
        const workflow = processing.repository.createProject({ actorId: actor.id, project: body })
        workspace.recordActivity({ action: notificationActions.projectCreated, actor, projectId: workflow.projectId, projectTitle: body.title, summary: '新建课题「' + body.title + '」', detail: actor.displayName + ' 新建课题「' + body.title + '」。' })
        return json(workspace.getProjectDetail({ actorId: actor.id, projectId: workflow.projectId }), 201)
      })
    },
    getProject(request: Request, projectId: string) {
      return guarded(request, async () => {
        const actor = await asActor(request)
        const url = new URL(request.url)
        const requested = { stageId: url.searchParams.get('stageId') ?? undefined, reportId: url.searchParams.get('reportId') ?? undefined, source: asSource(url.searchParams.get('source')) }
        return json(workspace.getProjectDetail({ actorId: actor.id, projectId, requested }))
      })
    },
    patchProject(request: Request, projectId: string) {
      return guarded(request, async () => {
        const actor = await asActor(request)
        const parsed = await readJsonBodyOrTooLarge<Record<string, unknown>>(request, JSON_BODY_LIMIT)
        if (!parsed.ok) return jsonBodyFailureResponse(parsed.status)
        const body = parsed.body
        if (hasFields(body, WORKSPACE_RETIRED_PROJECT_FIELDS)) return retired('PROJECT_FIELD_RETIRED', '课题负责人、协作者请走成员接口；研究计划请 PATCH /api/projects/:id/stages。')
        if (!isWorkspaceProjectSafeEdit(body)) return json({ error: '课题更新参数无效。', code: 'INVALID_SUBMISSION' }, 400)
        if (body.title === undefined && body.objective === undefined && body.description === undefined) return json({ error: '没有可更新的课题字段。', code: 'INVALID_SUBMISSION' }, 400)
        return json(workspace.safeEditProject({ actorId: actor.id, projectId, edit: body }))
      })
    },
    putProject(_request: Request, _projectId: string) {
      return Promise.resolve(retired('PROJECT_FIELD_RETIRED', '课题更新请使用 PATCH，且仅允许 title/objective/description。'))
    },
    deleteProject(request: Request, projectId: string) {
      return guarded(request, async () => {
        const actor = await asActor(request)
        workspace.getProjectDetail({ actorId: actor.id, projectId })
        return json({ error: '课题文件需长期保留，当前版本不提供课题删除。', code: WORKSPACE_RETIRED_CODES.PROJECT_RETENTION_REQUIRED }, 409)
      })
    },
    listStages(request: Request, projectId: string) {
      return guarded(request, async () => json(workspace.listStages({ actorId: (await asActor(request)).id, projectId })))
    },
    editPlan(request: Request, projectId: string) {
      return guarded(request, async () => {
        const actor = await asActor(request)
        const parsed = await readJsonBodyOrTooLarge<unknown>(request, JSON_BODY_LIMIT)
        if (!parsed.ok) return jsonBodyFailureResponse(parsed.status)
        if (hasFields(parsed.body, ['milestones'])) return retired('PROJECT_FIELD_RETIRED', '研究计划请提交 StagePlanEdit.nextStages。')
        if (!isStagePlanEdit(parsed.body)) return json({ error: '阶段计划参数无效。', code: 'INVALID_SUBMISSION' }, 400)
        processing.repository.editPlan({ actorId: actor.id, projectId, edit: parsed.body })
        return json(workspace.listStages({ actorId: actor.id, projectId }))
      })
    },
    listStageReports(request: Request, projectId: string, stageId: string) {
      return withPagination(request, { limit: 50, maxLimit: 100 }, (pagination) => workspace.listStageReports({ actorId: getCurrentUser(request)!.id, projectId, stageId, pagination }))
    },
    listProjectReports(request: Request, projectId: string) {
      return withPagination(request, { limit: 100, maxLimit: 100 }, (pagination) => workspace.listProjectReports({ actorId: getCurrentUser(request)!.id, projectId, pagination }))
    },
    listHistory(request: Request, projectId: string) {
      return withPagination(request, { limit: 20, maxLimit: 100 }, (pagination) => workspace.listHistory({ actorId: getCurrentUser(request)!.id, projectId, pagination }))
    },
    listLibrary(request: Request) {
      return withPagination(request, { limit: 20, maxLimit: 100 }, (pagination) => workspace.listLibraryReports({ actorId: getCurrentUser(request)!.id, pagination }))
    },
    prepareUpload(request: Request, projectId: string) {
      return guarded(request, () => processing.handlers.prepare(request, projectId))
    },
    uploadStatus(request: Request, projectId: string, uploadId: string) {
      return guarded(request, () => processing.handlers.status(request, { projectId, uploadId }))
    },
    confirmReport(request: Request, projectId: string) {
      return guarded(request, async () => {
        if (isRetiredUpload(request)) return retired('UPLOAD_PROTOCOL_RETIRED', '请先 POST /report-uploads 再以 JSON 确认提交。')
        const response = await processing.handlers.confirm(request, projectId)
        if (response.ok) {
          try {
            const actor = await asActor(request)
            const payload = await response.clone().json() as { replayed?: boolean; reused?: boolean; receipt?: { reportId?: string } }
            const reportId = payload.receipt?.reportId
            if (reportId && !payload.replayed && !payload.reused) {
              const detail = workspace.getReportDetail({ actorId: actor.id, reportId })
              workspace.recordActivity({ action: notificationActions.reportUploaded, actor, projectId, projectTitle: detail.projectTitle, reportId, reportTitle: detail.title, summary: '上传报告「' + detail.fileName + '」', detail: actor.displayName + ' 提交了报告「' + detail.title + '」。' })
            }
          } catch { /* confirmation already succeeded */ }
        }
        return response
      })
    },
    getReport(request: Request, reportId: string) {
      return guarded(request, async () => json(workspace.getReportDetail({ actorId: (await asActor(request)).id, reportId })))
    },
    deleteReport(request: Request, reportId: string) {
      return guarded(request, async () => {
        const actor = await asActor(request)
        const parsed = await readJsonBodyOrTooLarge<unknown>(request, DELETE_BODY_LIMIT)
        if (!parsed.ok) return jsonBodyFailureResponse(parsed.status)
        if (!isWorkspaceReportDelete(parsed.body)) return json({ error: '删除报告必须提供原因。', code: 'INVALID_DELETE_REASON' }, 400)
        const detail = workspace.getReportDetail({ actorId: actor.id, reportId })
        processing.tasks.deleteReport({ actorId: actor.id, reportId, reason: parsed.body.reason })
        workspace.recordActivity({ action: notificationActions.reportDeleted, actor, projectId: detail.projectId, projectTitle: detail.projectTitle, reportId, reportTitle: detail.title, summary: '删除报告「' + detail.title + '」', detail: actor.displayName + ' 逻辑删除了报告「' + detail.title + '」。' })
        return json({ ok: true, reportId })
      })
    },
    patchReport(request: Request) { return guarded(request, async () => retired('REPORT_STAGE_IMMUTABLE', '已提交报告的阶段归属不可修改。')) },
    putReport(request: Request) { return guarded(request, async () => retired('REPORT_SOURCE_IMMUTABLE', '已提交报告的源文件不可替换。')) },
    startAnalysis(request: Request, reportId: string) { return startOperation(request, reportId, 'analysis') },
    startInsight(request: Request, reportId: string) { return startOperation(request, reportId, 'insight') },
    getInsight(request: Request, reportId: string) {
      return guarded(request, async () => {
        const detail = workspace.getReportDetail({ actorId: (await asActor(request)).id, reportId })
        const generating = detail.insightTask?.status === 'queued' || detail.insightTask?.status === 'running'
        return json({ insight: detail.insight, generating, job: detail.insightTask })
      })
    },
    getJob(request: Request, jobId: string) {
      return guarded(request, async () => json(workspace.jobView({ actorId: (await asActor(request)).id, jobId })))
    },
    cancelJob(request: Request, jobId: string) {
      return guarded(request, async () => {
        const actor = await asActor(request)
        const view = workspace.jobView({ actorId: actor.id, jobId })
        const job = processing.tasks.cancel({ actorId: actor.id, jobId })
        if (job.status === 'completed' || job.status === 'failed') {
          return json({ error: '终态任务不能取消。', code: 'TASK_ALREADY_TERMINAL', job }, 409)
        }
        if (job.status === 'cancelled' && view.job.operation === 'analysis' && view.job.status !== 'cancelled') bestEffortNotification(() => {
          const detail = workspace.getReportDetail({ actorId: actor.id, reportId: job.reportId })
          workspace.recordActivity({ action: notificationActions.analysisCancelled, actor, projectId: job.projectId, projectTitle: detail.projectTitle, reportId: job.reportId, reportTitle: detail.title, summary: '取消分析任务「' + detail.title + '」', detail: actor.displayName + ' 取消了报告「' + detail.title + '」的分析任务。' })
        })
        return json({ job })
      })
    },
    retryJob(request: Request, jobId: string) {
      return guarded(request, async () => {
        const admitted = processing.tasks.retry({ actorId: (await asActor(request)).id, jobId })
        return json({ job: admitted.task, reused: admitted.reused }, admitted.reused ? 200 : 202)
      })
    },
    listNotifications(request: Request) {
      return withPagination(request, { limit: 40, maxLimit: 100 }, (pagination) => workspace.listNotifications({ actorId: getCurrentUser(request)!.id, pagination }))
    },
    patchNotifications(request: Request) {
      return guarded(request, async () => {
        const actor = await asActor(request)
        const parsed = await readJsonBodyOrTooLarge<{ all?: unknown; ids?: unknown[] }>(request, 32 * 1024)
        if (!parsed.ok) return jsonBodyFailureResponse(parsed.status)
        const ids = Array.isArray(parsed.body?.ids) ? [...new Set(parsed.body.ids.filter((id): id is string => typeof id === 'string').map((id) => id.trim()).filter(Boolean))] : []
        if (parsed.body?.all !== true && !ids.length) return json({ error: '请指定要标记的通知。', code: 'INVALID_SUBMISSION' }, 400)
        if (parsed.body?.all !== true && ids.length > 100) return json({ error: '一次最多标记 100 条通知。', code: 'INVALID_SUBMISSION' }, 400)
        return json({ marked: workspace.markNotificationsRead({ actorId: actor.id, all: parsed.body?.all === true, ids }) })
      })
    },
    overview(request: Request) {
      return guarded(request, async () => {
        const actor = await asActor(request)
        const limited = rateLimitFailure(checkRateLimit('overview-stats:' + actor.id, { limit: 120, windowMs: 60_000 }), { error: '概览访问过于频繁，请稍后再试。' })
        if (limited) return json(limited.body, limited.status, limited.headers)
        return json(workspace.overview({ actorId: actor.id }))
      })
    },
    jobEvents: createJobEventStream({ workspace, getCurrentUser, onError:mapError }),
  }

  async function startOperation(request: Request, reportId: string, operation: 'analysis' | 'insight') {
    return guarded(request, async () => {
      const actor = await asActor(request)
      const admitted = processing.tasks.admit({ actorId: actor.id, reportId, operation })
      if (!admitted.reused) bestEffortNotification(() => {
        const detail = workspace.getReportDetail({ actorId: actor.id, reportId })
        workspace.recordActivity({
          action: operation === 'analysis' ? notificationActions.analysisStarted : notificationActions.insightStarted,
          actor, projectId: detail.projectId, projectTitle: detail.projectTitle, reportId, reportTitle: detail.title,
          summary: (operation === 'analysis' ? '开始分析报告「' : '生成报告洞察「') + detail.title + '」',
          detail: actor.displayName + (operation === 'analysis' ? ' 发起了报告分析。' : ' 发起了洞察生成。'),
        })
      })
      return json({ job: admitted.task, reused: admitted.reused }, admitted.reused ? 200 : 202)
    })
  }
}

function bestEffortNotification(write: () => void) {
  try { write() } catch (error) { logUnexpectedError('workspace-notification', error) }
}

function mapError(error: unknown) {
  if (isNativeSchemaError(error)) return json(publicNativeSchemaFailure(error), 503)
  if (error instanceof AiQueueFullError) { const failure = aiQueueHttpFailure(error); return json(failure.body, failure.status, failure.headers) }
  if (error instanceof SubmissionTaskError) return json({ error: error.message, code: error.code }, error.status)
  if (error instanceof ReportSubmissionError) return json({ error: error.message, code: error.code }, error.status)
  if (error instanceof StageWorkflowError) {
    const invalid = error.code === 'INVALID_STAGE_PLAN' || error.code === 'EMPTY_STAGE_PLAN' || error.code === 'INVALID_SUBMISSION' || error.code === 'INVALID_REPORT_KIND'
    return json({ error: error.message, code: error.code }, invalid ? 400 : 409)
  }
  logUnexpectedError('submission-workspace', error)
  return json({ error: '操作失败，请稍后重试。', code: 'WORKSPACE_FAILED' }, 500)
}

function json(value: unknown, status = 200, headers?: Record<string, string>) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}

function retired(code: keyof typeof WORKSPACE_RETIRED_CODES, error: string) {
  const status = code === 'UPLOAD_PROTOCOL_RETIRED' ? 410 : 409
  return json({ error, code: WORKSPACE_RETIRED_CODES[code] }, status)
}

function hasFields(body: unknown, fields: readonly string[]) {
  if (!body || typeof body !== 'object') return false
  return fields.some((field) => Object.prototype.hasOwnProperty.call(body, field))
}

function isRetiredUpload(request: Request) {
  if (request.headers.get('x-file-name')) return true
  const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
  if (!type) return false
  return type !== 'application/json' && UPLOAD_TYPES.includes(type)
}

function asSource(value: string | null): WorkspaceSelectionSource | undefined {
  if (value === 'current_stage' || value === 'latest_submission' || value === 'stage_completion' || value === 'explicit') return value
  return undefined
}

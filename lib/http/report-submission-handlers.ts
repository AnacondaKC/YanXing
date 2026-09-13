import type { ReportSubmissionService } from '@/modules/reports/submission-service'
import { ReportSubmissionError, type ReportUploadRecord } from '@/modules/reports/upload-domain'
import { StageWorkflowError } from '@/modules/projects/stage-domain'
import { isReportSubmissionCommand, isReportSubmissionIdempotencyKey } from '@/modules/contracts/report-submission'
import { StorageQuotaError } from '@/lib/storage/quota'

const MAX_CONFIRMATION_BYTES = 16 * 1024

export function createReportSubmissionHandlers(input: {
  service: ReportSubmissionService
  resolveActorId: (request: Request) => string | undefined | Promise<string | undefined>
  onUnexpectedError?: (error: unknown) => void
}) {
  async function authorized(request: Request, action: (actorId: string) => Promise<Response>): Promise<Response> {
    try {
      const actorId = await input.resolveActorId(request)
      if (!actorId) return json({ error: '未登录。', code: 'UNAUTHENTICATED' }, 401)
      return await action(actorId)
    } catch (error) {
      if (error instanceof ReportSubmissionError) return json({ error: error.message, code: error.code }, error.status)
      if (error instanceof StageWorkflowError) {
        const invalid = ['EMPTY_STAGE_PLAN','INVALID_STAGE_PLAN','INVALID_SUBMISSION','INVALID_REPORT_KIND'].includes(error.code)
        return json({ error: error.message, code: error.code, details: error.details }, invalid ? 400 : 409)
      }
      if (error instanceof StorageQuotaError) return json({ error: error.message, code: 'STORAGE_QUOTA_EXCEEDED' }, 507)
      if (error instanceof Error && error.name === 'AbortError') return json({ error: '上传已取消。', code: 'UPLOAD_ABORTED' }, 409)
      input.onUnexpectedError?.(error)
      return json({ error: '报告操作失败，请稍后重试。', code: 'REPORT_SUBMISSION_FAILED' }, 500)
    }
  }

  return {
    prepare(request: Request, projectId: string): Promise<Response> {
      return authorized(request, async (actorId) => {
        const fileName = new URL(request.url).searchParams.get('fileName')
        if (!fileName) throw new ReportSubmissionError('UPLOAD_FILE_INVALID', '缺少报告文件名。', 400)
        const header = request.headers.get('content-length')
        if (header !== null && !/^[0-9]+$/.test(header)) throw new ReportSubmissionError('UPLOAD_FILE_INVALID', '文件长度无效。', 400)
        const upload = await input.service.prepare({ projectId, actorId, fileName, body: request.body,
          contentLength: header === null ? undefined : Number(header), signal: request.signal })
        return json(publicUpload(upload), 201)
      })
    },
    status(request: Request, route: { projectId: string; uploadId: string }): Promise<Response> {
      return authorized(request, async (actorId) => json(publicUpload(input.service.getUpload({ ...route, actorId }))))
    },
    confirm(request: Request, projectId: string): Promise<Response> {
      return authorized(request, async (actorId) => {
        const key = request.headers.get('idempotency-key')
        if (!isReportSubmissionIdempotencyKey(key)) throw new ReportSubmissionError('INVALID_SUBMISSION', '缺少有效的提交幂等键。', 400)
        const command = await readConfirmationBody(request)
        if (!isReportSubmissionCommand(command)) throw new ReportSubmissionError('INVALID_SUBMISSION', '报告提交参数无效。', 400)
        const result = await input.service.confirm({ actorId, projectId, idempotencyKey: key, command })
        return json(result, result.replayed ? 200 : 201)
      })
    },
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
}

function publicUpload(upload: ReportUploadRecord) {
  const file = upload.prepared
  return { id: upload.id, projectId: upload.projectId, status: upload.status, fileName: upload.fileName,
    createdAt: upload.createdAt, expiresAt: upload.expiresAt, reportId: upload.reportId, errorCode: upload.errorCode,
    preview: file ? { title: file.title, paragraphCount: file.paragraphCount, characterCount: file.characterCount } : undefined }
}

async function readConfirmationBody(request: Request): Promise<unknown> {
  if (!request.body) throw new ReportSubmissionError('INVALID_SUBMISSION', '缺少提交参数。', 400)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_CONFIRMATION_BYTES) {
        await reader.cancel()
        throw new ReportSubmissionError('INVALID_SUBMISSION', '提交参数超过大小限制。', 413)
      }
      chunks.push(chunk.value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
    catch { throw new ReportSubmissionError('INVALID_SUBMISSION', '提交参数不是有效JSON。', 400) }
  } finally { reader.releaseLock() }
}

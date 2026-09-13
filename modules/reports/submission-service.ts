import { randomUUID } from 'node:crypto'
import type { ReportSubmissionRepository } from '@/lib/db/report-submission-repository'
import { isReportSubmissionCommand, isReportSubmissionIdempotencyKey } from '@/modules/contracts/report-submission'
import { ReportSubmissionError, type PreparedReportFile, type PreparedReportFiles, type ReportSubmissionConfirmation } from '@/modules/reports/upload-domain'

export class ReportSubmissionService {
  private readonly repository: ReportSubmissionRepository
  private readonly files: PreparedReportFiles
  private readonly now: () => Date
  private readonly maxUploadBytes: number
  private readonly uploadTtlMs: number
  private readonly newId: () => string

  constructor(input: { repository: ReportSubmissionRepository; files: PreparedReportFiles; maxUploadBytes: number; uploadTtlMs: number; now?: () => Date; newId?: () => string }) {
    if (!Number.isSafeInteger(input.maxUploadBytes) || input.maxUploadBytes < 1 || !Number.isSafeInteger(input.uploadTtlMs) || input.uploadTtlMs < 1) {
      throw new Error('Upload byte limit and TTL must be positive safe integers.')
    }
    this.repository = input.repository
    this.files = input.files
    this.now = input.now ?? (() => new Date())
    this.newId = input.newId ?? randomUUID
    this.maxUploadBytes = input.maxUploadBytes
    this.uploadTtlMs = input.uploadTtlMs
  }

  async prepare(input: { actorId: string; projectId: string; fileName: string; body: ReadableStream<Uint8Array> | null; contentLength?: number; signal?: AbortSignal }) {
    if (!input.body) throw new ReportSubmissionError('UPLOAD_FILE_INVALID', '请选择报告文件。', 400)
    if (input.contentLength !== undefined && (!Number.isSafeInteger(input.contentLength) || input.contentLength < 1 || input.contentLength > this.maxUploadBytes)) {
      throw new ReportSubmissionError('UPLOAD_FILE_INVALID', '报告文件大小不符合上传限制。', 413)
    }
    input.signal?.throwIfAborted()
    const uploadId = this.newId()
    const identity = { actorId: input.actorId, projectId: input.projectId, uploadId }
    this.repository.beginUpload({ ...identity, fileName: input.fileName,
      reservedBytes: input.contentLength ?? this.maxUploadBytes,
      expiresAt: new Date(this.now().getTime() + this.uploadTtlMs).toISOString() })
    let prepared: PreparedReportFile | undefined
    try {
      this.repository.markParsing(identity)
      prepared = await this.files.prepare({ uploadId, fileName: input.fileName, body: input.body, contentLength: input.contentLength, signal: input.signal })
      input.signal?.throwIfAborted()
      return this.repository.markReady({ ...identity, file: prepared })
    } catch (error) {
      if (error instanceof ReportSubmissionError && error.code === 'UPLOAD_CLEANUP_FAILED') throw error
      if (prepared) await this.files.discard(prepared)
      this.repository.failUpload({ ...identity, errorCode: error instanceof ReportSubmissionError ? error.code : 'REPORT_PARSE_FAILED' })
      throw error
    }
  }

  getUpload(input: { actorId: string; projectId: string; uploadId: string }) {
    return this.repository.getUpload(input)
  }

  async confirm(input: ReportSubmissionConfirmation) {
    if (!isReportSubmissionCommand(input.command) || !isReportSubmissionIdempotencyKey(input.idempotencyKey)) {
      throw new ReportSubmissionError('INVALID_SUBMISSION', '报告提交参数或幂等键无效。', 400)
    }
    const replay = this.repository.replayConfirmation(input)
    if (replay) return replay
    const upload = this.repository.getUpload({ actorId: input.actorId, projectId: input.projectId, uploadId: input.command.uploadId })
    if (upload.status !== 'ready' || !upload.prepared) throw new ReportSubmissionError('UPLOAD_NOT_READY', '报告尚未完成基础解析。')
    if (Date.parse(upload.expiresAt) <= this.now().getTime()) throw new ReportSubmissionError('UPLOAD_EXPIRED', '报告准备记录已过期，请重新上传。')
    await this.files.verify(upload.prepared)
    // The repository rechecks ownership, expiry, tokens and replay inside its write transaction.
    return this.repository.confirmSubmission(input)
  }
}

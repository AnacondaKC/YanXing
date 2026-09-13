import type { DatabaseSync } from 'node:sqlite'
import type { ReportSubmissionCommand } from '@/modules/contracts/report-submission'
import type { ReportSubmission } from '@/modules/reports/submission-domain'

export type ReportUploadStatus = 'receiving' | 'parsing' | 'ready' | 'failed' | 'committed' | 'reclaiming' | 'reclaimed'

export interface PreparedReportFile {
  sourceKey: string
  fileName: string
  mimeType: string
  fileHash: string
  sourceSize: number
  title: string
  text: string
  paragraphCount: number
  characterCount: number
}

export interface ReportUploadRecord {
  id: string
  projectId: string
  actorId: string
  fileName: string
  status: ReportUploadStatus
  reservationId: string
  reservedBytes: number
  createdAt: string
  expiresAt: string
  prepared?: PreparedReportFile
  reportId?: string
  errorCode?: string
}

export interface ReportSubmissionReceipt {
  reportId: string
  projectId: string
  stageId: string
  stageVersion: number
  submissionSequence: number
  submittedAs: 'update' | 'completion'
  submittedAt: string
  outboxEventId: string
}

export interface ReportSubmissionConfirmation {
  projectId: string
  actorId: string
  idempotencyKey: string
  command: ReportSubmissionCommand
}

export interface SubmissionQuota {
  reserve(input: { database: DatabaseSync; actorId: string; projectId: string; expectedBytes: number }): string
  consume(input: { database: DatabaseSync; reservationId: string; report: ReportSubmission; mimeType: string }): void
  release(input: { database: DatabaseSync; reservationId: string }): void
}

export interface PreparedReportFiles {
  prepare(input: { uploadId: string; fileName: string; body: ReadableStream<Uint8Array> | null; contentLength?: number; signal?: AbortSignal }): Promise<PreparedReportFile>
  verify(file: Pick<PreparedReportFile,'sourceKey'|'fileHash'|'sourceSize'>): Promise<void>
  discard(file: PreparedReportFile): Promise<void>
}

export type SubmissionFailureCode =
  | 'PROJECT_CONFIGURATION_FORBIDDEN'
  | 'PROJECT_NOT_FOUND' | 'REPORT_WRITE_FORBIDDEN' | 'STAGE_PLAN_EXISTS' | 'STAGE_PLAN_MISSING'
  | 'INVALID_SUBMISSION' | 'IDEMPOTENCY_KEY_REUSED' | 'UPLOAD_NOT_FOUND' | 'UPLOAD_NOT_READY'
  | 'UPLOAD_EXPIRED' | 'UPLOAD_ALREADY_COMMITTED' | 'UPLOAD_FILE_INVALID' | 'UPLOAD_ABORTED'
  | 'RECOVERY_LEASE_LOST' | 'PROJECT_MEMBER_INVALID' | 'REPORT_PARSE_FAILED' | 'REPORT_FILE_CHANGED' | 'UPLOAD_CLEANUP_FAILED' | 'REPORT_PROCESSING' | 'OUTBOX_LEASE_LOST' | 'PROJECT_UPDATE_CONFLICT'

export class ReportSubmissionError extends Error {
  constructor(readonly code: SubmissionFailureCode, message: string, readonly status = 409) {
    super(message)
    this.name = 'ReportSubmissionError'
  }
}

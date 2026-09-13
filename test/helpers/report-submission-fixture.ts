import { DatabaseSync } from 'node:sqlite'
import { ReportSubmissionRepository } from '../../lib/db/report-submission-repository'
import { createReportUploadTestDatabase } from './report-upload-database'
import { createSubmissionStorageQuota } from '../../lib/storage/submission-quota'
import type { PreparedReportFile, ReportSubmissionConfirmation, SubmissionQuota } from '../../modules/reports/upload-domain'
import type { ReportSubmissionKind } from '../../modules/reports/submission-domain'

export const PROJECT_ID = 'project'
export const OWNER = 'owner'

export const defaultStages = [
  { id: 'stage-1', title: '开题研究' },
  { id: 'stage-2', title: '实地调研' },
  { id: 'stage-3', title: '成果形成' },
] as const

export function createSubmissionEngine(path = ':memory:') {
  const database = createReportUploadTestDatabase(path)
  if (path !== ':memory:') database.exec('PRAGMA journal_mode=WAL')
  const quota = createSubmissionStorageQuota({ storageRoot: '/unused-test-root' })
  const repository = new ReportSubmissionRepository({ database, quota })
  return { database, quota, repository }
}

export function connectSubmissionEngine(path: string, quota: SubmissionQuota, busyTimeoutMs = 1000) {
  const database = new DatabaseSync(path)
  database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=' + busyTimeoutMs)
  return { database, repository: new ReportSubmissionRepository({ database, quota }) }
}

export function wrapQuota(quota: SubmissionQuota, traps: { consume?: Error } = {}): SubmissionQuota {
  return {
    reserve(input) { return quota.reserve(input) },
    release(input) { quota.release(input) },
    consume(input) {
      if (traps.consume) throw traps.consume
      quota.consume(input)
    },
  }
}

export function preparedFile(uploadId: string): PreparedReportFile {
  const text = '这是一份完整研究报告。'
  return {
    sourceKey: uploadId + '/report.docx',
    fileName: 'report.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    fileHash: 'a'.repeat(64),
    sourceSize: 4,
    title: '研究报告',
    text,
    paragraphCount: 1,
    characterCount: text.length,
  }
}

export function initializeDefaultPlan(repository: ReportSubmissionRepository, actorId = OWNER) {
  return repository.initializePlan({ actorId, projectId: PROJECT_ID, stages: defaultStages })
}

export function receiveReadyUpload(repository: ReportSubmissionRepository, uploadId: string, actorId = OWNER) {
  const file = preparedFile(uploadId)
  repository.beginUpload({
    actorId,
    projectId: PROJECT_ID,
    uploadId,
    fileName: file.fileName,
    reservedBytes: 1024,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  repository.markParsing({ actorId, projectId: PROJECT_ID, uploadId })
  return repository.markReady({ actorId, projectId: PROJECT_ID, uploadId, file })
}

export function confirmationFor(repository: ReportSubmissionRepository, input: {
  uploadId: string
  idempotencyKey: string
  actorId?: string
  reportKind?: ReportSubmissionKind
  stageId?: string
}): ReportSubmissionConfirmation {
  const actorId = input.actorId ?? OWNER
  const workflow = repository.loadWorkflow({ actorId, projectId: PROJECT_ID })
  const stage = workflow.stages.find((item) => item.id === (input.stageId ?? 'stage-1')) ?? workflow.stages[0]
  return {
    projectId: PROJECT_ID,
    actorId,
    idempotencyKey: input.idempotencyKey,
    command: {
      uploadId: input.uploadId,
      stageId: stage.id,
      reportKind: input.reportKind ?? 'update',
      expectedPlanRevision: workflow.planRevision,
      expectedWorkflowRevision: workflow.workflowRevision,
      expectedCompletionRevision: stage.completionRevision,
      expectedCompletionReportId: stage.currentCompletionReportId ?? null,
    },
  }
}

export function count(database: DatabaseSync, sql: string, param?: string) {
  const row = param === undefined
    ? database.prepare(sql).get() as { n?: number } | undefined
    : database.prepare(sql).get(param) as { n?: number } | undefined
  return Number(row?.n ?? 0)
}

import type { DatabaseSync } from 'node:sqlite'
import { runtimeConfig } from '@/lib/config/environment'
import { createPreparedReportFiles } from '@/lib/documents/prepared-report-files'
import { ReportSubmissionRepository } from '@/lib/db/report-submission-repository'
import { ReportSubmissionOutbox } from '@/lib/db/report-submission-outbox'
import { createSubmissionStorageQuota } from '@/lib/storage/submission-quota'
import { ReportSubmissionService } from '@/modules/reports/submission-service'
import { createReportSubmissionHandlers } from '@/lib/http/report-submission-handlers'
import { createUploadRecoveryFiles } from '@/lib/documents/upload-recovery-files'
import { ReportUploadRecovery } from '@/lib/db/report-upload-recovery'

const SUBMISSION_OUTBOX_LEASE_MS = 30_000

/** Explicit composition only: the host supplies its new database and trusted session resolver. */
export function createReportSubmissionRuntime(input: {
  database: DatabaseSync
  storageRoot: string
  resolveActorId: (request: Request) => string | undefined | Promise<string | undefined>
  onUnexpectedError?: (error: unknown) => void
}) {
  const repository = new ReportSubmissionRepository({ database: input.database, quota: createSubmissionStorageQuota({ storageRoot: input.storageRoot }) })
  const recovery = new ReportUploadRecovery({database:input.database,files:createUploadRecoveryFiles({storageRoot:input.storageRoot}),storageRoot:input.storageRoot})
  const service = new ReportSubmissionService({ repository, files: createPreparedReportFiles({ storageRoot: input.storageRoot,withMutation:(id,write)=>recovery.withMutation(id,write) }),
    maxUploadBytes: runtimeConfig.report.maxUploadBytes, uploadTtlMs: runtimeConfig.storage.reservationTtlMs })
  return { repository, service, recovery,
    handlers: createReportSubmissionHandlers({ service, resolveActorId: input.resolveActorId, onUnexpectedError: input.onUnexpectedError }),
    outbox: new ReportSubmissionOutbox({ database: input.database, leaseMs: SUBMISSION_OUTBOX_LEASE_MS }),
  }
}

import type { DatabaseSync } from 'node:sqlite'
import { createReportSubmissionRuntime } from '@/lib/reports/submission-runtime'
import { SubmissionTaskRepository } from '@/lib/db/submission-task-repository'
import { SubmissionQueryRepository } from '@/lib/db/submission-query-repository'
import { SubmissionWorker } from '@/worker/submission-runtime'
import { assertSubmissionTaskSchema } from '@/lib/db/submission-task-schema'

/** One native report model. Host supplies an explicitly initialized P3 database; no old task adapters. */
export function createSubmissionProcessingRuntime(input: {
  database: DatabaseSync
  storageRoot: string
  resolveActorId: (request: Request) => string | undefined | Promise<string | undefined>
  onUnexpectedError?: (error: unknown) => void
  onWorkerError?: (code: string) => void
  maintainStorage?: () => Promise<unknown>
}) {
  assertSubmissionTaskSchema(input.database)
  const submissions = createReportSubmissionRuntime(input)
  const tasks = new SubmissionTaskRepository(input)
  const queries = new SubmissionQueryRepository({database:input.database,tasks})
  return {...submissions,tasks,queries,
    worker:new SubmissionWorker({tasks,outbox:submissions.outbox,recovery:submissions.recovery,onError:input.onWorkerError,maintainStorage:input.maintainStorage}),
  }
}

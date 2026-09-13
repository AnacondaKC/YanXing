import type { DatabaseSync } from 'node:sqlite'
import type { AuthUser } from '@/lib/auth/session'
import { getRequestUser } from '@/lib/auth/request'
import { getDatabase } from '@/lib/db/client'
import { isNativeSchemaError, publicNativeSchemaFailure } from '@/lib/db/native-schema-error'
import { SubmissionWorkspaceRepository } from '@/lib/db/submission-workspace-repository'
import { createSubmissionWorkspaceHandlers } from '@/lib/http/submission-workspace-handlers'
import { logUnexpectedError } from '@/lib/http/public-error'
import { createSubmissionProcessingRuntime } from '@/lib/reports/submission-processing-runtime'
import { getReportStorageRoot } from '@/lib/storage/runtime-roots'

export interface SubmissionServerRuntime {
  processing: ReturnType<typeof createSubmissionProcessingRuntime>
  workspace: SubmissionWorkspaceRepository
  handlers: ReturnType<typeof createSubmissionWorkspaceHandlers>
  getCurrentUser: (request: Request) => AuthUser | undefined
}

let host: SubmissionServerRuntime | undefined

export function createSubmissionServerRuntime(input: {
  getDatabase: () => DatabaseSync
  storageRoot: string
  getCurrentUser: (request: Request) => AuthUser | undefined
}): SubmissionServerRuntime {
  const database = input.getDatabase()
  const processing = createSubmissionProcessingRuntime({
    database,
    storageRoot: input.storageRoot,
    resolveActorId: (request) => input.getCurrentUser(request)?.id,
    onUnexpectedError: (error) => logUnexpectedError('submission-server', error),
  })
  const workspace = new SubmissionWorkspaceRepository({
    database,
    tasks: processing.tasks,
    queries: processing.queries,
    reports: processing.repository,
  })
  return {
    processing,
    workspace,
    handlers: createSubmissionWorkspaceHandlers({ processing, workspace, getCurrentUser: input.getCurrentUser }),
    getCurrentUser: input.getCurrentUser,
  }
}

export function getSubmissionServerRuntime() {
  return host ??= createSubmissionServerRuntime({
    getDatabase,
    storageRoot: getReportStorageRoot(),
    getCurrentUser: getRequestUser,
  })
}

export function submissionBootstrapFailure(error: unknown) {
  if (isNativeSchemaError(error)) return Response.json(publicNativeSchemaFailure(error), { status: 503, headers: { 'Cache-Control': 'no-store' } })
  throw error
}

export async function runSubmissionRoute(handle: (runtime: SubmissionServerRuntime) => Promise<Response>) {
  try { return await handle(getSubmissionServerRuntime()) }
  catch (error) { return submissionBootstrapFailure(error) }
}

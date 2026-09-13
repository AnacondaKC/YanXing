import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { createSubmissionProcessingRuntime } from '../../lib/reports/submission-processing-runtime'

const SQLITE_BUSY_TIMEOUT_MS = 10_000

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
}

if (isMainModule()) {
  const databasePath = process.argv[2] ?? ''
  const storageRoot = process.argv[3] ?? ''
  const once = process.argv.includes('--once')
  const database = new DatabaseSync(databasePath, { timeout: SQLITE_BUSY_TIMEOUT_MS })
  database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=' + SQLITE_BUSY_TIMEOUT_MS)
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const runtime = createSubmissionProcessingRuntime({
    database,
    storageRoot,
    resolveActorId: () => undefined,
    onWorkerError: (code) => process.stderr.write('[p5-worker] ' + code + '\n'),
  })
  const run = once
    ? runtime.worker.runOnce(controller.signal)
    : runtime.worker.run(controller.signal)
  void run.finally(() => {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    database.close()
  }).catch((error: unknown) => {
    process.stderr.write('[p5-worker] ' + (error instanceof Error ? error.message : 'START_FAILED') + '\n')
    process.exitCode = 1
  })
}

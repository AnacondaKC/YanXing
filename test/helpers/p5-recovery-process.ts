import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { ReportUploadRecovery } from '../../lib/db/report-upload-recovery'
import { createUploadRecoveryFiles } from '../../lib/documents/upload-recovery-files'

const SQLITE_BUSY_TIMEOUT_MS = 10_000

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
}

if (isMainModule()) {
  const databasePath = process.argv[2] ?? ''
  const storageRoot = process.argv[3] ?? ''
  const database = new DatabaseSync(databasePath, { timeout: SQLITE_BUSY_TIMEOUT_MS })
  database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=' + SQLITE_BUSY_TIMEOUT_MS)
  const recovery = new ReportUploadRecovery({
    database,
    storageRoot,
    files: createUploadRecoveryFiles({ storageRoot }),
  })
  process.once('message', () => {
    void recovery.runBatch().then((result) => {
      process.send?.({ ok: true, result }, () => {
        database.close()
        process.disconnect()
      })
    }).catch((error: unknown) => {
      process.send?.({ ok: false, code: error instanceof Error && 'code' in error ? error.code : 'UNEXPECTED' }, () => {
        database.close()
        process.disconnect()
      })
    })
  })
  process.send?.({ ready: true })
}

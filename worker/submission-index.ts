import { DatabaseSync } from 'node:sqlite'
import { assertNoIncompleteRestore } from '../lib/storage/native-restore-guard'
import { assertNativeSchema } from '../lib/db/native-schema'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadYanXingEnv } from '../lib/config/load-env.mjs'

export async function startSubmissionWorkerCommand(args: string[]) {
  let databasePath: string | undefined, storageRoot: string | undefined
  let once = false
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--help') {
      console.log('submission-worker --database PATH --storage-root PATH [--once]\nRequires an existing explicitly initialized P3 database. No migrations or legacy task processing.')
      return
    }
    if (seen.has(flag)) throw new Error('Duplicate option: '+flag)
    seen.add(flag)
    if (flag === '--once') { once=true; continue }
    if (flag !== '--database' && flag !== '--storage-root') throw new Error('Unknown option: '+flag)
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error('Missing value for '+flag)
    if (flag === '--database') databasePath=resolve(value)
    else storageRoot=resolve(value)
  }
  if (!databasePath || !storageRoot) throw new Error('Explicit --database and --storage-root are required.')
  assertNoIncompleteRestore(databasePath)
  if (!(await stat(databasePath)).isFile()) throw new Error('Database must be an existing file.')
  loadYanXingEnv()
  const database = new DatabaseSync(databasePath)
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT',stop)
  process.once('SIGTERM',stop)
  try {
    assertNativeSchema({database,storageRoot})
    database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000')
    const {createSubmissionProcessingRuntime} = await import('../lib/reports/submission-processing-runtime')
    const runtime = createSubmissionProcessingRuntime({database,storageRoot,resolveActorId:()=>undefined,onWorkerError:code=>console.error('[submission-worker]',code)})
    if (once) console.log(JSON.stringify(await runtime.worker.runOnce(controller.signal)))
    else await runtime.worker.run(controller.signal)
  } finally {
    process.removeListener('SIGINT',stop)
    process.removeListener('SIGTERM',stop)
    database.close()
  }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  void startSubmissionWorkerCommand(process.argv.slice(2)).catch(error=>{
    console.error('[submission-worker]',error instanceof Error?error.message:'START_FAILED')
    process.exitCode=1
  })
}

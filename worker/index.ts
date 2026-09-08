import { pathToFileURL } from 'node:url'
import { loadYanXingEnv } from '../lib/config/load-env.mjs'

loadYanXingEnv()

const { startWorker, stopWorker } = await import('./runtime.ts')

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === entryPoint) {
  process.once('SIGINT', stopWorker)
  process.once('SIGTERM', stopWorker)
  void startWorker().catch((error) => {
    console.error('[yanxing-worker] fatal', error)
    process.exitCode = 1
  })
}

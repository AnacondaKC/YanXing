import { loadYanXingEnv } from '../lib/config/load-env.mjs'

loadYanXingEnv()

const { runStorageMaintenance } = await import('@/lib/storage/maintenance')

const dryRun = process.argv.includes('--dry-run')

try {
  const result = await runStorageMaintenance({ dryRun })
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} catch (error) {
  console.error('[storage-maintenance] failed', error instanceof Error ? error.message : error)
  process.exitCode = 1
}

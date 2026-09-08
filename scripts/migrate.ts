import { loadYanXingEnv } from '../lib/config/load-env.mjs'

loadYanXingEnv()

const { migrateDatabase } = await import('../lib/db/client.ts')

try {
  const result = migrateDatabase()
  console.log('[yanxing] 数据库迁移完成：v' + result.version + '，' + result.migrations.length + ' 项。')
} catch (error) {
  console.error('[yanxing] 数据库迁移失败：' + (error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
}

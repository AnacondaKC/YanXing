import { loadYanXingEnv } from '../lib/config/load-env.mjs'

loadYanXingEnv()

const { migrateDatabase, isNativeSchemaError } = await import('../lib/db/client.ts')

try {
  const result = migrateDatabase()
  console.log('[yanxing] 原生数据库已就绪：' + result.schema + ' checksum=' + result.checksum.slice(0, 12) + '。')
} catch (error) {
  console.error('[yanxing] 数据库初始化失败：' + (error instanceof Error ? error.message : String(error)))
  if (!isNativeSchemaError(error) && error instanceof Error && error.stack) {
    console.error(error.stack)
  }
  process.exitCode = 1
}

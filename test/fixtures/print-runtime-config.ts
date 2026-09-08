import { loadYanXingEnv } from '../../lib/config/load-env.mjs'

const mode = process.env.YANXING_LOAD_MODE
loadYanXingEnv({
  dir: process.cwd(),
  mode: mode === 'production' || mode === 'development' || mode === 'test' ? mode : undefined,
  forceReload: true,
})

const { runtimeConfig } = await import('../../lib/config/environment.ts')
process.stdout.write(JSON.stringify({
  nodeEnv: process.env.NODE_ENV ?? null,
  databasePath: runtimeConfig.databasePath ?? null,
  port: process.env.YANXING_PORT ?? null,
  maxUploadBytes: runtimeConfig.report.maxUploadBytes,
}))

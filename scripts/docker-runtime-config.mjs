import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseReportMaxUploadBytes, reportMaxUploadBytes } from '../lib/upload-limits.mjs'

const buildConfigPath = new URL('../.docker-build.json', import.meta.url)

export function validateDockerRuntimeConfig(buildConfig, environment = process.env) {
  const builtLimit = buildConfig?.reportMaxUploadBytes
  if (!Number.isSafeInteger(builtLimit) || builtLimit <= 0) {
    throw new Error('镜像缺少有效的上传上限构建记录，请重新构建镜像。')
  }
  const runtimeLimit = parseReportMaxUploadBytes(environment.REPORT_MAX_UPLOAD_BYTES, reportMaxUploadBytes)
  if (runtimeLimit !== builtLimit) {
    throw new Error('REPORT_MAX_UPLOAD_BYTES 与镜像构建值不一致；请使用同一配置重新构建镜像，再重建容器。')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === '--write-build-config') {
      const value = parseReportMaxUploadBytes(process.env.REPORT_MAX_UPLOAD_BYTES, reportMaxUploadBytes)
      writeFileSync(buildConfigPath, JSON.stringify({ reportMaxUploadBytes: value }) + '\n')
    } else {
      validateDockerRuntimeConfig(JSON.parse(readFileSync(buildConfigPath, 'utf8')))
    }
  } catch (error) {
    console.error('[yanxing-docker]', error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

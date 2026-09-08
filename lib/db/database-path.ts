import path from 'node:path'
import { runtimeConfig } from '@/lib/config/environment'

/** 解析唯一的 SQLite 数据库路径；相对路径始终相对于项目进程工作目录。 */
export function getDatabasePath() {
  const configuredPath = runtimeConfig.databasePath
  return configuredPath
    ? path.resolve(process.cwd(), configuredPath)
    : path.join(process.cwd(), 'storage', 'yanxing.sqlite')
}

import { pathToFileURL } from 'node:url'
import type { UserRole } from '@/lib/auth/session'
import { loadYanXingEnv } from '../lib/config/load-env.mjs'

loadYanXingEnv()

const { createOrUpdateUser } = await import('@/lib/auth/session')
const { migrateDatabase } = await import('@/lib/db/client')
const { runtimeConfig } = await import('@/lib/config/environment')

export function parseCreateUserArgs(argv: string[]): { values: Map<string, string>; error?: string } {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) continue
    const body = argument.slice(2)
    const separator = body.indexOf('=')
    let name: string
    let value: string | undefined
    if (separator >= 0) {
      name = body.slice(0, separator)
      value = body.slice(separator + 1)
    } else {
      name = body
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) {
        return { values, error: '参数 --' + name + ' 缺少值。' }
      }
      value = next
      index += 1
    }
    values.set(name, value)
  }
  return { values }
}

function isExecutedAsCli() {
  const entry = process.argv[1]
  return Boolean(entry) && import.meta.url === pathToFileURL(entry).href
}

function runCreateUserCli() {
  const parsed = parseCreateUserArgs(process.argv.slice(2))
  if (parsed.error) {
    console.error(parsed.error)
    process.exitCode = 1
    return
  }

  const args = parsed.values
  const username = args.get('username') ?? 'admin'
  const displayName = args.get('display-name') ?? '系统管理员'
  const password = runtimeConfig.adminPassword ?? args.get('password') ?? ''
  const role = (args.get('role') ?? 'admin') as UserRole

  if (args.has('password')) {
    console.warn('提示：密码通过命令行参数传入，会出现在 shell 历史记录与进程列表中；建议改用 YANXING_ADMIN_PASSWORD 环境变量。')
  }

  if (!password) {
    console.error('请通过 YANXING_ADMIN_PASSWORD 或 --password 提供密码。')
    process.exitCode = 1
  } else if (!['admin', 'researcher'].includes(role)) {
    console.error('角色必须是 admin 或 researcher。')
    process.exitCode = 1
  } else {
    try {
      migrateDatabase()
      const user = createOrUpdateUser({ username, displayName, password, role })
      console.log('用户已保存：' + user.username + ' (' + user.role + ')')
    } catch (error) {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    }
  }
}

if (isExecutedAsCli()) runCreateUserCli()

import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  DEFAULT_RELOCATION_DATABASE_PATH,
  RELOCATION_OFFLINE_WARNING,
  StorageRelocationError,
  buildStorageRelocationMappings,
  formatRelocationReport,
  openRelocationDatabase,
  relocateStoragePaths,
  type StoragePathMapping,
} from '@/lib/storage/relocate-paths'

const BOOLEAN_FLAGS = new Set(['apply', 'help'])
const VALUE_FLAGS = new Set(['from', 'to', 'map', 'database'])

export const RELOCATION_USAGE = [
  '用法: node --import tsx scripts/relocate-storage.ts --from OLD_STORAGE_ROOT [--to /app/storage] [--map OLD=NEW] [--database PATH] [--apply]',
  'Docker 用法: docker compose run --rm --no-deps migrate storage:relocate [同上参数]',
  '将 report_versions、knowledge_items、storage_allocations 的绝对 source_path 从旧存储根改写到 Docker 存储根。',
  '默认干跑并回滚事务；传入 --apply 才提交。',
  RELOCATION_OFFLINE_WARNING,
  '本工具不会执行迁移、存储维护、seed 或破坏性重置。',
].join('\n')

export type ParsedRelocateStorageArgs = {
  fromRoots: string[]
  toRoot?: string
  maps: StoragePathMapping[]
  database?: string
  apply: boolean
  help: boolean
}

export function parseRelocateStorageArgs(argv: string[]): { values: ParsedRelocateStorageArgs; error?: string } {
  const values: ParsedRelocateStorageArgs = {
    fromRoots: [],
    maps: [],
    apply: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) return failParse(values, '未知参数：' + argument)
    const body = argument.slice(2)
    if (!body) return failParse(values, '未知参数：--')
    const separator = body.indexOf('=')
    const name = separator >= 0 ? body.slice(0, separator) : body
    const attached = separator >= 0 ? body.slice(separator + 1) : undefined

    if (BOOLEAN_FLAGS.has(name)) {
      if (attached !== undefined) return failParse(values, '参数 --' + name + ' 不接受值。')
      if (name === 'apply') values.apply = true
      if (name === 'help') values.help = true
      continue
    }
    if (!VALUE_FLAGS.has(name)) return failParse(values, '未知参数：--' + name)

    let value = attached
    if (value === undefined) {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) return failParse(values, '参数 --' + name + ' 缺少值。')
      value = next
      index += 1
    }

    if (name === 'from') values.fromRoots.push(value)
    else if (name === 'to') {
      if (values.toRoot !== undefined) return failParse(values, '参数 --to 只能指定一次。')
      values.toRoot = value
    } else if (name === 'database') {
      if (values.database !== undefined) return failParse(values, '参数 --database 只能指定一次。')
      values.database = value
    } else if (name === 'map') {
      const mapped = parseMapValue(value)
      if (!mapped) return failParse(values, '参数 --map 必须是 OLD=NEW。')
      values.maps.push(mapped)
    }
  }

  return { values }
}

export function resolveRelocationDatabasePath(input: { database?: string; env?: NodeJS.ProcessEnv }) {
  const configured = input.database || input.env?.YANXING_DATABASE_PATH || DEFAULT_RELOCATION_DATABASE_PATH
  return isAbsolute(configured) ? resolve(configured) : resolve(process.cwd(), configured)
}

export function runRelocateStorageCli(
  argv: string[],
  io: { log: (message: string) => void; error: (message: string) => void; env?: NodeJS.ProcessEnv } = console,
) {
  const parsed = parseRelocateStorageArgs(argv)
  if (parsed.error) {
    io.error(parsed.error)
    io.error(RELOCATION_USAGE)
    return 1
  }
  if (parsed.values.help) {
    io.log(RELOCATION_USAGE)
    return 0
  }

  const mappings = buildStorageRelocationMappings({
    fromRoots: parsed.values.fromRoots,
    toRoot: parsed.values.toRoot,
    maps: parsed.values.maps,
  })
  if (mappings.length === 0) {
    io.error('必须提供 --from OLD_STORAGE_ROOT 或 --map OLD=NEW。')
    io.error(RELOCATION_USAGE)
    return 1
  }

  const databasePath = resolveRelocationDatabasePath({ database: parsed.values.database, env: io.env ?? process.env })
  let database
  try {
    database = openRelocationDatabase(databasePath)
    const report = relocateStoragePaths({
      database,
      mappings,
      mode: parsed.values.apply ? 'apply' : 'dry-run',
    })
    io.log(formatRelocationReport(report))
    return 0
  } catch (error) {
    io.error('[relocate-storage] ' + (error instanceof Error ? error.message : String(error)))
    if (error instanceof StorageRelocationError && error.report) {
      io.error(formatRelocationReport(error.report))
    }
    return 1
  } finally {
    try { database?.close() } catch { /* already closed */ }
  }
}

function parseMapValue(value: string): StoragePathMapping | undefined {
  const separator = value.indexOf('=')
  if (separator <= 0 || separator === value.length - 1) return undefined
  return { fromRoot: value.slice(0, separator), toRoot: value.slice(separator + 1) }
}

function failParse(values: ParsedRelocateStorageArgs, error: string) {
  return { values, error }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runRelocateStorageCli(process.argv.slice(2))
}

import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { databaseMigrations } from '@/lib/db/migrations'
import { assertSchemaContract } from '@/lib/db/schema-contract'
import { isPathWithinRoot } from '@/lib/storage/path-containment'

export const DEFAULT_RELOCATION_TARGET_ROOT = '/app/storage'
export const DEFAULT_RELOCATION_DATABASE_PATH = '/app/storage/yanxing.sqlite'
export const RELOCATION_OFFLINE_WARNING = '须先停止 Web 与 Worker。SQLite 事务不能保证其他活动进程已全部退出。'

const SQLITE_BUSY_TIMEOUT_MS = 5000
const MAX_REPORTED_UNSAFE_PATHS = 5

export type StoragePathMapping = {
  fromRoot: string
  toRoot: string
}

export type RelocationMode = 'dry-run' | 'apply'

export type RelocationTableCounts = {
  table: string
  scanned: number
  rewritten: number
  alreadyRelocated: number
  unmatched: number
}

export type RelocationReport = {
  mode: RelocationMode
  mappings: StoragePathMapping[]
  tables: RelocationTableCounts[]
  rewritten: number
  alreadyRelocated: number
  unmatched: number
  unmatchedRootHints: string[]
  committed: boolean
}

export type RelocateStoragePathsInput = {
  database: DatabaseSync
  mappings: readonly StoragePathMapping[]
  mode: RelocationMode
}

type PathRelation = {
  table: 'report_versions' | 'knowledge_items' | 'storage_allocations'
  keyColumns: readonly string[]
}

type PlannedRewrite = {
  table: PathRelation['table']
  keyColumns: readonly string[]
  keyValues: string[]
  originalPath: string
  nextPath: string
}

type RelocationPlan = {
  tables: RelocationTableCounts[]
  rewrites: PlannedRewrite[]
  unmatchedPaths: string[]
  unmatchedRootHints: string[]
  issues: string[]
}

export const STORAGE_PATH_RELATIONS: readonly PathRelation[] = [
  { table: 'report_versions', keyColumns: ['id'] },
  { table: 'knowledge_items', keyColumns: ['id'] },
  { table: 'storage_allocations', keyColumns: ['owner_type', 'owner_id'] },
]

export class StorageRelocationError extends Error {
  readonly report?: RelocationReport

  constructor(message: string, report?: RelocationReport) {
    super(message)
    this.name = 'StorageRelocationError'
    this.report = report
  }
}

export function buildStorageRelocationMappings(input: {
  fromRoots: readonly string[]
  toRoot?: string
  maps?: readonly StoragePathMapping[]
}): StoragePathMapping[] {
  const toRoot = input.toRoot ?? DEFAULT_RELOCATION_TARGET_ROOT
  return [
    ...input.fromRoots.map((fromRoot) => ({ fromRoot, toRoot })),
    ...(input.maps ?? []),
  ]
}

export function openRelocationDatabase(databasePath: string) {
  const resolvedPath = resolve(databasePath)
  const fileStat = readLstat(resolvedPath)
  if (!fileStat) throw new StorageRelocationError('数据库文件不存在：' + resolvedPath)
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new StorageRelocationError('数据库路径必须是常规文件：' + resolvedPath)
  }
  const database = new DatabaseSync(resolvedPath, { timeout: SQLITE_BUSY_TIMEOUT_MS })
  database.exec('PRAGMA busy_timeout = ' + SQLITE_BUSY_TIMEOUT_MS + ';')
  database.exec('PRAGMA foreign_keys = ON;')
  return database
}

export function relocateStoragePaths(input: RelocateStoragePathsInput): RelocationReport {
  if (input.mode !== 'dry-run' && input.mode !== 'apply') {
    throw new StorageRelocationError('改写模式无效。')
  }
  const mappings = normalizeStoragePathMappings(input.mappings)
  assertSafeTargetRoots(mappings)
  try {
    input.database.exec('BEGIN IMMEDIATE')
  } catch {
    throw new StorageRelocationError('无法取得数据库写锁，请确认 Web 与 Worker 已停止。')
  }
  try {
    assertNonMutatingSchemaChecksums(input.database)
    const plan = planRelocation(input.database, mappings)
    const report = toReport({ plan, mappings, mode: input.mode, committed: false })
    assertPlanSafe(plan, report)
    applyRewrites(input.database, plan.rewrites)
    input.database.exec(input.mode === 'apply' ? 'COMMIT' : 'ROLLBACK')
    return { ...report, committed: input.mode === 'apply' }
  } catch (error) {
    try { input.database.exec('ROLLBACK') } catch { /* transaction already closed */ }
    throw error
  }
}

export function formatRelocationReport(report: RelocationReport) {
  const header = report.committed ? '已提交路径改写。' : '干跑（未提交）。'
  const mappingLines = report.mappings.map((mapping) => '  ' + mapping.fromRoot + ' -> ' + mapping.toRoot)
  const tableLines = report.tables.map((table) => (
    table.table + ': scanned=' + table.scanned
    + ' rewritten=' + table.rewritten
    + ' already=' + table.alreadyRelocated
    + ' unmatched=' + table.unmatched
  ))
  const lines = [
    '[relocate-storage] ' + header,
    RELOCATION_OFFLINE_WARNING,
    '映射:',
    ...mappingLines,
    ...tableLines,
    '合计 rewritten=' + report.rewritten + ' already=' + report.alreadyRelocated + ' unmatched=' + report.unmatched,
  ]
  if (report.unmatchedRootHints.length) {
    lines.push('需增加 --from / --map：' + report.unmatchedRootHints.join(' '))
  }
  return lines.join('\n')
}

export function normalizeStoragePathMappings(mappings: readonly StoragePathMapping[]): StoragePathMapping[] {
  if (mappings.length === 0) {
    throw new StorageRelocationError('必须提供至少一个 --from 或 --map 存储根映射。')
  }
  const normalized = mappings.map(normalizeStoragePathMapping)
  for (const [index, mapping] of normalized.entries()) {
    for (const [otherIndex, other] of normalized.entries()) {
      if (otherIndex === index) continue
      if (rootsOverlap(mapping.fromRoot, other.fromRoot)) {
        throw new StorageRelocationError('多个源根不能相同或互相嵌套。')
      }
      if (rootsOverlap(mapping.fromRoot, other.toRoot)) {
        throw new StorageRelocationError('源根与目标根不能相同或互相嵌套。')
      }
    }
  }
  return normalized
}

function normalizeStoragePathMapping(mapping: StoragePathMapping): StoragePathMapping {
  const fromRoot = normalizeAbsoluteRoot(mapping.fromRoot, '源')
  const toRoot = normalizeAbsoluteRoot(mapping.toRoot, '目标')
  if (fromRoot === toRoot) {
    throw new StorageRelocationError('源根与目标根不能相同（禁止空操作映射）。')
  }
  if (rootsOverlap(fromRoot, toRoot)) {
    throw new StorageRelocationError('源根与目标根不能相同或互相嵌套。')
  }
  return { fromRoot, toRoot }
}

function normalizeAbsoluteRoot(value: string, label: string) {
  const trimmed = value.trim()
  if (!trimmed) throw new StorageRelocationError(label + '存储根不能为空。')
  if (trimmed.includes('\0')) throw new StorageRelocationError(label + '存储根非法。')
  if (hasTraversalSegment(trimmed)) throw new StorageRelocationError(label + '存储根不能包含路径遍历。')
  if (!isAbsolute(trimmed)) throw new StorageRelocationError(label + '存储根必须是绝对路径。')
  return resolve(trimmed)
}

function rootsOverlap(left: string, right: string) {
  return left === right || isPathWithinRoot(left, right) || isPathWithinRoot(right, left)
}

function assertSafeTargetRoots(mappings: readonly StoragePathMapping[]) {
  const roots = [...new Set(mappings.map((mapping) => mapping.toRoot))]
  for (const root of roots) {
    const rootStat = readLstat(root)
    if (!rootStat) throw new StorageRelocationError('目标存储根不存在或无法读取：' + root)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new StorageRelocationError('目标存储根必须是常规目录，不能是符号链接：' + root)
    }
  }
}

function assertNonMutatingSchemaChecksums(database: DatabaseSync) {
  const present = database.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = 'schema_migrations'
  `).get() as { present?: number } | undefined
  if (!present) {
    throw new StorageRelocationError('缺少 schema_migrations 账本；请先单独执行迁移。本工具不会迁移或重置数据库。')
  }

  let applied: Array<{ version: number; name: string; checksum: string }>
  try {
    applied = (database.prepare(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC',
    ).all() as Array<{ version: unknown; name: unknown; checksum: unknown }>).map((row) => ({
      version: Number(row.version),
      name: String(row.name),
      checksum: String(row.checksum),
    }))
  } catch {
    throw new StorageRelocationError('无法读取迁移账本；本工具不会修复或重置数据库。')
  }

  if (applied.length !== databaseMigrations.length) {
    throw new StorageRelocationError('数据库 schema 版本与当前程序不一致；请先单独执行迁移。本工具不会迁移或重置数据库。')
  }
  for (const [index, expected] of databaseMigrations.entries()) {
    const row = applied[index]
    if (!row || row.version !== expected.version || row.name !== expected.name || row.checksum !== expected.checksum) {
      throw new StorageRelocationError('数据库迁移账本 checksum 不匹配；本工具不会执行破坏性重置。')
    }
  }
  assertSchemaContract(database)
}

function planRelocation(database: DatabaseSync, mappings: readonly StoragePathMapping[]): RelocationPlan {
  const tables: RelocationTableCounts[] = []
  const rewrites: PlannedRewrite[] = []
  const unmatchedPaths: string[] = []
  const unsafeIssues: string[] = []
  const collisionIssues: string[] = []
  const rewriteDestinations = new Map<string, string>()
  let extraUnsafe = 0

  for (const relation of STORAGE_PATH_RELATIONS) {
    const counts: RelocationTableCounts = {
      table: relation.table,
      scanned: 0,
      rewritten: 0,
      alreadyRelocated: 0,
      unmatched: 0,
    }
    for (const row of readPathRows(database, relation)) {
      counts.scanned += 1
      const storedPath = readStoredPath(row.source_path, relation.table)
      const classified = classifyStoredPath(storedPath, mappings)
      if (classified.kind === 'unmatched') {
        counts.unmatched += 1
        unmatchedPaths.push(classified.path)
        continue
      }
      const targetPath = classified.kind === 'rewrite' ? classified.nextPath : classified.path
      const unsafe = describeUnsafeTarget(classified.toRoot, targetPath)
      if (unsafe) {
        if (unsafeIssues.length < MAX_REPORTED_UNSAFE_PATHS) unsafeIssues.push(unsafe)
        else extraUnsafe += 1
        continue
      }
      if (classified.kind === 'already' || classified.nextPath === storedPath) {
        counts.alreadyRelocated += 1
        continue
      }
      const previousOriginal = rewriteDestinations.get(classified.nextPath)
      if (previousOriginal && previousOriginal !== storedPath) {
        collisionIssues.push('不同源路径会改写到同一目标。')
        continue
      }
      rewriteDestinations.set(classified.nextPath, storedPath)
      rewrites.push({
        table: relation.table,
        keyColumns: relation.keyColumns,
        keyValues: readKeyValues(row, relation),
        originalPath: String(row.source_path),
        nextPath: classified.nextPath,
      })
      counts.rewritten += 1
    }
    tables.push(counts)
  }

  const issues = [...unsafeIssues]
  if (extraUnsafe > 0) issues.push('另有 ' + extraUnsafe + ' 个不安全目标未列出。')
  issues.push(...collisionIssues)

  return {
    tables,
    rewrites,
    unmatchedPaths,
    unmatchedRootHints: collectUnmatchedRootHints(unmatchedPaths),
    issues,
  }
}

function readKeyValues(row: Record<string, unknown>, relation: PathRelation) {
  return relation.keyColumns.map((column) => {
    const value = row[column]
    if (typeof value !== 'string' || !value) {
      throw new StorageRelocationError(relation.table + ' 行主键无效。')
    }
    return value
  })
}

function readPathRows(database: DatabaseSync, relation: PathRelation) {
  const sql = 'SELECT ' + [...relation.keyColumns, 'source_path'].join(', ') + ' FROM ' + relation.table
  try {
    return database.prepare(sql).all() as Array<Record<string, unknown> & { source_path?: unknown }>
  } catch {
    throw new StorageRelocationError('无法读取 ' + relation.table + '.source_path；请先单独执行迁移。本工具不会迁移或重置数据库。')
  }
}

function readStoredPath(value: unknown, table: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new StorageRelocationError(table + ' 存在空的 source_path。')
  }
  if (value.includes('\0')) throw new StorageRelocationError(table + ' 的 source_path 非法。')
  const trimmed = value.trim()
  if (!isAbsolute(trimmed)) {
    throw new StorageRelocationError(table + ' 的 source_path 必须是绝对路径。')
  }
  if (hasTraversalSegment(trimmed)) {
    throw new StorageRelocationError(table + ' 的 source_path 包含路径遍历，已拒绝改写。')
  }
  return resolve(trimmed)
}

function hasTraversalSegment(value: string) {
  return value.split(/[\\/]+/).some((segment) => segment === '..')
}

function classifyStoredPath(storedPath: string, mappings: readonly StoragePathMapping[]) {
  const rewrite = mappings.find((mapping) => isPathWithinRoot(mapping.fromRoot, storedPath))
  if (rewrite) {
    const nextPath = resolve(rewrite.toRoot, relative(rewrite.fromRoot, storedPath))
    return { kind: 'rewrite' as const, toRoot: rewrite.toRoot, path: storedPath, nextPath }
  }
  const already = mappings.find((mapping) => isPathWithinRoot(mapping.toRoot, storedPath))
  if (already) return { kind: 'already' as const, toRoot: already.toRoot, path: storedPath, nextPath: storedPath }
  return { kind: 'unmatched' as const, path: storedPath }
}

function describeUnsafeTarget(toRoot: string, targetPath: string) {
  if (!isPathWithinRoot(toRoot, targetPath)) return '目标路径不在目标根内：' + targetPath
  const fileStat = readLstat(targetPath)
  if (!fileStat) return '目标文件不存在：' + targetPath
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) return '目标不是常规文件：' + targetPath
  try {
    const realRoot = realpathSync(toRoot)
    const realParent = realpathSync(dirname(targetPath))
    if (realParent !== realRoot && !isPathWithinRoot(realRoot, realParent)) {
      return '目标路径的解析结果逃出目标根：' + targetPath
    }
  } catch {
    return '目标路径无法安全解析：' + targetPath
  }
  return undefined
}

function collectUnmatchedRootHints(paths: readonly string[]) {
  const candidates = [...new Set(paths.map(guessManagedRoot))].sort()
  return candidates.filter((root, index) => (
    candidates.every((other, otherIndex) => otherIndex === index || !isPathWithinRoot(other, root))
  ))
}

function guessManagedRoot(filePath: string) {
  const parent = dirname(filePath)
  const grandparent = dirname(parent)
  if (grandparent === parent || grandparent === resolve('/')) return parent
  return grandparent
}

function assertPlanSafe(plan: RelocationPlan, report: RelocationReport) {
  if (plan.issues.length) throw new StorageRelocationError(plan.issues.join('\n'), report)
  if (plan.unmatchedPaths.length) {
    const hints = plan.unmatchedRootHints.length
      ? ' 建议增加：' + plan.unmatchedRootHints.map((root) => '--from ' + root).join(' ')
      : ''
    throw new StorageRelocationError('有 ' + plan.unmatchedPaths.length + ' 条路径不在给定源根内，请增加 --from 或 --map。' + hints, report)
  }
}

function applyRewrites(database: DatabaseSync, rewrites: readonly PlannedRewrite[]) {
  for (const rewrite of rewrites) {
    const sql = 'UPDATE ' + rewrite.table
      + ' SET source_path = ? WHERE '
      + rewrite.keyColumns.map((column) => column + ' = ?').join(' AND ')
      + ' AND source_path = ?'
    const result = database.prepare(sql).run(rewrite.nextPath, ...rewrite.keyValues, rewrite.originalPath)
    if (Number(result.changes) !== 1) {
      throw new StorageRelocationError('路径在改写期间被其他进程修改，已中止。请停止 Web 与 Worker 后重试。')
    }
  }
}

function toReport(input: {
  plan: RelocationPlan
  mappings: readonly StoragePathMapping[]
  mode: RelocationMode
  committed: boolean
}): RelocationReport {
  return {
    mode: input.mode,
    mappings: [...input.mappings],
    tables: input.plan.tables,
    rewritten: sumTableCounts(input.plan.tables, 'rewritten'),
    alreadyRelocated: sumTableCounts(input.plan.tables, 'alreadyRelocated'),
    unmatched: sumTableCounts(input.plan.tables, 'unmatched'),
    unmatchedRootHints: input.plan.unmatchedRootHints,
    committed: input.committed,
  }
}

function sumTableCounts(tables: readonly RelocationTableCounts[], field: 'rewritten' | 'alreadyRelocated' | 'unmatched') {
  return tables.reduce((sum, table) => sum + table[field], 0)
}

function readLstat(path: string) {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}

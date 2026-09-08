import { lstatSync, realpathSync, unlinkSync, type Dirent } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { getDatabase } from '@/lib/db/client'
import { getKnowledgeStorageRoot } from '@/lib/knowledge-storage'
import { reportStorageRoot } from '@/lib/documents/report-storage'
import { isPathWithinRoot } from '@/lib/storage/path-containment'
import { expireStorageReservationsInDatabase } from '@/lib/storage/quota'
import type { StorageOwnerType } from '@/lib/storage/quota'
import { runtimeConfig } from '@/lib/config/environment'

export const DEFAULT_STORAGE_ORPHAN_GRACE_MS = 60 * 60 * 1000
const MIN_STORAGE_ORPHAN_GRACE_MS = 15 * 60 * 1000

type StorageRootKind = StorageOwnerType | 'temporary'

export type StorageMaintenanceRoots = {
  reportRoot: string
  knowledgeRoot: string
  temporaryRoot: string
}

type ManagedFile = {
  path: string
  kind: StorageRootKind
  sizeBytes: number
  mtimeMs: number
  inode?: number
}

type StorageBusinessFile = {
  ownerType: StorageOwnerType
  ownerId: string
  userId: string
  projectId: string | null
  sizeBytes: number
  fileHash: string
  sourcePath: string
  mimeType: string
  createdAt: string
}

type StorageAllocation = StorageBusinessFile & {
  updatedAt: string
}

type StorageMaintenancePlan = {
  expiredReservations: number
  allocationsCreated: number
  allocationsUpdated: number
  allocationsRemoved: number
  usageRowsUpdated: number
  candidates: ManagedFile[]
  protectedPaths: Set<string>
  activeReservationKinds: Set<StorageRootKind>
}

const DOCUMENT_TEXT_CACHE_SUFFIX = '.content.json'

type SidecarFile = ManagedFile & { sourcePath: string }

type MissingStorageRoot = {
  kind: StorageRootKind
  root: string
}

type ManagedFileScan = {
  files: ManagedFile[]
  sidecars: SidecarFile[]
  missingRoots: MissingStorageRoot[]
  complete: boolean
  errors: Array<{ path: string; message: string }>
}

export type StorageMaintenanceOptions = {
  /** 注入数据库仅供维护脚本和测试使用；默认使用应用连接。 */
  database?: DatabaseSync
  /** 维护观察时间，默认当前时间；字符串必须可解析为有效日期。 */
  now?: Date | string
  /** 只清理早于该时长的文件；默认一小时，避免碰到尚未入库的上传。 */
  orphanGraceMs?: number
  /** 仅生成 reconciliation 结果，不提交数据库或删除文件。 */
  dryRun?: boolean
  /** 注入受管目录仅供维护脚本和测试使用。 */
  roots?: Partial<StorageMaintenanceRoots>
}

export type StorageMaintenanceResult = {
  dryRun: boolean
  scannedFiles: number
  expiredReservations: number
  allocationsCreated: number
  allocationsUpdated: number
  allocationsRemoved: number
  usageRowsUpdated: number
  orphanFilesFound: number
  orphanFilesDeleted: number
  orphanFilesSkippedRecent: number
  orphanFilesSkippedProtected: number
  orphanFilesSkippedActiveReservation: number
  errors: Array<{ path: string; message: string }>
}

/**
 * 独立维护入口：先在数据库事务内清理预留、修复分配账本和 usage 汇总，
 * 再基于受管路径、inode/mtime 和 unlink 前批量刷新的数据库保护快照删除陈旧孤儿文件。
 * 文件 unlink 不持有 SQLite 写锁，避免全量清理长时间阻塞业务写入；跨进程写入仍依赖对象路径不可复用。
 */
export async function runStorageMaintenance(options: StorageMaintenanceOptions = {}): Promise<StorageMaintenanceResult> {
  const roots = resolveStorageMaintenanceRoots(options.roots)
  const timestamp = resolveTimestamp(options.now)
  const timestampMs = Date.parse(timestamp)
  const orphanGraceMs = normalizeGraceMs(options.orphanGraceMs)
  const scan = await scanManagedFiles(roots)
  // 文件 stat 不需要占用 SQLite 写锁；否则全量目录刷新会阻塞上传和业务写入。
  const refreshed = refreshManagedFiles(scan.files)
  const sidecars = refreshOptionalFiles(scan.sidecars)
  const scanErrors = [...scan.errors, ...refreshed.errors]
  const dryRun = options.dryRun === true
  const failClosed = (errors: Array<{ path: string; message: string }>): StorageMaintenanceResult => ({
    dryRun,
    scannedFiles: refreshed.files.length,
    expiredReservations: 0,
    allocationsCreated: 0,
    allocationsUpdated: 0,
    allocationsRemoved: 0,
    usageRowsUpdated: 0,
    orphanFilesFound: 0,
    orphanFilesDeleted: 0,
    orphanFilesSkippedRecent: 0,
    orphanFilesSkippedProtected: 0,
    orphanFilesSkippedActiveReservation: 0,
    errors,
  })

  const database = options.database ?? getDatabase()
  const missingRoots = resolveMissingStorageRoots(database, scan.missingRoots, timestamp)
  // 目录扫描必须完整，否则本轮不能重建账本或删除文件；部分扫描会把不可见的活跃文件误判为孤儿。
  if (!scan.complete || !refreshed.complete || missingRoots.incomplete) {
    return failClosed([...scanErrors, ...missingRoots.errors])
  }
  if (missingRoots.unusedKinds.some((kind) => storageRootHasRecords(database, kind, timestamp))) {
    return failClosed([
      ...scanErrors,
      { path: missingRoots.recheckPath, message: '未使用的缺失存储根在对账前出现了引用。' },
    ])
  }

  const plan = withImmediateTransaction(database, dryRun, () => {
    return reconcileInDatabase(database, refreshed.files, roots, timestamp)
  })

  const deletion = dryRun
    ? emptyDeletionResult()
    : deleteOrphanFiles(database, plan.candidates, plan.protectedPaths, plan.activeReservationKinds, roots, timestampMs, orphanGraceMs)
  const sidecarDeletion = dryRun
    ? emptyDeletionResult()
    : deleteOrphanSidecars(database, sidecars, plan.protectedPaths, plan.activeReservationKinds, roots, timestampMs, orphanGraceMs)

  return {
    dryRun,
    scannedFiles: refreshed.files.length,
    expiredReservations: plan.expiredReservations,
    allocationsCreated: plan.allocationsCreated,
    allocationsUpdated: plan.allocationsUpdated,
    allocationsRemoved: plan.allocationsRemoved,
    usageRowsUpdated: plan.usageRowsUpdated,
    orphanFilesFound: plan.candidates.length,
    orphanFilesDeleted: deletion.deleted + sidecarDeletion.deleted,
    orphanFilesSkippedRecent: deletion.skippedRecent + sidecarDeletion.skippedRecent,
    orphanFilesSkippedProtected: deletion.skippedProtected + sidecarDeletion.skippedProtected,
    orphanFilesSkippedActiveReservation: deletion.skippedActiveReservation + sidecarDeletion.skippedActiveReservation,
    errors: [...scanErrors, ...deletion.errors, ...sidecarDeletion.errors],
  }
}

const storageMaintenanceIntervalMs = runtimeConfig.storage.maintenanceIntervalMs
let nextStorageMaintenanceAt = 0
let storageMaintenancePromise: Promise<StorageMaintenanceResult> | undefined

/**
 * Worker 轮询入口：同一进程内合并并发调用，并按间隔执行完整维护。
 * 维护失败不会终止 Worker，下次间隔到期后自动重试。
 */
export function runStorageMaintenanceIfDue(nowMs = Date.now()): Promise<StorageMaintenanceResult> | undefined {
  if (storageMaintenancePromise) return storageMaintenancePromise
  if (!Number.isFinite(nowMs) || nowMs < nextStorageMaintenanceAt) return undefined
  nextStorageMaintenanceAt = nowMs + storageMaintenanceIntervalMs
  storageMaintenancePromise = runStorageMaintenance().finally(() => {
    storageMaintenancePromise = undefined
  })
  return storageMaintenancePromise
}

function reconcileInDatabase(database: DatabaseSync, files: ManagedFile[], roots: StorageMaintenanceRoots, timestamp: string): StorageMaintenancePlan {
  const expiredReservations = expireStorageReservationsInDatabase(database, timestamp)
  const fileByPath = new Map(files.map((file) => [file.path, file]))
  const businesses = readBusinessFiles(database)
  const allocations = readAllocations(database)
  const allocationsByKey = new Map(allocations.map((allocation) => [allocationKey(allocation.ownerType, allocation.ownerId), allocation]))
  const retainedKeys = new Set<string>()
  let allocationsCreated = 0
  let allocationsUpdated = 0

  for (const business of businesses) {
    const key = allocationKey(business.ownerType, business.ownerId)
    const existing = allocationsByKey.get(key)
    const desired = desiredAllocation(business, existing, fileByPath, roots, timestamp)
    if (!desired) continue

    retainedKeys.add(key)
    if (!existing) {
      insertAllocation(database, desired)
      allocationsCreated += 1
      continue
    }

    if (allocationChanged(existing, desired)) {
      updateAllocation(database, desired)
      allocationsUpdated += 1
    }
  }

  let allocationsRemoved = 0
  for (const allocation of allocations) {
    const key = allocationKey(allocation.ownerType, allocation.ownerId)
    if (retainedKeys.has(key)) continue
    database.prepare('DELETE FROM storage_allocations WHERE owner_type = ? AND owner_id = ?').run(allocation.ownerType, allocation.ownerId)
    allocationsRemoved += 1
  }

  const usageRowsUpdated = rebuildStorageUsage(database, timestamp)
  // 保护路径和 reservation 类型均批量快照，孤儿删除阶段不再对每个候选文件重复扫描业务表。
  const protectedPaths = readProtectedPaths(database)
  const activeReservationKinds = readActiveReservationKinds(database, timestamp)
  const candidates = files.filter((file) => !protectedPaths.has(file.path))

  return {
    expiredReservations,
    allocationsCreated,
    allocationsUpdated,
    allocationsRemoved,
    usageRowsUpdated,
    candidates,
    protectedPaths,
    activeReservationKinds,
  }
}

function desiredAllocation(
  business: StorageBusinessFile,
  existing: StorageAllocation | undefined,
  fileByPath: Map<string, ManagedFile>,
  roots: StorageMaintenanceRoots,
  timestamp: string,
): StorageAllocation | undefined {
  const businessPath = normalizedPath(business.sourcePath)
  const businessFile = businessPath && isManagedPathForOwner(businessPath, business.ownerType, roots)
    ? managedFileAtPath(businessPath, business.ownerType, fileByPath, roots)
    : undefined

  if (businessFile && businessFile.sizeBytes > 0) {
    const userId = existing?.userId || business.userId
    if (userId) {
      return {
        ownerType: business.ownerType,
        ownerId: business.ownerId,
        userId,
        projectId: business.projectId,
        sizeBytes: businessFile.sizeBytes,
        fileHash: business.fileHash || existing?.fileHash || 'unknown',
        sourcePath: business.sourcePath,
        mimeType: business.mimeType || existing?.mimeType || 'application/octet-stream',
        createdAt: existing?.createdAt || business.createdAt || timestamp,
        updatedAt: timestamp,
      }
    }
  }

  if (!existing) return undefined

  const allocationPath = normalizedPath(existing.sourcePath)
  if (!allocationPath) return undefined
  const allocationFile = isManagedPathForOwner(allocationPath, existing.ownerType, roots)
    ? managedFileAtPath(allocationPath, existing.ownerType, fileByPath, roots)
    : undefined

  // 账本指向受管目录且文件仍存在时保留它，即使业务行的路径暂时缺失；
  // 外部路径也不触碰，避免维护任务把未知来源的活跃文件当成孤儿。
  if (!isManagedPathForOwner(allocationPath, existing.ownerType, roots) || (allocationFile && allocationFile.sizeBytes > 0)) {
    return {
      ...existing,
      sizeBytes: allocationFile?.sizeBytes ?? existing.sizeBytes,
      updatedAt: timestamp,
    }
  }

  return undefined
}

function managedFileAtPath(
  filePath: string,
  ownerType: StorageOwnerType,
  fileByPath: Map<string, ManagedFile>,
  roots: StorageMaintenanceRoots,
): ManagedFile | undefined {
  const scanned = fileByPath.get(filePath)
  if (scanned) return scanned

  // 上传可能在目录扫描后、数据库事务前完成；在事务内补一次定点 stat，避免丢失 allocation。
  try {
    const fileStat = lstatSync(filePath)
    if (!fileStat.isFile() || !isManagedPathForOwner(filePath, ownerType, roots)) return undefined
    return {
      path: filePath,
      kind: ownerType,
      sizeBytes: safeInteger(fileStat.size),
      mtimeMs: fileStat.mtimeMs,
      inode: fileStat.ino,
    }
  } catch {
    return undefined
  }
}

function readBusinessFiles(database: DatabaseSync): StorageBusinessFile[] {
  const reports = database.prepare("SELECT report.id AS owner_id, COALESCE((SELECT user_id FROM project_members WHERE project_id = report.project_id AND role = 'owner' LIMIT 1), '') AS user_id, report.project_id, report.source_size AS size_bytes, report.file_hash, report.source_path, report.mime_type, report.created_at FROM report_versions report").all() as Array<Record<string, unknown>>
  const knowledge = database.prepare("SELECT id AS owner_id, uploaded_by_user_id AS user_id, NULL AS project_id, file_size AS size_bytes, file_hash, source_path, file_name, created_at FROM knowledge_items").all() as Array<Record<string, unknown>>

  return [
    ...reports.map((row) => ({
      ownerType: 'report' as const,
      ownerId: text(row.owner_id),
      userId: text(row.user_id),
      projectId: nullableText(row.project_id),
      sizeBytes: safeInteger(row.size_bytes),
      fileHash: text(row.file_hash),
      sourcePath: text(row.source_path),
      mimeType: text(row.mime_type),
      createdAt: text(row.created_at),
    })),
    ...knowledge.map((row) => ({
      ownerType: 'knowledge' as const,
      ownerId: text(row.owner_id),
      userId: text(row.user_id),
      projectId: null,
      sizeBytes: safeInteger(row.size_bytes),
      fileHash: text(row.file_hash),
      sourcePath: text(row.source_path),
      mimeType: mimeTypeForFileName(text(row.file_name)),
      createdAt: text(row.created_at),
    })),
  ].filter((file) => Boolean(file.ownerId && file.sourcePath))
}

function readAllocations(database: DatabaseSync): StorageAllocation[] {
  const rows = database.prepare('SELECT owner_type, owner_id, user_id, project_id, size_bytes, file_hash, source_path, mime_type, created_at, updated_at FROM storage_allocations').all() as Array<Record<string, unknown>>
  return rows.flatMap((row) => {
    const ownerType = row.owner_type === 'report' || row.owner_type === 'knowledge' ? row.owner_type : undefined
    const ownerId = text(row.owner_id)
    const sourcePath = text(row.source_path)
    if (!ownerType || !ownerId || !sourcePath) return []
    return [{
      ownerType,
      ownerId,
      userId: text(row.user_id),
      projectId: nullableText(row.project_id),
      sizeBytes: safeInteger(row.size_bytes),
      fileHash: text(row.file_hash),
      sourcePath,
      mimeType: text(row.mime_type),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
    }]
  })
}

function insertAllocation(database: DatabaseSync, allocation: StorageAllocation) {
  database.prepare('INSERT INTO storage_allocations(owner_type, owner_id, user_id, project_id, size_bytes, file_hash, source_path, mime_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    allocation.ownerType,
    allocation.ownerId,
    allocation.userId,
    allocation.projectId,
    allocation.sizeBytes,
    allocation.fileHash,
    allocation.sourcePath,
    allocation.mimeType,
    allocation.createdAt,
    allocation.updatedAt,
  )
}

function updateAllocation(database: DatabaseSync, allocation: StorageAllocation) {
  database.prepare('UPDATE storage_allocations SET user_id = ?, project_id = ?, size_bytes = ?, file_hash = ?, source_path = ?, mime_type = ?, updated_at = ? WHERE owner_type = ? AND owner_id = ?').run(
    allocation.userId,
    allocation.projectId,
    allocation.sizeBytes,
    allocation.fileHash,
    allocation.sourcePath,
    allocation.mimeType,
    allocation.updatedAt,
    allocation.ownerType,
    allocation.ownerId,
  )
}

function allocationChanged(current: StorageAllocation, desired: StorageAllocation) {
  return current.userId !== desired.userId
    || current.projectId !== desired.projectId
    || current.sizeBytes !== desired.sizeBytes
    || current.fileHash !== desired.fileHash
    || current.sourcePath !== desired.sourcePath
    || current.mimeType !== desired.mimeType
}

function rebuildStorageUsage(database: DatabaseSync, timestamp: string) {
  const desired = new Map<string, { usedBytes: number; itemCount: number; reservedBytes: number; reservedCount: number }>()
  const add = (scopeType: 'global' | 'user' | 'project', scopeId: string, values: { usedBytes?: number; itemCount?: number; reservedBytes?: number; reservedCount?: number }) => {
    const key = scopeKey(scopeType, scopeId)
    const current = desired.get(key) ?? { usedBytes: 0, itemCount: 0, reservedBytes: 0, reservedCount: 0 }
    current.usedBytes += values.usedBytes ?? 0
    current.itemCount += values.itemCount ?? 0
    current.reservedBytes += values.reservedBytes ?? 0
    current.reservedCount += values.reservedCount ?? 0
    if (!Number.isSafeInteger(current.usedBytes) || !Number.isSafeInteger(current.itemCount) || !Number.isSafeInteger(current.reservedBytes) || !Number.isSafeInteger(current.reservedCount)) {
      throw new Error('存储配额汇总超出安全整数范围。')
    }
    desired.set(key, current)
  }

  add('global', 'global', {})
  for (const allocation of readAllocations(database)) {
    add('global', 'global', { usedBytes: allocation.sizeBytes, itemCount: 1 })
    add('user', allocation.userId, { usedBytes: allocation.sizeBytes, itemCount: 1 })
    if (allocation.projectId) add('project', allocation.projectId, { usedBytes: allocation.sizeBytes, itemCount: 1 })
  }
  const reservations = database.prepare("SELECT user_id, project_id, expected_bytes FROM storage_reservations WHERE state = 'active' AND expires_at > ?").all(timestamp) as Array<{ user_id?: unknown; project_id?: unknown; expected_bytes?: unknown }>
  for (const reservation of reservations) {
    const userId = text(reservation.user_id)
    const projectId = nullableText(reservation.project_id)
    const expectedBytes = safeInteger(reservation.expected_bytes)
    add('global', 'global', { reservedBytes: expectedBytes, reservedCount: 1 })
    add('user', userId, { reservedBytes: expectedBytes, reservedCount: 1 })
    if (projectId) add('project', projectId, { reservedBytes: expectedBytes, reservedCount: 1 })
  }

  for (const key of desired.keys()) {
    const [scopeType, scopeId] = splitScopeKey(key)
    database.prepare('INSERT OR IGNORE INTO storage_usage(scope_type, scope_id, updated_at) VALUES (?, ?, ?)').run(scopeType, scopeId, timestamp)
  }

  const existingRows = database.prepare('SELECT scope_type, scope_id, used_bytes, item_count, reserved_bytes, reserved_count FROM storage_usage').all() as Array<Record<string, unknown>>
  let changed = 0
  for (const row of existingRows) {
    const scopeType = row.scope_type === 'global' || row.scope_type === 'user' || row.scope_type === 'project' ? row.scope_type : undefined
    const scopeId = text(row.scope_id)
    if (!scopeType || !scopeId) continue
    const target = desired.get(scopeKey(scopeType, scopeId)) ?? { usedBytes: 0, itemCount: 0, reservedBytes: 0, reservedCount: 0 }
    const current = {
      usedBytes: safeInteger(row.used_bytes),
      itemCount: safeInteger(row.item_count),
      reservedBytes: safeInteger(row.reserved_bytes),
      reservedCount: safeInteger(row.reserved_count),
    }
    if (current.usedBytes === target.usedBytes && current.itemCount === target.itemCount && current.reservedBytes === target.reservedBytes && current.reservedCount === target.reservedCount) continue
    database.prepare('UPDATE storage_usage SET used_bytes = ?, item_count = ?, reserved_bytes = ?, reserved_count = ?, revision = revision + 1, updated_at = ? WHERE scope_type = ? AND scope_id = ?').run(target.usedBytes, target.itemCount, target.reservedBytes, target.reservedCount, timestamp, scopeType, scopeId)
    changed += 1
  }
  return changed
}

function deleteOrphanFiles(
  database: DatabaseSync,
  candidates: ManagedFile[],
  protectedPaths: Set<string>,
  activeReservationKinds: Set<StorageRootKind>,
  roots: StorageMaintenanceRoots,
  timestampMs: number,
  orphanGraceMs: number,
) {
  const result = emptyDeletionResult()
  const cutoffMs = timestampMs - orphanGraceMs
  const eligibleCandidates: ManagedFile[] = []

  // 先完成文件系统侧的批量筛选，避免在数据库保护查询期间持有写锁。
  for (const candidate of candidates) {
    try {
      if (!isSafeManagedFilePath(candidate.path, candidate.kind, roots)) {
        result.skippedProtected += 1
        continue
      }
      const current = safeLstat(candidate.path)
      if (!current || !current.isFile()) continue
      if (current.mtimeMs >= cutoffMs || current.size !== candidate.sizeBytes || (candidate.inode !== undefined && current.ino !== candidate.inode)) {
        result.skippedRecent += 1
        continue
      }
      if (protectedPaths.has(candidate.path)) {
        result.skippedProtected += 1
        continue
      }
      if (activeReservationKinds.has(candidate.kind)) {
        result.skippedActiveReservation += 1
        continue
      }
      eligibleCandidates.push(candidate)
    } catch (error) {
      if (!isMissingFileError(error)) result.errors.push({ path: candidate.path, message: error instanceof Error ? error.message : String(error) })
    }
  }

  // 在最终 unlink 批次前批量刷新保护路径和 reservation 类型；候选循环不再重复全表查询。
  const freshProtectedPaths = readProtectedPaths(database)
  const freshActiveReservationKinds = readActiveReservationKinds(database, new Date(timestampMs).toISOString())
  // 快照后到 unlink 之间仍可能有跨进程提交；上传使用不可复用随机路径，且最小宽限期覆盖上传总时限，作为该无锁窗口的边界。
  for (const candidate of eligibleCandidates) {
    try {
      if (freshProtectedPaths.has(candidate.path)) {
        result.skippedProtected += 1
        continue
      }
      if (freshActiveReservationKinds.has(candidate.kind)) {
        result.skippedActiveReservation += 1
        continue
      }
      if (!isSafeManagedFilePath(candidate.path, candidate.kind, roots)) {
        result.skippedProtected += 1
        continue
      }
      const current = safeLstat(candidate.path)
      if (!current || !current.isFile()) continue
      if (current.mtimeMs >= cutoffMs || current.size !== candidate.sizeBytes || (candidate.inode !== undefined && current.ino !== candidate.inode)) {
        result.skippedRecent += 1
        continue
      }

      // 上传路径使用随机 ID，且宽限期与 inode/size 校验共同避免误删刚入库文件。
      // reservation 表没有 path，只能按既有 owner_type 语义保护该类型的所有孤儿候选。
      unlinkSync(candidate.path)
      result.deleted += 1
    } catch (error) {
      if (isMissingFileError(error)) continue
      result.errors.push({ path: candidate.path, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

function deleteOrphanSidecars(
  database: DatabaseSync,
  sidecars: SidecarFile[],
  protectedPaths: Set<string>,
  activeReservationKinds: Set<StorageRootKind>,
  roots: StorageMaintenanceRoots,
  timestampMs: number,
  orphanGraceMs: number,
) {
  const result = emptyDeletionResult()
  const cutoffMs = timestampMs - orphanGraceMs
  const eligible: SidecarFile[] = []

  for (const sidecar of sidecars) {
    try {
      if (!isSafeManagedFilePath(sidecar.path, sidecar.kind, roots)) {
        result.skippedProtected += 1
        continue
      }
      if (protectedPaths.has(sidecar.sourcePath) || safeLstat(sidecar.sourcePath)?.isFile()) continue
      const current = safeLstat(sidecar.path)
      if (!current || !current.isFile()) continue
      if (current.mtimeMs >= cutoffMs || current.size !== sidecar.sizeBytes || (sidecar.inode !== undefined && current.ino !== sidecar.inode)) {
        result.skippedRecent += 1
        continue
      }
      if (activeReservationKinds.has(sidecar.kind)) {
        result.skippedActiveReservation += 1
        continue
      }
      eligible.push(sidecar)
    } catch (error) {
      if (!isMissingFileError(error)) result.errors.push({ path: sidecar.path, message: error instanceof Error ? error.message : String(error) })
    }
  }

  const freshProtectedPaths = readProtectedPaths(database)
  const freshActiveReservationKinds = readActiveReservationKinds(database, new Date(timestampMs).toISOString())
  for (const sidecar of eligible) {
    try {
      if (freshProtectedPaths.has(sidecar.sourcePath) || safeLstat(sidecar.sourcePath)?.isFile()) continue
      if (freshActiveReservationKinds.has(sidecar.kind)) {
        result.skippedActiveReservation += 1
        continue
      }
      if (!isSafeManagedFilePath(sidecar.path, sidecar.kind, roots)) {
        result.skippedProtected += 1
        continue
      }
      const current = safeLstat(sidecar.path)
      if (!current || !current.isFile()) continue
      if (current.mtimeMs >= cutoffMs || current.size !== sidecar.sizeBytes || (sidecar.inode !== undefined && current.ino !== sidecar.inode)) {
        result.skippedRecent += 1
        continue
      }
      unlinkSync(sidecar.path)
      result.deleted += 1
    } catch (error) {
      if (isMissingFileError(error)) continue
      result.errors.push({ path: sidecar.path, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

function readProtectedPaths(database: DatabaseSync) {
  const paths = new Set<string>()
  const rows = database.prepare('SELECT source_path FROM report_versions UNION ALL SELECT source_path FROM knowledge_items UNION ALL SELECT source_path FROM storage_allocations').all() as Array<{ source_path?: unknown }>
  for (const row of rows) {
    const path = normalizedPath(row.source_path)
    if (path) paths.add(path)
  }
  return paths
}

function readActiveReservationKinds(database: DatabaseSync, timestamp: string): Set<StorageRootKind> {
  const kinds = new Set<StorageRootKind>()
  const rows = database.prepare("SELECT DISTINCT owner_type FROM storage_reservations WHERE state = 'active' AND expires_at > ?").all(timestamp) as Array<{ owner_type?: unknown }>
  for (const row of rows) {
    if (row.owner_type === 'report' || row.owner_type === 'knowledge') kinds.add(row.owner_type)
  }
  return kinds
}

async function scanManagedFiles(roots: StorageMaintenanceRoots): Promise<ManagedFileScan> {
  const scan: ManagedFileScan = { files: [], sidecars: [], missingRoots: [], complete: true, errors: [] }
  for (const [kind, root] of [
    ['report', roots.reportRoot],
    ['knowledge', roots.knowledgeRoot],
    ['temporary', roots.temporaryRoot],
  ] as const) {
    try {
      const rootStat = await lstat(root)
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        scan.complete = false
        scan.errors.push({ path: root, message: '存储根目录不是安全的常规目录。' })
        continue
      }
    } catch (error) {
      if (isMissingFileError(error)) {
        scan.missingRoots.push({ kind, root })
        continue
      }
      scan.complete = false
      scan.errors.push({ path: root, message: '存储根目录无法读取：' + errorMessage(error) })
      continue
    }
    if (!await scanRoot(root, kind, scan)) scan.complete = false
  }
  return scan
}

async function scanRoot(root: string, kind: StorageRootKind, scan: ManagedFileScan) {
  const pending = [root]
  let complete = true
  while (pending.length) {
    const directory = pending.pop()!
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true }) as unknown as Dirent[]
    } catch (error) {
      complete = false
      scan.errors.push({ path: directory, message: '存储目录无法读取：' + errorMessage(error) })
      continue
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        try {
          const directoryStat = await lstat(path)
          if (directoryStat.isDirectory() && !directoryStat.isSymbolicLink()) pending.push(path)
        } catch (error) {
          complete = false
          scan.errors.push({ path, message: '存储子目录无法读取：' + errorMessage(error) })
        }
        continue
      }
      if (!entry.isFile() || (kind === 'temporary' && !entry.name.endsWith('.upload') && !entry.name.endsWith(DOCUMENT_TEXT_CACHE_SUFFIX))) continue
      let fileStat
      try {
        fileStat = await lstat(path)
      } catch (error) {
        complete = false
        scan.errors.push({ path, message: '存储文件无法读取：' + errorMessage(error) })
        continue
      }
      if (!fileStat.isFile()) {
        complete = false
        scan.errors.push({ path, message: '存储文件类型在扫描期间发生变化。' })
        continue
      }
      const resolvedPath = resolve(path)
      const managedFile = {
        path: resolvedPath,
        kind,
        sizeBytes: safeInteger(fileStat.size),
        mtimeMs: fileStat.mtimeMs,
        inode: fileStat.ino,
      }
      if (entry.name.endsWith(DOCUMENT_TEXT_CACHE_SUFFIX)) {
        const sourcePath = resolvedPath.slice(0, -DOCUMENT_TEXT_CACHE_SUFFIX.length)
        if (sourcePath && sourcePath !== resolvedPath) scan.sidecars.push({ ...managedFile, sourcePath })
        continue
      }
      scan.files.push(managedFile)
    }
  }
  return complete
}

function refreshOptionalFiles<T extends ManagedFile>(files: T[]): T[] {
  const refreshed: T[] = []
  for (const file of files) {
    const fileStat = safeLstat(file.path)
    if (!fileStat?.isFile()) continue
    refreshed.push({
      ...file,
      sizeBytes: safeInteger(fileStat.size),
      mtimeMs: fileStat.mtimeMs,
      inode: fileStat.ino,
    })
  }
  return refreshed
}

function resolveMissingStorageRoots(
  database: DatabaseSync,
  missingRoots: readonly MissingStorageRoot[],
  timestamp: string,
) {
  const errors: Array<{ path: string; message: string }> = []
  const unusedKinds: StorageRootKind[] = []
  let incomplete = false
  let recheckPath = ''
  for (const missing of missingRoots) {
    if (!isSafeUnusedMissingRootParent(missing.root) || storageRootHasRecords(database, missing.kind, timestamp)) {
      incomplete = true
      errors.push({ path: missing.root, message: '存储根目录无法读取：ENOENT' })
      continue
    }
    unusedKinds.push(missing.kind)
    if (!recheckPath) recheckPath = missing.root
  }
  return { incomplete, errors, unusedKinds, recheckPath }
}

function storageRootHasRecords(database: DatabaseSync, kind: StorageRootKind, timestamp: string) {
  if (kind === 'temporary') return false
  const businessCount = kind === 'report'
    ? (database.prepare('SELECT COUNT(*) AS count FROM report_versions').get() as { count: number }).count
    : (database.prepare('SELECT COUNT(*) AS count FROM knowledge_items').get() as { count: number }).count
  const allocationCount = (database.prepare('SELECT COUNT(*) AS count FROM storage_allocations WHERE owner_type = ?').get(kind) as { count: number }).count
  const reservationCount = (database.prepare(
    "SELECT COUNT(*) AS count FROM storage_reservations WHERE owner_type = ? AND state = 'active' AND expires_at > ?",
  ).get(kind, timestamp) as { count: number }).count
  return businessCount > 0 || allocationCount > 0 || reservationCount > 0
}

function isSafeUnusedMissingRootParent(root: string) {
  try {
    const parentStat = lstatSync(dirname(root))
    return parentStat.isDirectory() && !parentStat.isSymbolicLink()
  } catch {
    return false
  }
}

function refreshManagedFiles(files: ManagedFile[]): ManagedFileScan {
  const refreshed: ManagedFileScan = { files: [], sidecars: [], missingRoots: [], complete: true, errors: [] }
  for (const file of files) {
    let fileStat
    try {
      fileStat = lstatSync(file.path)
    } catch (error) {
      refreshed.complete = false
      refreshed.errors.push({ path: file.path, message: '存储文件在维护前无法确认：' + errorMessage(error) })
      continue
    }
    if (!fileStat.isFile()) {
      refreshed.complete = false
      refreshed.errors.push({ path: file.path, message: '存储文件类型在维护前发生变化。' })
      continue
    }
    refreshed.files.push({
      ...file,
      sizeBytes: safeInteger(fileStat.size),
      mtimeMs: fileStat.mtimeMs,
      inode: fileStat.ino,
    })
  }
  return refreshed
}

function resolveStorageMaintenanceRoots(input: Partial<StorageMaintenanceRoots> | undefined): StorageMaintenanceRoots {
  const roots: StorageMaintenanceRoots = {
    reportRoot: resolve(input?.reportRoot ?? reportStorageRoot),
    knowledgeRoot: resolve(input?.knowledgeRoot ?? getKnowledgeStorageRoot()),
    temporaryRoot: resolve(input?.temporaryRoot ?? join(dirname(reportStorageRoot), 'tmp')),
  }
  const values = Object.values(roots)
  if (new Set(values).size !== values.length || values.some((root, index) => values.some((other, otherIndex) => index !== otherIndex && isPathWithinRoot(root, other)))) {
    throw new Error('存储维护目录不能重复或互相嵌套。')
  }
  return roots
}

function isManagedPathForOwner(path: string, ownerType: StorageOwnerType, roots: StorageMaintenanceRoots) {
  return isPathWithinRoot(ownerType === 'report' ? roots.reportRoot : roots.knowledgeRoot, path)
}

function isSafeManagedFilePath(path: string, kind: StorageRootKind, roots: StorageMaintenanceRoots) {
  const root = kind === 'report' ? roots.reportRoot : kind === 'knowledge' ? roots.knowledgeRoot : roots.temporaryRoot
  if (!isPathWithinRoot(root, path)) return false
  try {
    const realRoot = realpathSync(root)
    const realParent = realpathSync(dirname(path))
    return realParent === realRoot || isPathWithinRoot(realRoot, realParent)
  } catch {
    return false
  }
}

function normalizedPath(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    return resolve(value)
  } catch {
    return undefined
  }
}

function allocationKey(ownerType: StorageOwnerType, ownerId: string) {
  return ownerType + '\u0000' + ownerId
}

function scopeKey(scopeType: string, scopeId: string) {
  return scopeType + '\u0000' + scopeId
}

function splitScopeKey(key: string): [string, string] {
  const separator = key.indexOf('\u0000')
  return separator < 0 ? [key, ''] : [key.slice(0, separator), key.slice(separator + 1)]
}

function mimeTypeForFileName(fileName: string) {
  return fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
}

function text(value: unknown) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
}

function nullableText(value: unknown) {
  const valueText = text(value)
  return valueText ? valueText : null
}

function safeInteger(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : 0
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : String(error)
}

function resolveTimestamp(value: Date | string | undefined) {
  const timestamp = value instanceof Date ? value : value ? new Date(value) : new Date()
  if (!Number.isFinite(timestamp.getTime())) throw new Error('存储维护时间无效。')
  return timestamp.toISOString()
}

function normalizeGraceMs(value: number | undefined) {
  const graceMs = value ?? DEFAULT_STORAGE_ORPHAN_GRACE_MS
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw new Error('存储孤儿文件宽限期必须是非负安全整数。')
  return Math.max(graceMs, MIN_STORAGE_ORPHAN_GRACE_MS)
}

function withImmediateTransaction<T>(database: DatabaseSync, dryRun: boolean, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    database.exec(dryRun ? 'ROLLBACK' : 'COMMIT')
    return result
  } catch (error) {
    rollback(database)
    throw error
  }
}

function rollback(database: DatabaseSync) {
  try { database.exec('ROLLBACK') } catch { /* transaction already closed */ }
}

function safeLstat(path: string) {
  try { return lstatSync(path) } catch { return undefined }
}

function isMissingFileError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT')
}

function emptyDeletionResult() {
  return {
    deleted: 0,
    skippedRecent: 0,
    skippedProtected: 0,
    skippedActiveReservation: 0,
    errors: [] as Array<{ path: string; message: string }>,
  }
}

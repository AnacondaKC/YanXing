import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { inImmediateTransaction } from '@/lib/db/client'
import { runtimeConfig } from '@/lib/config/environment'

export type StorageOwnerType = 'report' | 'knowledge'

type StorageScope = { scopeType: 'global' | 'user' | 'project'; scopeId: string }
export type StorageAllocationInput = {
  ownerType: StorageOwnerType
  ownerId: string
  userId: string
  projectId?: string | null
  sizeBytes: number
  fileHash: string
  sourcePath: string
  mimeType: string
}

export class StorageQuotaError extends Error {
  constructor(readonly scope: 'global' | 'user' | 'project', readonly reason: 'bytes' | 'items' | 'reservation') {
    super(reason === 'reservation' ? '存储配额预留已失效，请稍后重试。' : '存储空间配额已用尽，请删除旧文件后重试。')
    this.name = 'StorageQuotaError'
  }
}

const globalBytesLimit = runtimeConfig.storage.globalBytes
const globalItemsLimit = runtimeConfig.storage.globalItems
const userBytesLimit = runtimeConfig.storage.userBytes
const userItemsLimit = runtimeConfig.storage.userItems
const projectBytesLimit = runtimeConfig.storage.projectBytes
const projectItemsLimit = runtimeConfig.storage.projectItems
const reservationTtlMs = runtimeConfig.storage.reservationTtlMs

export function reserveStorageQuota(input: {
  userId: string
  projectId?: string | null
  expectedBytes: number
  ownerType: StorageOwnerType
}): string {
  return inImmediateTransaction((database) => reserveStorageQuotaInDatabase(database, input))
}

export function reserveStorageQuotaInDatabase(
  database: DatabaseSync,
  input: { userId: string; projectId?: string | null; expectedBytes: number; ownerType: StorageOwnerType },
): string {
  if (!input.userId || !Number.isSafeInteger(input.expectedBytes) || input.expectedBytes <= 0) {
    throw new StorageQuotaError('global', 'reservation')
  }
  expireStorageReservationsInDatabase(database, new Date().toISOString())
  const scopes = storageScopes(input.userId, input.projectId)
  for (const scope of scopes) {
    ensureUsageRow(database, scope)
    const limits = limitsFor(scope.scopeType)
    const result = database.prepare(`
      UPDATE storage_usage
      SET reserved_bytes = reserved_bytes + ?, reserved_count = reserved_count + 1,
          revision = revision + 1, updated_at = ?
      WHERE scope_type = ? AND scope_id = ?
        AND used_bytes + reserved_bytes + ? <= ?
        AND item_count + reserved_count + 1 <= ?
    `).run(input.expectedBytes, new Date().toISOString(), scope.scopeType, scope.scopeId, input.expectedBytes, limits.bytes, limits.items)
    if (Number(result.changes) !== 1) {
      const usage = database.prepare('SELECT used_bytes, item_count FROM storage_usage WHERE scope_type = ? AND scope_id = ?').get(scope.scopeType, scope.scopeId) as { used_bytes?: number; item_count?: number } | undefined
      const reason = Number(usage?.item_count ?? 0) + 1 > limits.items ? 'items' : 'bytes'
      throw new StorageQuotaError(scope.scopeType, reason)
    }
  }
  const id = 'storage-reservation-' + randomUUID()
  const timestamp = new Date().toISOString()
  database.prepare(`
    INSERT INTO storage_reservations(id, user_id, project_id, expected_bytes, owner_type, expires_at, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(id, input.userId, input.projectId ?? null, input.expectedBytes, input.ownerType, new Date(Date.now() + reservationTtlMs).toISOString(), timestamp, timestamp)
  return id
}

export function releaseStorageReservation(reservationId: string) {
  return inImmediateTransaction((database) => releaseStorageReservationInDatabase(database, reservationId, 'released'))
}

export function releaseStorageReservationInDatabase(
  database: DatabaseSync,
  reservationId: string,
  state: 'released' | 'expired' = 'released',
  timestamp = new Date().toISOString(),
) {
  const row = database.prepare(`
    SELECT user_id, project_id, expected_bytes
    FROM storage_reservations
    WHERE id = ? AND state = 'active'
  `).get(reservationId) as { user_id: string; project_id: string | null; expected_bytes: number } | undefined
  if (!row) return false
  for (const scope of storageScopes(row.user_id, row.project_id)) {
    ensureUsageRow(database, scope)
    database.prepare(`
      UPDATE storage_usage
      SET reserved_bytes = MAX(0, reserved_bytes - ?), reserved_count = MAX(0, reserved_count - 1),
          revision = revision + 1, updated_at = ?
      WHERE scope_type = ? AND scope_id = ?
    `).run(row.expected_bytes, timestamp, scope.scopeType, scope.scopeId)
  }
  const result = database.prepare("UPDATE storage_reservations SET state = ?, updated_at = ? WHERE id = ? AND state = 'active'").run(state, timestamp, reservationId)
  return Number(result.changes) === 1
}

export function consumeStorageReservationInDatabase(database: DatabaseSync, reservationId: string, allocation: StorageAllocationInput) {
  const row = database.prepare(`
    SELECT user_id, project_id, expected_bytes, owner_type
    FROM storage_reservations
    WHERE id = ? AND state = 'active' AND expires_at > ?
  `).get(reservationId, new Date().toISOString()) as { user_id: string; project_id: string | null; expected_bytes: number; owner_type: StorageOwnerType } | undefined
  if (!row || row.owner_type !== allocation.ownerType || row.user_id !== allocation.userId || (row.project_id ?? null) !== (allocation.projectId ?? null) || !Number.isSafeInteger(allocation.sizeBytes) || allocation.sizeBytes <= 0 || allocation.sizeBytes > row.expected_bytes) {
    throw new StorageQuotaError('global', 'reservation')
  }
  const timestamp = new Date().toISOString()
  for (const scope of storageScopes(row.user_id, row.project_id)) {
    ensureUsageRow(database, scope)
    database.prepare(`
      UPDATE storage_usage
      SET used_bytes = used_bytes + ?, item_count = item_count + 1,
          reserved_bytes = MAX(0, reserved_bytes - ?), reserved_count = MAX(0, reserved_count - 1),
          revision = revision + 1, updated_at = ?
      WHERE scope_type = ? AND scope_id = ?
    `).run(allocation.sizeBytes, row.expected_bytes, timestamp, scope.scopeType, scope.scopeId)
  }
  database.prepare(`
    INSERT INTO storage_allocations(owner_type, owner_id, user_id, project_id, size_bytes, file_hash, source_path, mime_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(allocation.ownerType, allocation.ownerId, allocation.userId, allocation.projectId ?? null, allocation.sizeBytes, allocation.fileHash, allocation.sourcePath, allocation.mimeType, timestamp, timestamp)
  database.prepare("UPDATE storage_reservations SET state = 'consumed', updated_at = ? WHERE id = ? AND state = 'active'").run(timestamp, reservationId)
}

export function releaseStorageAllocationInDatabase(database: DatabaseSync, ownerType: StorageOwnerType, ownerId: string) {
  const row = database.prepare(`
    SELECT user_id, project_id, size_bytes
    FROM storage_allocations
    WHERE owner_type = ? AND owner_id = ?
  `).get(ownerType, ownerId) as { user_id: string; project_id: string | null; size_bytes: number } | undefined
  if (!row) return false
  const timestamp = new Date().toISOString()
  for (const scope of storageScopes(row.user_id, row.project_id)) {
    ensureUsageRow(database, scope)
    database.prepare(`
      UPDATE storage_usage
      SET used_bytes = MAX(0, used_bytes - ?), item_count = MAX(0, item_count - 1),
          revision = revision + 1, updated_at = ?
      WHERE scope_type = ? AND scope_id = ?
    `).run(row.size_bytes, timestamp, scope.scopeType, scope.scopeId)
  }
  database.prepare('DELETE FROM storage_allocations WHERE owner_type = ? AND owner_id = ?').run(ownerType, ownerId)
  return true
}

export function expireStorageReservationsInDatabase(database: DatabaseSync, timestamp: string) {
  const rows = database.prepare(`
    SELECT id FROM storage_reservations
    WHERE state = 'active' AND expires_at <= ?
  `).all(timestamp) as Array<{ id: string }>
  let count = 0
  for (const row of rows) if (releaseStorageReservationInDatabase(database, row.id, 'expired', timestamp)) count += 1
  return count
}

function storageScopes(userId: string, projectId?: string | null): StorageScope[] {
  const scopes: StorageScope[] = [{ scopeType: 'global', scopeId: 'global' }, { scopeType: 'user', scopeId: userId }]
  if (projectId) scopes.push({ scopeType: 'project', scopeId: projectId })
  return scopes
}

function ensureUsageRow(database: DatabaseSync, scope: StorageScope) {
  database.prepare(`
    INSERT OR IGNORE INTO storage_usage(scope_type, scope_id, updated_at)
    VALUES (?, ?, ?)
  `).run(scope.scopeType, scope.scopeId, new Date().toISOString())
}

function limitsFor(scopeType: StorageScope['scopeType']) {
  if (scopeType === 'global') return { bytes: globalBytesLimit, items: globalItemsLimit }
  if (scopeType === 'user') return { bytes: userBytesLimit, items: userItemsLimit }
  return { bytes: projectBytesLimit, items: projectItemsLimit }
}

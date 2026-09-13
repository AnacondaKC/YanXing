import { rm } from 'node:fs/promises'
import type { SessionUser as AuthUser } from '@/modules/users/domain'
import { ReportAuthorizationChangedError } from '@/lib/auth/authorization-changed'
import { getDatabase, inImmediateTransaction } from '@/lib/db/client'
import { getKnowledgeCleanupTarget } from '@/lib/knowledge-storage'
import { consumeStorageReservationInDatabase, releaseStorageAllocationInDatabase } from '@/lib/storage/quota'

export { ReportAuthorizationChangedError } from '@/lib/auth/authorization-changed'
type ListPagination = { limit: number; offset: number }

export interface KnowledgeItem {
  id: string
  title: string
  fileName: string
  fileSize: number
  category: string
  description: string
  tags: string[]
  sourcePath: string
  fileHash: string
  uploadedBy: string
  uploadedByUserId: string
  createdAt: string
  updatedAt: string
}

function mimeTypeForKnowledgeFile(fileName: string) {
  return /\.pdf$/i.test(fileName) ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
}

function knowledgeItemFromRow(row: Record<string, unknown>): KnowledgeItem {
  let tags: string[] = []
  try {
    const parsed = JSON.parse(String(row.tags_json || '[]'))
    if (Array.isArray(parsed)) tags = parsed.map(String)
  } catch {
    tags = []
  }
  return {
    id: text(row.id),
    title: text(row.title),
    fileName: text(row.file_name),
    fileSize: integer(row.file_size),
    category: text(row.category || '行业研报'),
    description: text(row.description || ''),
    tags,
    sourcePath: text(row.source_path),
    fileHash: text(row.file_hash),
    uploadedBy: text(row.uploaded_by || '系统用户'),
    uploadedByUserId: text(row.uploaded_by_user_id),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  }
}

export function listKnowledgeItems(category?: string, pagination?: ListPagination): KnowledgeItem[] {
  const suffix = pagination ? ' LIMIT ? OFFSET ?' : ''
  const parameters: Array<string | number> = []
  let query = 'SELECT * FROM knowledge_items'
  if (category && category !== '全部') {
    query += ' WHERE category = ?'
    parameters.push(category)
  }
  query += ' ORDER BY created_at DESC, id DESC' + suffix
  if (pagination) parameters.push(pagination.limit, pagination.offset)
  return rows(query, ...parameters).map(knowledgeItemFromRow)
}

export function countKnowledgeItems(category?: string): number {
  const row = category && category !== '全部'
    ? getDatabase().prepare('SELECT COUNT(*) AS count FROM knowledge_items WHERE category = ?').get(category)
    : getDatabase().prepare('SELECT COUNT(*) AS count FROM knowledge_items').get()
  return integer((row as { count?: unknown } | undefined)?.count)
}

export function getKnowledgeItem(id: string): KnowledgeItem | undefined {
  const row = getDatabase().prepare('SELECT * FROM knowledge_items WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? knowledgeItemFromRow(row) : undefined
}

export function createKnowledgeItem(item: Omit<KnowledgeItem, 'createdAt' | 'updatedAt'>, actor?: AuthUser, storageReservationId?: string): KnowledgeItem {
  const timestamp = new Date().toISOString()
  return inImmediateTransaction((database) => {
    if (actor) {
      const currentActor = database.prepare("SELECT 1 FROM users WHERE id = ? AND status = 'active'").get(actor.id)
      if (!currentActor || item.uploadedByUserId !== actor.id) throw new ReportAuthorizationChangedError()
    }
    database.prepare(`
    INSERT INTO knowledge_items(
      id, title, file_name, file_size, category, description, tags_json, source_path, file_hash,
      uploaded_by, uploaded_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.id,
    item.title,
    item.fileName,
    item.fileSize,
    item.category,
    item.description,
    JSON.stringify(item.tags || []),
    item.sourcePath,
    item.fileHash,
    item.uploadedBy,
    item.uploadedByUserId,
      timestamp,
      timestamp,
    )
    if (storageReservationId) {
      if (!actor) throw new Error('存储预留缺少上传者。')
      consumeStorageReservationInDatabase(database, storageReservationId, {
        ownerType: 'knowledge', ownerId: item.id, userId: actor.id, projectId: null,
        sizeBytes: item.fileSize, fileHash: item.fileHash, sourcePath: item.sourcePath, mimeType: mimeTypeForKnowledgeFile(item.fileName),
      })
    }
    const row = database.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(item.id) as Record<string, unknown>
    return knowledgeItemFromRow(row)
  })
}

export function userCanDeleteKnowledgeItem(item: KnowledgeItem, user: AuthUser): boolean {
  return user.role === 'admin' || (Boolean(item.uploadedByUserId) && item.uploadedByUserId === user.id)
}

export async function deleteKnowledgeItem(id: string, actor?: AuthUser): Promise<boolean> {
  const sourcePath = inImmediateTransaction((database) => {
    const row = database.prepare('SELECT source_path, uploaded_by_user_id FROM knowledge_items WHERE id = ?').get(id) as { source_path?: string; uploaded_by_user_id?: string | null } | undefined
    if (!row) return undefined
    if (actor) {
      const currentActor = database.prepare("SELECT role, status FROM users WHERE id = ?").get(actor.id) as { role?: string; status?: string } | undefined
      const allowed = currentActor?.status === 'active' && (currentActor.role === 'admin' || row.uploaded_by_user_id === actor.id)
      if (!allowed) throw new ReportAuthorizationChangedError()
    }
    releaseStorageAllocationInDatabase(database, 'knowledge', id)
    database.prepare('DELETE FROM knowledge_items WHERE id = ?').run(id)
    return row.source_path
  })
  if (!sourcePath) return false
  const cleanupTarget = getKnowledgeCleanupTarget(sourcePath)
  if (cleanupTarget) await rm(cleanupTarget, { recursive: true, force: true }).catch(() => undefined)
  return true
}

function text(value: unknown): string { return String(value ?? '') }
function integer(value: unknown): number { return typeof value === 'number' ? Math.trunc(value) : Number(value ?? 0) }
function rows(query: string, ...parameters: Array<string | number>): Record<string, unknown>[] {
  return getDatabase().prepare(query).all(...parameters)
}

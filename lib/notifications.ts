import { randomUUID } from 'node:crypto'
import { getDatabase, inImmediateTransaction } from '@/lib/db/client'
import type { AuthUser } from '@/lib/auth/session'
import { notificationActions, type NotificationAction, type NotificationItem } from '@/modules/notifications/domain'

const MAX_SUMMARY_LENGTH = 240
const MAX_DETAIL_LENGTH = 2_000
const MAX_PROJECT_TITLE_LENGTH = 240
const MAX_REPORT_TITLE_LENGTH = 240

export interface RecordActivityInput {
  action: NotificationAction
  actor: Pick<AuthUser, 'id' | 'displayName' | 'username'>
  summary: string
  detail: string
  projectId?: string
  projectTitle?: string
  reportId?: string
  reportTitle?: string
  recipientUserIds?: readonly string[]
}

export function recordActivity(input: RecordActivityInput) {
  const summary = limitText(input.summary, MAX_SUMMARY_LENGTH)
  const detail = limitText(input.detail || input.summary, MAX_DETAIL_LENGTH)
  if (!summary || !detail) return

  const actorName = limitText(input.actor.displayName || input.actor.username, MAX_PROJECT_TITLE_LENGTH)
  const createdAt = new Date().toISOString()
  const explicitRecipientIds = [...new Set((input.recipientUserIds ?? []).filter((id) => Boolean(id)))]
  try {
    inImmediateTransaction((database) => {
      const recipientRows = database.prepare(`
        SELECT id
        FROM users
        WHERE status = 'active'
          AND (
            role = 'admin'
            OR EXISTS (
              SELECT 1 FROM project_members members
              WHERE members.project_id = ? AND members.user_id = users.id AND members.role IN ('owner', 'editor')
            )
            OR id IN (${explicitRecipientIds.length ? explicitRecipientIds.map(() => '?').join(', ') : 'NULL'})
          )
      `).all(input.projectId ?? '', ...explicitRecipientIds) as Array<{ id?: unknown }>
      const insert = database.prepare(`
        INSERT INTO notifications (
          id, recipient_user_id, action, actor_user_id, actor_name, project_id, project_title, report_id, report_title, summary, detail, read_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      `)
      for (const row of recipientRows) {
        if (typeof row.id !== 'string' || !row.id) continue
        insert.run(
          'notification-' + randomUUID(),
          row.id,
          input.action,
          input.actor.id,
          actorName,
          input.projectId || null,
          limitText(input.projectTitle ?? '', MAX_PROJECT_TITLE_LENGTH),
          input.reportId || null,
          input.reportTitle ? limitText(input.reportTitle, MAX_REPORT_TITLE_LENGTH) : null,
          summary,
          detail,
          createdAt,
        )
      }
    })
  } catch (error) {
    console.error('[notifications] 活动记录写入失败', error)
  }
}

export function listActiveProjectMemberIds(projectId: string) {
  const rows = getDatabase().prepare(`
    SELECT members.user_id AS userId
    FROM project_members members
    INNER JOIN users ON users.id = members.user_id
    WHERE members.project_id = ? AND users.status = 'active' AND members.role IN ('owner', 'editor')
  `).all(projectId) as Array<{ userId?: unknown }>
  return rows.flatMap((row) => typeof row.userId === 'string' && row.userId ? [row.userId] : [])
}

export function listNotificationsForUser(user: AuthUser, pagination: { limit: number; offset: number }) {
  const database = getDatabase()
  const rows = database.prepare(`
    SELECT n.id, n.action, n.actor_name, n.project_id, n.project_title, n.report_id, n.report_title,
           n.summary, n.detail, n.read_at, n.created_at
    FROM notifications n
    WHERE n.recipient_user_id = ?
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT ? OFFSET ?
  `).all(user.id, pagination.limit, pagination.offset) as Array<Record<string, unknown>>
  const items = rows.flatMap((row) => {
    const item = notificationFromRow(row, user.role === 'admin')
    return item ? [item] : []
  })
  const total = countNotifications(database, user.id)
  const unreadCount = countUnreadNotifications(database, user.id)
  return { items, total, unreadCount }
}

export function markNotificationsRead(user: AuthUser, input: { all?: boolean; ids?: readonly string[] }) {
  const requestedIds = [...new Set((input.ids ?? []).filter((id) => Boolean(id)))]
  const ids = input.all === true ? [] : requestedIds
  if (input.all !== true && !ids.length) return 0
  const idFilter = ids.length ? ' AND id IN (' + ids.map(() => '?').join(', ') + ')' : ''
  const parameters: Array<string | number> = [new Date().toISOString(), user.id, ...ids]
  const result = getDatabase().prepare(`
    UPDATE notifications
    SET read_at = ?
    WHERE recipient_user_id = ? AND read_at IS NULL${idFilter}
  `).run(...parameters)
  return Number(result.changes)
}

function countNotifications(database: ReturnType<typeof getDatabase>, userId: string) {
  const row = database.prepare('SELECT COUNT(*) AS count FROM notifications WHERE recipient_user_id = ?').get(userId) as { count?: unknown } | undefined
  return Number(row?.count ?? 0)
}

function countUnreadNotifications(database: ReturnType<typeof getDatabase>, userId: string) {
  const row = database.prepare('SELECT COUNT(*) AS count FROM notifications WHERE recipient_user_id = ? AND read_at IS NULL').get(userId) as { count?: unknown } | undefined
  return Number(row?.count ?? 0)
}

function notificationFromRow(row: Record<string, unknown>, includeDetail: boolean): NotificationItem | undefined {
  const action = row.action
  if (!isNotificationAction(action)) return undefined
  const item: NotificationItem = {
    id: String(row.id ?? ''),
    action,
    summary: String(row.summary ?? ''),
    projectId: optionalText(row.project_id),
    projectTitle: optionalText(row.project_title),
    reportId: optionalText(row.report_id),
    reportTitle: optionalText(row.report_title),
    createdAt: String(row.created_at ?? ''),
    read: row.read_at !== null && row.read_at !== undefined,
  }
  if (includeDetail) {
    item.actorName = optionalText(row.actor_name)
    item.detail = optionalText(row.detail)
  }
  return item
}

function isNotificationAction(value: unknown): value is NotificationAction {
  return Object.values(notificationActions).some((action) => action === value)
}

function optionalText(value: unknown) {
  return typeof value === 'string' && value ? value : undefined
}

function limitText(value: string, maxLength: number) {
  const normalized = value.trim()
  return normalized.length > maxLength ? normalized.slice(0, maxLength - 1) + '…' : normalized
}

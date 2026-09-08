import type { DatabaseSync } from 'node:sqlite'

/** 删除从未被读取的 sessions.last_seen_at；已有会话行全部保留。 */
export const dropSessionsLastSeenAtSql = 'ALTER TABLE sessions DROP COLUMN last_seen_at;'

export function applyDropSessionsLastSeenAt(database: DatabaseSync) {
  database.exec(dropSessionsLastSeenAtSql)
}

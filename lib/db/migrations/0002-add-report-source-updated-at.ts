import type { DatabaseSync } from 'node:sqlite'

/** 保留现有 created_at，为替换正文增加独立的原件更新时间。 */
export const addReportSourceUpdatedAtSql = `
  ALTER TABLE report_versions ADD COLUMN source_updated_at TEXT NOT NULL DEFAULT '';
  UPDATE report_versions SET source_updated_at = created_at WHERE source_updated_at = '';
`

export function applyAddReportSourceUpdatedAt(database: DatabaseSync) {
  database.exec(addReportSourceUpdatedAtSql)
}

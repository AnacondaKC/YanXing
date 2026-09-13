import type { DatabaseSync } from 'node:sqlite'
import { NativeBackupError } from '@/lib/storage/native-backup-error'

const ACTIVE_TASK_STATUSES = "('queued','running')"
const ACTIVE_UPLOAD_STATUSES = "('receiving','parsing','ready','reclaiming')"

export type NativeBackupQuiescence = {
  activeTasks: number
  activeUploads: number
  activeReservations: number
}

export function inspectBackupQuiescence(database: DatabaseSync): NativeBackupQuiescence {
  return {
    activeTasks: countRows(database, 'SELECT COUNT(*) AS n FROM submission_tasks WHERE status IN ' + ACTIVE_TASK_STATUSES),
    activeUploads: countRows(database, 'SELECT COUNT(*) AS n FROM report_uploads WHERE status IN ' + ACTIVE_UPLOAD_STATUSES),
    activeReservations: countRows(database, "SELECT COUNT(*) AS n FROM storage_reservations WHERE state = 'active'"),
  }
}

export function assertBackupQuiescent(database: DatabaseSync) {
  const snapshot = inspectBackupQuiescence(database)
  if (snapshot.activeTasks > 0 || snapshot.activeUploads > 0 || snapshot.activeReservations > 0) {
    throw new NativeBackupError(
      'NOT_QUIESCENT',
      '活动任务 ' + snapshot.activeTasks + '，未完成上传 ' + snapshot.activeUploads + '，配额预留 ' + snapshot.activeReservations + '。',
    )
  }
  return snapshot
}

function countRows(database: DatabaseSync, sql: string) {
  const row = database.prepare(sql).get() as { n?: unknown } | undefined
  const count = Number(row?.n ?? 0)
  return Number.isSafeInteger(count) ? count : 0
}

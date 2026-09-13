import { isAbsolute, relative, resolve } from 'node:path'
import type { SubmissionQuota } from '@/modules/reports/upload-domain'
import { consumeStorageReservationInDatabase, releaseStorageReservationInDatabase, reserveStorageQuotaInDatabase } from '@/lib/storage/quota'

// Upload TTL is enforced by report_uploads. A persisted file holds its reservation until physical reclamation.
export const PERSISTED_UPLOAD_RESERVATION_END = '9999-12-31T23:59:59.999Z'

export function createSubmissionStorageQuota(input: { storageRoot: string }): SubmissionQuota {
  const root = resolve(input.storageRoot)
  return {
    reserve({ database, actorId, projectId, expectedBytes }) {
      database.prepare('INSERT OR IGNORE INTO submission_storage_root(id,path) VALUES (1,?)').run(root)
      if(database.prepare('SELECT path FROM submission_storage_root WHERE id=1').get()?.path!==root) throw new Error('Submission storage root does not match this database.')
      const id = reserveStorageQuotaInDatabase(database, { userId: actorId, projectId, expectedBytes, ownerType: 'report' })
      database.prepare('UPDATE storage_reservations SET expires_at=? WHERE id=?').run(PERSISTED_UPLOAD_RESERVATION_END, id)
      return id
    },
    consume({ database, reservationId, report, mimeType }) {
      const sourcePath = resolve(root, report.sourceKey)
      const key = relative(root, sourcePath)
      if (isAbsolute(report.sourceKey) || !key || key === '..' || key.startsWith('../') || isAbsolute(key)) {
        throw new Error('Prepared report source escapes its storage root.')
      }
      consumeStorageReservationInDatabase(database, reservationId, {
        ownerType: 'report', ownerId: report.id, userId: report.submittedBy, projectId: report.projectId,
        sizeBytes: report.sourceSize, fileHash: report.fileHash, sourcePath, mimeType,
      })
    },
    release({ database, reservationId }) {
      releaseStorageReservationInDatabase(database, reservationId)
    },
  }
}

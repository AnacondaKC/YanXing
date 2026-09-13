import { dirname, join, resolve } from 'node:path'
import { getDatabasePath } from '@/lib/db/database-path'

/** Directory that owns the database file; default is <cwd>/storage. */
export function getRuntimeStorageRoot() {
  return dirname(resolve(getDatabasePath()))
}

export function getReportStorageRoot() {
  return join(getRuntimeStorageRoot(), 'reports')
}

export function getTemporaryStorageRoot() {
  return join(getRuntimeStorageRoot(), 'tmp')
}

export function getDefaultKnowledgeStorageRoot() {
  return join(getRuntimeStorageRoot(), 'knowledge')
}

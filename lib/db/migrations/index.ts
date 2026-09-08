import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { INITIAL_AI_SETTINGS_VERSION } from '@/lib/db/initial-ai-settings'
import { applyInitialSchema, initialSchemaSql } from './0001-initial-schema'
import { addReportSourceUpdatedAtSql, applyAddReportSourceUpdatedAt } from './0002-add-report-source-updated-at'
import { applyDropSessionsLastSeenAt, dropSessionsLastSeenAtSql } from './0003-drop-sessions-last-seen-at'
import { addBrandSettingsSql, applyAddBrandSettings } from './0004-add-brand-settings'
import { applyUpdateDefaultBrand, updateDefaultBrandSql } from './0005-update-default-brand'

export interface DatabaseMigration {
  version: number
  name: string
  checksum: string
  apply(database: DatabaseSync): void
}

export interface AppliedDatabaseMigration {
  version: number
  name: string
  checksum: string
  appliedAt: string
}

function checksumMigrationSource(source: string) {
  return createHash('sha256').update(source).digest('hex')
}

/**
 * 新安装只执行一个完整初始 schema；后续结构变化继续追加更高版本，绝不复用本编号。
 * checksum 覆盖完整 schema SQL 与初始配置版本，避免启动时静默采用不一致的结构。
 */
export const databaseMigrations: readonly DatabaseMigration[] = [
  {
    version: 1,
    name: '0001-initial-schema',
    checksum: checksumMigrationSource(initialSchemaSql + '\n' + INITIAL_AI_SETTINGS_VERSION),
    apply: applyInitialSchema,
  },
  {
    version: 2,
    name: '0002-add-report-source-updated-at',
    checksum: checksumMigrationSource(addReportSourceUpdatedAtSql),
    apply: applyAddReportSourceUpdatedAt,
  },
  {
    version: 3,
    name: '0003-drop-sessions-last-seen-at',
    checksum: checksumMigrationSource(dropSessionsLastSeenAtSql),
    apply: applyDropSessionsLastSeenAt,
  },
  {
    version: 4,
    name: '0004-add-brand-settings',
    checksum: checksumMigrationSource(addBrandSettingsSql),
    apply: applyAddBrandSettings,
  },
  {
    version: 5,
    name: '0005-update-default-brand',
    checksum: checksumMigrationSource(updateDefaultBrandSql),
    apply: applyUpdateDefaultBrand,
  },
]

validateMigrationManifest(databaseMigrations)

function validateMigrationManifest(migrations: readonly DatabaseMigration[]) {
  for (let index = 0; index < migrations.length; index += 1) {
    const current = migrations[index]
    const previous = migrations[index - 1]
    if (!Number.isSafeInteger(current?.version) || current.version <= 0 || !current.name || !current.checksum) {
      throw new Error('数据库迁移清单无效。')
    }
    if (previous && current.version <= previous.version) throw new Error('数据库迁移版本必须严格递增。')
  }
}

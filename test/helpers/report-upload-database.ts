import { DatabaseSync } from 'node:sqlite'
import { ensureNativeDatabase, installFreshSharedSchema } from '../../lib/db/native-schema'
import { installStageReportSchema } from '../../lib/db/stage-report-schema'
import { installReportUploadSchema } from '../../lib/db/report-upload-schema'

/** Fresh shared tables for unit tests; an explicit root installs the complete native identity. */
export function createReportUploadTestDatabase(path = ':memory:', storageRoot?: string): DatabaseSync {
  const database = new DatabaseSync(path)
  database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;')
  if (storageRoot) ensureNativeDatabase({database,storageRoot})
  else {
    installFreshSharedSchema(database)
    installStageReportSchema(database)
    installReportUploadSchema(database)
  }
  const at = new Date().toISOString()
  for (const [id, role] of [['owner','researcher'],['editor','researcher'],['admin','admin'],['other','researcher']] as const) {
    database.prepare('INSERT INTO users (id,username,display_name,password_hash,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, id, id, 'test-only-not-login', role, 'active', at, at)
  }
  database.prepare('INSERT INTO projects (id,title,objective,owner_name,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run('project', '测试课题', '研究目标', 'owner', at, at)
  database.prepare('INSERT INTO project_members (project_id,user_id,role,created_at) VALUES (?,?,?,?)').run('project','owner','owner',at)
  database.prepare('INSERT INTO project_members (project_id,user_id,role,created_at) VALUES (?,?,?,?)').run('project','editor','editor',at)
  return database
}

import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { installStageReportSchema } from '../lib/db/stage-report-schema'
import { installReportUploadSchema } from '../lib/db/report-upload-schema'
import { createReportUploadTestDatabase } from './helpers/report-upload-database'

test('upload schema bootstrap is atomic on a middle-table conflict and never changes caller data', () => {
  const database = new DatabaseSync(':memory:')
  try {
    database.exec('PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE projects(id TEXT PRIMARY KEY)')
    installStageReportSchema(database)
    database.exec("CREATE TABLE report_submission_requests(sentinel TEXT); INSERT INTO report_submission_requests VALUES ('preserved')")
    const before=database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    assert.throws(()=>installReportUploadSchema(database),/already exists/)
    assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),before)
    assert.equal(database.prepare('SELECT sentinel FROM report_submission_requests').get()?.sentinel,'preserved')
  } finally {database.close()}
})

test('upload schema refuses missing prerequisites and disabled foreign keys', () => {
  const database=new DatabaseSync(':memory:')
  try {
    assert.throws(()=>installReportUploadSchema(database),/requires users/)
    database.exec('CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE projects(id TEXT PRIMARY KEY)')
    installStageReportSchema(database)
    database.exec('PRAGMA foreign_keys=OFF')
    assert.throws(()=>installReportUploadSchema(database),/foreign_keys/)
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name='report_uploads'").get(),undefined)
  } finally {database.close()}
})

test('ready upload needs parsed immutable source metadata and cannot regress to parsing or change owner', () => {
  const database=createReportUploadTestDatabase()
  try {
    database.exec("INSERT INTO project_report_state(project_id) VALUES ('project')")
    const insert=database.prepare("INSERT INTO report_uploads(id,project_id,actor_id,file_name,status,reservation_id,reserved_bytes,created_at,expires_at) VALUES (?,'project','owner','report.docx',?,'reservation',100,'2026-06-01T00:00:00Z',?)")
    assert.throws(()=>insert.run('upload','receiving','invalid'),/CHECK/)
    assert.throws(()=>insert.run('upload','ready','2026-06-01T01:00:00Z'),/CHECK/)
    insert.run('upload','receiving','2026-06-01T01:00:00Z')
    database.exec("UPDATE report_uploads SET status='parsing' WHERE id='upload'")
    database.exec("UPDATE report_uploads SET status='ready',source_key='upload/report.docx',mime_type='application/docx',file_hash='hash',source_size=4,title='文档',document_text='文档',paragraph_count=1,character_count=2 WHERE id='upload'")
    assert.throws(()=>database.exec("UPDATE report_uploads SET actor_id='admin' WHERE id='upload'"),/identity_immutable/)
    assert.throws(()=>database.exec("UPDATE report_uploads SET status='parsing' WHERE id='upload'"),/transition_invalid/)
    assert.throws(()=>database.exec("UPDATE report_uploads SET source_key='another.docx' WHERE id='upload'"),/content_immutable/)
    assert.throws(()=>database.exec("UPDATE report_uploads SET document_text='替换内容' WHERE id='upload'"),/content_immutable/)
  } finally {database.close()}
})

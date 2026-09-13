import assert from 'node:assert/strict'
import test from 'node:test'
import { createReportUploadTestDatabase } from './helpers/report-upload-database'
import { assertSubmissionTaskSchema,installSubmissionTaskSchema } from '../lib/db/submission-task-schema'

test('P3 schema is fresh-only, atomic, and explicitly version checked',()=>{
  const database=createReportUploadTestDatabase()
  try {
    assert.throws(()=>assertSubmissionTaskSchema(database),/schema missing/)
    database.exec('CREATE VIEW submission_task_results AS SELECT 1 AS id')
    assert.throws(()=>installSubmissionTaskSchema(database),/already exists/)
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name='submission_tasks'").get(),undefined)
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name='submission_task_schema'").get(),undefined)
    database.exec('DROP VIEW submission_task_results')
    installSubmissionTaskSchema(database)
    assertSubmissionTaskSchema(database)
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name IN ('submission_task_budgets','submission_task_usage_resolutions')").get(),undefined)
    assert.equal(database.prepare('PRAGMA table_info(submission_task_calls)').all().some(column=>column.name==='tokens'),false)
    assert.throws(()=>installSubmissionTaskSchema(database),/already exists/)
    assertSubmissionTaskSchema(database)
    assert.equal(database.prepare('SELECT COUNT(*) n FROM users').get()?.n,4)
  } finally {database.close()}
})

test('P3 schema rejects disabled foreign keys without partial installation',()=>{
  const database=createReportUploadTestDatabase()
  try {
    database.exec('PRAGMA foreign_keys=OFF')
    assert.throws(()=>installSubmissionTaskSchema(database),/requires foreign keys/)
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name='submission_tasks'").get(),undefined)
  } finally {database.close()}
})

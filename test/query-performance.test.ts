import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { initialSchemaSql } from '../lib/db/migrations/0001-initial-schema'

function planDetails(database: DatabaseSync, sql: string, ...parameters: string[]) {
  return (database.prepare('EXPLAIN QUERY PLAN ' + sql).all(...parameters) as Array<{ detail?: unknown }>)
    .map((row) => String(row.detail ?? ''))
    .join(' | ')
}

function createDatabase() {
  const database = new DatabaseSync(':memory:')
  database.exec(initialSchemaSql)
  return database
}

test('consolidated schema indexes cover project, report, and category ordering', () => {
  const database = createDatabase()

  assert.match(
    planDetails(database, 'SELECT * FROM projects ORDER BY updated_at DESC, id DESC LIMIT 100'),
    /idx_projects_updated_id/,
  )
  assert.doesNotMatch(
    planDetails(database, 'SELECT * FROM projects ORDER BY updated_at DESC, id DESC LIMIT 100'),
    /TEMP B-TREE/,
  )
  assert.match(
    planDetails(database, 'SELECT id FROM report_versions INDEXED BY idx_report_versions_project_version WHERE project_id = ? ORDER BY version DESC, created_at DESC LIMIT 1', 'p'),
    /idx_report_versions_project_version/,
  )
  assert.match(
    planDetails(database, 'SELECT * FROM report_versions ORDER BY created_at DESC, id DESC LIMIT 100'),
    /idx_report_versions_created_id/,
  )
  assert.match(
    planDetails(database, 'SELECT * FROM knowledge_items WHERE category = ? ORDER BY created_at DESC, id DESC LIMIT 100', '行业研报'),
    /idx_knowledge_items_category_created_id/,
  )
  database.close()
})

test('consolidated schema covers latest final snapshot lookup', () => {
  const database = createDatabase()
  assert.match(
    planDetails(database, "SELECT * FROM analysis_snapshots WHERE job_id = ? AND kind = 'final' ORDER BY created_at DESC, id DESC LIMIT 1", 'job-1'),
    /idx_analysis_snapshots_job_kind_created/,
  )
  database.close()
})

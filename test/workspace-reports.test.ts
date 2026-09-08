import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHiddenProjectIds, selectActiveReportAfterDeletion, toggleHiddenProjectId } from '../lib/workspace-reports'
import { shouldRedirectToLogin } from '../lib/client-request'
import type { ReportVersion } from '../modules/reports/domain'

function report(id: string, version: number): ReportVersion {
  return {
    id,
    projectId: 'project-1',
    version,
    title: `报告 ${version}` ,
    fileName: `report-${version}.docx`,
    fileHash: id,
    paragraphCount: 1,
    characterCount: 10,
    parseStatus: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
  }
}

test('retains a selected historical report fetched outside the latest page after deletion', () => {
  const latest = report('r200', 200)
  const selectedHistorical = report('r1', 1)
  const selected = selectActiveReportAfterDeletion([latest], 'r1', 'r199', selectedHistorical)
  assert.equal(selected.latest, latest)
  assert.equal(selected.active, selectedHistorical)

  const deleted = selectActiveReportAfterDeletion([latest], 'r199', 'r199', undefined, report('r199', 199))
  assert.equal(deleted.active, latest)
})

test('hidden project ids ignore malformed localStorage payloads', () => {
  assert.deepEqual(parseHiddenProjectIds(null), [])
  assert.deepEqual(parseHiddenProjectIds('not-json'), [])
  assert.deepEqual(parseHiddenProjectIds('{"foo":1}'), [])
  assert.deepEqual(parseHiddenProjectIds('["a",1,"",null,"b"]'), ['a', 'b'])
  assert.deepEqual(toggleHiddenProjectId(['a'], 'b'), ['a', 'b'])
  assert.deepEqual(toggleHiddenProjectId(['a', 'b'], 'a'), ['b'])
})

test('401 redirects to login except on the login page', () => {
  assert.equal(shouldRedirectToLogin(401, '/'), true)
  assert.equal(shouldRedirectToLogin(401, '/login'), false)
  assert.equal(shouldRedirectToLogin(403, '/'), false)
})

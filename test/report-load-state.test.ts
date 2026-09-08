import assert from 'node:assert/strict'
import test from 'node:test'
import { reportLoadState, type ReportListResult } from '../lib/report-load-state'

const identity = { projectId: 'project-a', reloadKey: 1 }
const ready: ReportListResult = { ...identity, status: 'ready' }

test('a reportless first visit remains loading until its own request settles', () => {
  assert.equal(reportLoadState(identity), 'loading')
  assert.equal(reportLoadState({ ...identity, result: ready }), 'ready')
})

test('an empty successful result is ready rather than permanently loading', () => {
  assert.equal(reportLoadState({ ...identity, result: ready }), 'ready')
})

test('a failed initial request is distinct from a confirmed empty report list', () => {
  assert.equal(reportLoadState({ ...identity, result: { ...ready, status: 'error' } }), 'error')
})

test('switching projects cannot consume a previous project readiness result', () => {
  assert.equal(reportLoadState({ ...identity, projectId: 'project-b', result: ready }), 'loading')
})

test('retry or repeat entry waits for the new request even in the same project', () => {
  assert.equal(reportLoadState({ ...identity, reloadKey: 2, result: ready }), 'loading')
  assert.equal(reportLoadState({ ...identity, reloadKey: 2, result: { ...ready, reloadKey: 2 } }), 'ready')
})

test('available report content is retained during background refresh and refresh failure', () => {
  const report = { projectId: identity.projectId }
  assert.equal(reportLoadState({ ...identity, report }), 'ready')
  assert.equal(reportLoadState({ ...identity, report, reloadKey: 2, result: ready }), 'ready')
  assert.equal(reportLoadState({ ...identity, report, result: { ...ready, status: 'error' } }), 'ready')
})

test('report data from a different project does not unlock the current entry', () => {
  assert.equal(reportLoadState({ ...identity, report: { projectId: 'project-b' } }), 'loading')
})

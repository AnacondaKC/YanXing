import assert from 'node:assert/strict'
import test from 'node:test'

import { isCurrentInsightRequest } from '../components/insight-workspace'

test('insight responses apply only to the captured report, hash, and generation', () => {
  const current = {
    requestReportId: 'report-a',
    requestFileHash: 'hash-a',
    requestGeneration: 2,
    activeReportId: 'report-a',
    activeFileHash: 'hash-a',
    activeGeneration: 2,
  }
  assert.equal(isCurrentInsightRequest(current), true)
  assert.equal(isCurrentInsightRequest({ ...current, activeReportId: 'report-b' }), false)
  assert.equal(isCurrentInsightRequest({ ...current, activeFileHash: 'hash-b' }), false)
  assert.equal(isCurrentInsightRequest({ ...current, activeGeneration: 3 }), false)
})

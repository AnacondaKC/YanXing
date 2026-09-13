import assert from 'node:assert/strict'
import test from 'node:test'
import {
  analysisJobEventsPath,
  EMPTY_SNAPSHOT,
  preferDisplayedAnalysisPayload,
  snapshotHasDisplayableResults,
} from '../lib/analysis-job-progress'
import type { AnalysisSnapshotPayload } from '../modules/contracts/analysis'

test('analysis job event URLs carry this job cursor and ignore invalid ids', () => {
  assert.equal(analysisJobEventsPath('job-1'), '/api/jobs/job-1/events')
  assert.equal(analysisJobEventsPath('job-1', 12), '/api/jobs/job-1/events?after=12')
  assert.equal(analysisJobEventsPath('job-1', -1), '/api/jobs/job-1/events')
  assert.equal(analysisJobEventsPath('job-2', 7), '/api/jobs/job-2/events?after=7')
})

function displayableSnapshot(): AnalysisSnapshotPayload {
  return {
    ...EMPTY_SNAPSHOT,
    visualization: {
      ...EMPTY_SNAPSHOT.visualization,
      mindMap: { id: 'root', label: '报告', children: [{ id: 'c1', label: '章节', children: [] }] },
    },
  }
}

test('empty retry snapshots do not replace published analysis results', () => {
  const published = displayableSnapshot()
  const nextPublished = displayableSnapshot()
  const emptyPartial = EMPTY_SNAPSHOT
  assert.equal(snapshotHasDisplayableResults(emptyPartial), false)
  assert.equal(snapshotHasDisplayableResults(published), true)
  assert.equal(preferDisplayedAnalysisPayload(published, emptyPartial), published)
  assert.equal(preferDisplayedAnalysisPayload(undefined, emptyPartial), emptyPartial)
  assert.equal(preferDisplayedAnalysisPayload(published, nextPublished), nextPublished)
})

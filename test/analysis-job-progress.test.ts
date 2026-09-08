import assert from 'node:assert/strict'
import test from 'node:test'
import {
  analysisJobEventsPath,
  applyJobProgressEventToJob,
  applyJobProgressEventToModuleStates,
  EMPTY_SNAPSHOT,
  isJobProgressEventNewer,
  parseJobProgressEvent,
  parseJobProgressPayload,
  preferDisplayedAnalysisPayload,
  selectDisplayedAnalysisSnapshot,
  shouldRefreshModuleProgressFromEvent,
  snapshotHasDisplayableResults,
} from '../lib/analysis-job-progress'
import type { AnalysisJob } from '../modules/analysis/domain'
import type { AnalysisModuleState, AnalysisSnapshotPayload } from '../modules/contracts/analysis'

function job(overrides: Partial<AnalysisJob> = {}): AnalysisJob {
  return {
    id: 'job-1',
    reportVersionId: 'report-1',
    type: 'initial',
    status: 'queued',
    stage: 'validating',
    stageIndex: 0,
    attempts: 1,
    cancelRequested: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

test('parseJobProgressPayload ignores invalid JSON and unknown types', () => {
  assert.equal(parseJobProgressPayload('{'), undefined)
  assert.equal(parseJobProgressPayload('{"stage":"page_analysis"}'), undefined)
  assert.equal(parseJobProgressPayload('{"type":"module_started","moduleId":"unknown_module"}'), undefined)
  assert.equal(parseJobProgressPayload('{"type":"module_started","stage":"unknown_stage"}'), undefined)
  assert.equal(parseJobProgressPayload('{"type":"module_skipped","moduleId":"page_analysis"}'), undefined)
  assert.deepEqual(parseJobProgressPayload('{"type":"module_started","moduleId":"page_analysis"}'), {
    type: 'module_started',
    stage: undefined,
    moduleId: 'page_analysis',
    errors: undefined,
    createdAt: undefined,
  })
  assert.equal(parseJobProgressPayload('{"type":"module_started","moduleId":"report_insight"}')?.moduleId, 'report_insight')
})

test('job progress events promote queued jobs and keep accepted modules from animating', () => {
  const nextJob = applyJobProgressEventToJob(job(), {
    type: 'module_started',
    stage: 'page_analysis',
    moduleId: 'page_analysis',
    createdAt: '2026-01-01T00:01:00.000Z',
  })
  assert.equal(nextJob?.status, 'running')
  assert.equal(nextJob?.stage, 'page_analysis')

  const states = applyJobProgressEventToModuleStates([], {
    type: 'module_started',
    moduleId: 'page_analysis',
  })
  assert.equal(states[0]?.status, 'running')

  const accepted: AnalysisModuleState[] = applyJobProgressEventToModuleStates(states, {
    type: 'module_accepted',
    moduleId: 'page_analysis',
  })
  assert.equal(accepted[0]?.status, 'accepted')
})

test('job progress events ignore unknown module ids and never produce stageIndex -1', () => {
  const running = job({ status: 'running', stage: 'page_analysis' })
  assert.equal(applyJobProgressEventToJob(running, { type: 'module_started', stage: 'not_a_stage' as never, moduleId: 'not_a_module' as never }), running)
  const states = applyJobProgressEventToModuleStates([], { type: 'module_started', moduleId: 'report_insight' })
  assert.deepEqual(states, [])
  const unknownStage = applyJobProgressEventToJob(running, { type: 'stage', stage: 'completed' })
  assert.equal(unknownStage?.stageIndex, 3)
  const invalid = applyJobProgressEventToJob(running, { type: 'stage', stage: 'not_a_stage' as never })
  assert.equal(invalid, running)
})

test('job progress events map completed, failed, and cancelled to terminal status', () => {
  const running = job({ status: 'running', stage: 'page_analysis' })
  assert.equal(applyJobProgressEventToJob(running, { type: 'completed', stage: 'completed' })?.status, 'completed')
  assert.equal(applyJobProgressEventToJob(running, { type: 'failed' })?.status, 'failed')
  assert.equal(applyJobProgressEventToJob(running, { type: 'cancelled' })?.status, 'cancelled')
  assert.equal(applyJobProgressEventToJob(running, { type: 'info' })?.status, 'running')
})

test('module states for page_analysis track attempt counts and reset errors on accepted', () => {
  const retrying = applyJobProgressEventToModuleStates([], {
    type: 'module_retrying',
    moduleId: 'page_analysis',
    errors: [{ code: 'SCHEMA_INVALID', path: '/词云', message: '词云无效。' }],
  })
  assert.equal(retrying[0]?.status, 'retrying')
  assert.equal(retrying[0]?.attempt, 2)
  assert.equal(retrying[0]?.gateErrors.length, 1)
  const accepted = applyJobProgressEventToModuleStates(retrying, {
    type: 'module_accepted',
    moduleId: 'page_analysis',
  })
  assert.equal(accepted[0]?.status, 'accepted')
  assert.deepEqual(accepted[0]?.gateErrors, [])
})

test('progress event IDs accept persisted and SSE cursors without mismatches', () => {
  assert.equal(parseJobProgressPayload('{"type":"info","id":0,"jobId":"job-1"}')?.id, 0)
  assert.equal(parseJobProgressEvent({ data: '{"type":"info","id":12,"jobId":"job-1"}', lastEventId: '12' })?.id, 12)
  assert.equal(parseJobProgressEvent({ data: '{"type":"info","id":12}', lastEventId: '13' }), undefined)
  assert.equal(parseJobProgressEvent({ data: '{"type":"info"}', lastEventId: '0' })?.id, 0)
  assert.equal(parseJobProgressEvent({ data: '{"type":"info"}' }), undefined)
  for (const id of ['-1', '1.0', '1e2', '0x10', '9007199254740992']) {
    assert.equal(parseJobProgressEvent({ data: '{"type":"info"}', lastEventId: id }), undefined, id)
    assert.equal(parseJobProgressPayload(JSON.stringify({ type: 'info', id })), undefined, id)
  }
})

test('progress event cursors require ids and stay monotonic', () => {
  const event = { type: 'info' as const, id: 11 }
  assert.equal(isJobProgressEventNewer(event, 10), true)
  assert.equal(isJobProgressEventNewer(event, 11), false)
  assert.equal(isJobProgressEventNewer(event, 12), false)
  assert.equal(isJobProgressEventNewer({ type: 'info', id: 0 }, undefined), true)
  assert.equal(isJobProgressEventNewer({ type: 'info' }, undefined), false)
  assert.equal(isJobProgressEventNewer({ type: 'info' }, 12), false)
})

test('info events update timestamps and only worker info promotes queued jobs', () => {
  const queued = applyJobProgressEventToJob(job(), { type: 'info', createdAt: '2026-01-01T00:01:00.000Z' })
  assert.equal(queued?.status, 'queued')
  assert.equal(queued?.updatedAt, '2026-01-01T00:01:00.000Z')

  const running = applyJobProgressEventToJob(queued, { type: 'info', stage: 'page_analysis', createdAt: '2026-01-01T00:02:00.000Z' })
  assert.equal(running?.status, 'running')
  assert.equal(running?.stage, 'page_analysis')
  assert.equal(running?.updatedAt, '2026-01-01T00:02:00.000Z')
  const older = applyJobProgressEventToJob(running, { type: 'info', createdAt: '2025-12-31T23:59:00.000Z' })
  assert.equal(older?.updatedAt, running?.updatedAt)
  assert.equal(applyJobProgressEventToJob(running, { type: 'info', jobId: 'other-job' }), running)
})

test('module progress honors explicit attempts, defaults retries, and never rolls back terminal state', () => {
  const started = applyJobProgressEventToModuleStates([], {
    type: 'module_started',
    moduleId: 'page_analysis',
    attempt: 1,
    maxAttempts: 4,
  })
  assert.equal(started[0]?.attempt, 1)
  assert.equal(started[0]?.maxAttempts, 4)

  const explicitRetry = applyJobProgressEventToModuleStates(started, {
    type: 'module_retrying',
    moduleId: 'page_analysis',
    attempt: 3,
    maxAttempts: 4,
  })
  assert.equal(explicitRetry[0]?.attempt, 3)
  assert.equal(explicitRetry[0]?.maxAttempts, 4)

  const accepted = applyJobProgressEventToModuleStates(explicitRetry, {
    type: 'module_accepted',
    moduleId: 'page_analysis',
    attempt: 3,
  })
  assert.equal(accepted[0]?.status, 'accepted')
  assert.deepEqual(applyJobProgressEventToModuleStates(accepted, {
    type: 'module_retrying',
    moduleId: 'page_analysis',
    attempt: 4,
  }), accepted)

  const defaultState = applyJobProgressEventToModuleStates([], { type: 'module_started', moduleId: 'page_analysis' })
  assert.equal(defaultState[0]?.attempt, 1)
  assert.equal(defaultState[0]?.maxAttempts, 3)
  assert.equal(parseJobProgressPayload('{"type":"module_retrying","moduleId":"page_analysis","attempt":4,"maxAttempts":3}'), undefined)
})

test('retrying events keep attempt when already retrying without an explicit attempt', () => {
  const started = applyJobProgressEventToModuleStates([], {
    type: 'module_started',
    moduleId: 'page_analysis',
    attempt: 1,
  })
  const firstRetry = applyJobProgressEventToModuleStates(started, {
    type: 'module_retrying',
    moduleId: 'page_analysis',
  })
  assert.equal(firstRetry[0]?.attempt, 2)
  const duplicateRetry = applyJobProgressEventToModuleStates(firstRetry, {
    type: 'module_retrying',
    moduleId: 'page_analysis',
  })
  assert.equal(duplicateRetry[0]?.attempt, 2)
  const explicitRetry = applyJobProgressEventToModuleStates(duplicateRetry, {
    type: 'module_retrying',
    moduleId: 'page_analysis',
    attempt: 3,
  })
  assert.equal(explicitRetry[0]?.attempt, 3)
  assert.equal(shouldRefreshModuleProgressFromEvent({ type: 'module_retrying' }, firstRetry[0]), true)
  assert.equal(shouldRefreshModuleProgressFromEvent({ type: 'module_retrying', attempt: 3 }, firstRetry[0]), false)
  assert.equal(shouldRefreshModuleProgressFromEvent({ type: 'module_retrying' }, started[0]), false)
})

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
  assert.equal(selectDisplayedAnalysisSnapshot({ payload: published }, { payload: emptyPartial })?.payload, published)
  assert.equal(selectDisplayedAnalysisSnapshot({ payload: published }, { payload: nextPublished })?.payload, nextPublished)
  assert.equal(selectDisplayedAnalysisSnapshot(undefined, { payload: emptyPartial })?.payload, emptyPartial)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { canWriteProjectReports, resolveReportDeletionAccess, resolveReportOperationAccess } from '../modules/reports/submission-policy'
import type { ReportOperationHistory, ReportWriteContext, SubmissionIdentity } from '../modules/reports/submission-domain'
import { isReportSubmissionCommand, isReportSubmissionIdempotencyKey } from '../modules/contracts/report-submission'

const access: ReportWriteContext = {
  projectId: 'project', actor: { id: 'owner', role: 'researcher', status: 'active' },
  membership: { projectId: 'project', userId: 'owner', role: 'owner' },
}
const old: SubmissionIdentity = { id: 'old', projectId: 'project', stageId: 'stage-2', stageVersion: 6, submissionSequence: 8 }
const latest: SubmissionIdentity = { id: 'latest', projectId: 'project', stageId: 'stage-1', stageVersion: 2, submissionSequence: 9 }
const success: ReportOperationHistory = { successCount: 1, firstSucceededAt: '2026-09-01T00:00:00Z' }

function operation(history: Partial<ReportOperationHistory>, report = old) {
  return resolveReportOperationAccess({ access, report, latestSubmission: latest, history: { successCount: 0, ...history } })
}

function deletion(overrides: Partial<Parameters<typeof resolveReportDeletionAccess>[0]> = {}) {
  return resolveReportDeletionAccess({ access, report: old,
    stage: { id: old.stageId, projectId: old.projectId }, operations: { analysis: { successCount: 0 }, insight: { successCount: 0 } }, ...overrides })
}

test('Q01: only an active administrator or actual project owner can write reports', () => {
  assert.equal(canWriteProjectReports(access), true)
  assert.equal(canWriteProjectReports({ ...access, membership: undefined }), false)
  assert.equal(canWriteProjectReports({ ...access, membership: { ...access.membership!, role: 'editor' } }), false)
  assert.equal(canWriteProjectReports({ ...access, actor: undefined }), false)
  assert.equal(canWriteProjectReports({ ...access, actor: { ...access.actor!, status: 'disabled' } }), false)
  assert.equal(canWriteProjectReports({ ...access, membership: { ...access.membership!, projectId: 'other' } }), false)
  assert.equal(canWriteProjectReports({ ...access, membership: { ...access.membership!, userId: 'other' } }), false)
  assert.equal(canWriteProjectReports({ ...access, membership: undefined, actor: { id: 'admin', role: 'admin', status: 'active' } }), true)
  assert.equal(canWriteProjectReports({ ...access, actor: { id: 'admin', role: 'admin', status: 'disabled' } }), false)
})

test('AT19/30: latest submission may rerun even in an earlier stage with a smaller stage version', () => {
  assert.deepEqual(operation(success, latest), { kind: 'enqueue', action: 'rerun' })
  assert.deepEqual(operation(success), { kind: 'denied', code: 'HISTORICAL_OPERATION_ALREADY_SUCCEEDED' })
})

test('successful operations are capped at three including already over-limit reports', () => {
  assert.deepEqual(operation({ successCount: 2 }, latest), { kind: 'enqueue', action: 'rerun' })
  for (const successCount of [3, 4]) {
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      assert.deepEqual(operation({ successCount, latestAttempt: { jobId: 'job', status } }, latest), {
        kind: 'denied', code: 'REPORT_OPERATION_SUCCESS_LIMIT',
      })
    }
  }
})

test('AT20/21/23: historical operations allow first start and failed/cancelled recovery independently', () => {
  assert.deepEqual(operation({}), { kind: 'enqueue', action: 'start' })
  for (const status of ['failed', 'cancelled'] as const) {
    assert.deepEqual(operation({ latestAttempt: { jobId: 'job', status } }), { kind: 'enqueue', action: 'retry' })
  }
  const operations = { analysis: success, insight: {} }
  assert.equal(operation(operations.analysis).kind, 'denied')
  assert.deepEqual(operation(operations.insight), { kind: 'enqueue', action: 'start' })
})

test('AT22/Q05: an admitted active job is reused even after the report becomes historical', () => {
  for (const status of ['queued', 'running'] as const) {
    assert.deepEqual(operation({ ...success, latestAttempt: { jobId: 'existing', status } }), { kind: 'reuse', jobId: 'existing' })
  }
})

test('AT24: a failed rerun never resets successful historical eligibility', () => {
  assert.deepEqual(operation({ ...success, latestAttempt: { jobId: 'rerun', status: 'failed' } }), {
    kind: 'denied', code: 'HISTORICAL_OPERATION_ALREADY_SUCCEEDED',
  })
  assert.equal(operation({ latestAttempt: { jobId: 'completed', status: 'completed' } }).kind, 'denied')
})

test('deleted, foreign-project and inconsistent latest identities fail closed', () => {
  assert.deepEqual(operation({}, { ...old, deletedAt: 'deleted' }), { kind: 'denied', code: 'REPORT_NOT_FOUND' })
  assert.deepEqual(operation({}, { ...old, projectId: 'other' }), { kind: 'denied', code: 'REPORT_NOT_FOUND' })
  for (const latestSubmission of [undefined, { ...latest, deletedAt: 'deleted' }, { ...latest, projectId: 'other' },
    { ...latest, submissionSequence: old.submissionSequence }, { ...latest, submissionSequence: NaN }]) {
    assert.deepEqual(resolveReportOperationAccess({ access, report: old, latestSubmission, history: { successCount: 0 } }), {
      kind: 'denied', code: 'REPORT_STATE_INVALID',
    })
  }
  assert.equal(resolveReportOperationAccess({ access: { ...access, actor: undefined }, report: old, latestSubmission: latest, history: { successCount: 0 } }).kind, 'denied')
})

test('AT16/17: current completion is protected, superseded completion is an ordinary deletable update', () => {
  assert.deepEqual(deletion({ stage: { id: old.stageId, projectId: old.projectId, currentCompletionReportId: old.id } }), {
    kind: 'denied', code: 'COMPLETION_REPORT_PROTECTED',
  })
  assert.deepEqual(deletion({ stage: { id: old.stageId, projectId: old.projectId, currentCompletionReportId: 'replacement' } }), { kind: 'allowed' })
  assert.equal(deletion({ stage: { id: 'wrong', projectId: old.projectId } }).kind, 'denied')
  assert.equal(deletion({ access: { ...access, actor: undefined } }).kind, 'denied')
})

test('Q06: either active operation must finish or be cancelled before logical deletion', () => {
  for (const name of ['analysis', 'insight'] as const) {
    const operations = { analysis: { successCount: 0 }, insight: { successCount: 0 }, [name]: { successCount: 0, latestAttempt: { jobId: 'active', status: 'running' as const } } }
    assert.deepEqual(deletion({ operations }), { kind: 'denied', code: 'REPORT_PROCESSING' })
  }
  assert.deepEqual(deletion({ operations: { analysis: { successCount: 0, latestAttempt: { jobId: 'ended', status: 'cancelled' } }, insight: { successCount: 0 } } }), { kind: 'allowed' })
})

const command = { uploadId: 'upload', stageId: 'stage', reportKind: 'completion', expectedPlanRevision: 0,
  expectedWorkflowRevision: 0, expectedCompletionRevision: 0, expectedCompletionReportId: null }

test('P0: submission wire contract requires explicit null completion and rejects old fields/coercion', () => {
  assert.equal(isReportSubmissionCommand(command), true)
  assert.equal(isReportSubmissionCommand({ ...command, reportKind: 'update' }), true)
  for (const invalid of [null, [], { ...command, reportKind: 'final' }, { ...command, version: 2 },
    { ...command, expectedCompletionReportId: undefined }, { ...command, expectedPlanRevision: '0' },
    { ...command, expectedWorkflowRevision: -1 }, { ...command, expectedCompletionRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...command, stageId: '' }, { ...command, stageId: 'a/b' }, { ...command, force: true }, { ...command, sourcePath: '/tmp/file' }]) {
    assert.equal(isReportSubmissionCommand(invalid), false)
  }
})

test('P0: idempotency key is an opaque bounded request identity, not a report version', () => {
  assert.equal(isReportSubmissionIdempotencyKey('request_0123456789'), true)
  for (const invalid of [undefined, '', 'V1', 'a'.repeat(129), 'with space 0123456789', 42]) {
    assert.equal(isReportSubmissionIdempotencyKey(invalid), false)
  }
})

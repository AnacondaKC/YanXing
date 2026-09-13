import assert from 'node:assert/strict'
import test from 'node:test'
import { getSubmissionDisplayLabels, resolveSubmissionComparison, selectLatestSubmission, type ComparisonSubmission } from '../modules/reports/submission-query'

function report(sequence: number, stageId = 'stage-1', stageVersion = sequence): ComparisonSubmission {
  return { id: 'report-' + sequence, projectId: 'project', stageId, stageVersion, submissionSequence: sequence,
    wasFirstStageSubmission: stageVersion === 1, characterCount: sequence * 100, aiScore: 60 + sequence, analysisId: 'analysis-' + sequence }
}
const first = report(1)
const completion = report(2)
const nextStage = report(3, 'stage-2', 1)
const backfill = report(4, 'stage-1', 3)

test('AT25: first report of every stage hides deltas even when the project has a predecessor', () => {
  assert.deepEqual(resolveSubmissionComparison({ report: nextStage, submissions: [first, completion, nextStage] }), {
    status: 'unavailable', reason: 'first_stage_submission',
  })
})

test('AT26/30: earlier stage backfill compares to the preceding global submission and becomes latest', () => {
  const submissions = [backfill, first, nextStage, completion]
  const result = resolveSubmissionComparison({ report: backfill, submissions })
  assert.equal(result.status, 'available')
  if (result.status !== 'available') return
  assert.equal(result.baselineReportId, nextStage.id)
  assert.equal(result.characterDelta, 100)
  assert.equal(result.scoreDelta, 1)
  assert.equal(selectLatestSubmission(submissions, 'project')?.id, backfill.id)
})

test('AT27: deletion walks all older valid project submissions, never a newer or foreign report', () => {
  const foreign = { ...report(100), projectId: 'other' }
  const deletedStageReport = { ...nextStage, deletedAt: 'deleted' }
  const deletedCompletion = { ...completion, deletedAt: 'deleted' }
  for (const [submissions, expected] of [
    [[first, completion, deletedStageReport, backfill, foreign, report(5)], completion.id],
    [[first, deletedCompletion, deletedStageReport, backfill, foreign], first.id],
  ] as const) {
    const result = resolveSubmissionComparison({ report: backfill, submissions })
    assert.equal(result.status, 'available')
    if (result.status === 'available') assert.equal(result.baselineReportId, expected)
  }
  assert.deepEqual(resolveSubmissionComparison({ report: backfill, submissions: [deletedCompletion, deletedStageReport, foreign] }), {
    status: 'unavailable', reason: 'no_predecessor',
  })
})

test('AT28: unavailable predecessor score is not zero and does not select an older successful score', () => {
  for (const aiScore of [undefined, NaN, Infinity, -1, 101]) {
    const result = resolveSubmissionComparison({ report: backfill, submissions: [first, { ...nextStage, aiScore }] })
    assert.equal(result.status, 'available')
    if (result.status !== 'available') continue
    assert.equal(result.baselineReportId, nextStage.id)
    assert.equal(result.characterDelta, 100)
    assert.equal(result.scoreDelta, undefined)
  }
})

test('zero deltas are valid; deleted target is unavailable; projections do not mutate results', () => {
  const target = Object.freeze({ ...backfill, characterCount: nextStage.characterCount, aiScore: nextStage.aiScore })
  const inputs = Object.freeze([Object.freeze({ ...nextStage })])
  const result = resolveSubmissionComparison({ report: target, submissions: inputs })
  assert.equal(result.status, 'available')
  if (result.status === 'available') {
    assert.equal(result.characterDelta, 0)
    assert.equal(result.scoreDelta, 0)
  }
  assert.deepEqual(resolveSubmissionComparison({ report: { ...target, deletedAt: 'deleted' }, submissions: inputs }), {
    status: 'unavailable', reason: 'report_deleted',
  })
})

test('AT18: deleting newest transfers latest to remaining report without relying on array ordering', () => {
  assert.equal(selectLatestSubmission([{ ...backfill, deletedAt: 'deleted' }, first, nextStage, completion], 'project')?.id, nextStage.id)
  assert.equal(selectLatestSubmission([], 'project'), undefined)
})

test('replacement transfers completion labels without rewriting submission provenance', () => {
  const original = Object.freeze({ ...completion, submittedAs: 'completion' as const })
  const replacement = Object.freeze({ ...backfill, submittedAs: 'completion' as const })
  const originalStage = Object.freeze({
    id: 'stage-1', projectId: 'project', ordinal: 1, title: '成果研究', currentCompletionReportId: original.id,
  })
  assert.equal(getSubmissionDisplayLabels({ stage: originalStage, report: original }).roleLabel, '阶段完结报告')

  const replacedStage = Object.freeze({ ...originalStage, currentCompletionReportId: replacement.id })
  const oldLabels = getSubmissionDisplayLabels({ stage: replacedStage, report: original })
  const newLabels = getSubmissionDisplayLabels({ stage: replacedStage, report: replacement })
  assert.equal(oldLabels.roleLabel, '阶段更新报告')
  assert.equal(oldLabels.completionLabel, undefined)
  assert.equal(oldLabels.reportLabel, '成果研究 V2')
  assert.equal(newLabels.roleLabel, '阶段完结报告')
  assert.equal(newLabels.completionLabel, '成果研究完结报告')
  assert.equal(newLabels.reportLabel, '成果研究 V3')
  assert.deepEqual(original, { ...completion, submittedAs: 'completion' })
  assert.deepEqual(replacement, { ...backfill, submittedAs: 'completion' })
  assert.equal(originalStage.currentCompletionReportId, original.id)
})

test('completion provenance alone does not grant completion labels without a current pointer', () => {
  const stage = { id: 'stage-1', projectId: 'project', ordinal: 1, title: '成果研究' }
  const labels = getSubmissionDisplayLabels({ stage, report: { ...completion, submittedAs: 'completion' } })
  assert.equal(labels.roleLabel, '阶段更新报告')
  assert.equal(labels.completionLabel, undefined)
})

test('AT31: stage position, local version, and completion role remain independent', () => {
  const stage = { id: 'stage-1', projectId: 'project', ordinal: 13, title: '成果研究', currentCompletionReportId: backfill.id }
  const current = { ...backfill, stageVersion: 103, submittedAs: 'completion' as const }
  const superseded = { ...completion, submittedAs: 'completion' as const }
  const update = { ...completion, submittedAs: 'update' as const }
  const labels = getSubmissionDisplayLabels({ stage, report: current })
  assert.equal(labels.stageLabel, '阶段13 · 成果研究')
  assert.equal(labels.reportLabel, '成果研究 V103')
  assert.equal(labels.compactLabel, '阶段13 V103')
  assert.equal(labels.roleLabel, '阶段完结报告')
  assert.equal(labels.completionLabel, '成果研究完结报告')
  assert.equal(getSubmissionDisplayLabels({ stage, report: superseded }).roleLabel, '阶段更新报告')
  assert.equal(getSubmissionDisplayLabels({ stage, report: superseded }).completionLabel, undefined)
  assert.equal(getSubmissionDisplayLabels({ stage, report: update }).roleLabel, '阶段更新报告')
  assert.equal(getSubmissionDisplayLabels({ stage: { ...stage, ordinal: 1 }, report: { ...backfill, submittedAs: 'completion' } }).compactLabel, '阶段01 V3')
  assert.throws(() => getSubmissionDisplayLabels({ stage, report: { ...current, projectId: 'wrong' } }))
})

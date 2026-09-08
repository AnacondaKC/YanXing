import assert from 'node:assert/strict'
import test from 'node:test'
import {
  postAnalysisJob,
  startAnalysisFailureAction,
  startAnalysisGate,
  startAnalysisPath,
} from '../lib/analysis-job-actions'
import type { ReportVersion } from '../modules/reports/domain'

function report(overrides: Partial<ReportVersion> = {}): ReportVersion {
  return {
    id: 'report-1',
    projectId: 'project-1',
    version: 1,
    title: '报告',
    fileName: 'report.docx',
    fileHash: 'abc',
    characterCount: 100,
    paragraphCount: 4,
    parseStatus: 'ready',
    hasCompletedFullAnalysis: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

test('start analysis waits for a stage when the current report has none', () => {
  const unstaged = report({ milestoneId: undefined })
  assert.deepEqual(startAnalysisGate({
    canManage: true,
    reportId: 'report-1',
    report: unstaged,
    activeJobId: undefined,
    starting: false,
    stageConfirmed: false,
  }), { type: 'assign-stage', report: unstaged })

  assert.deepEqual(startAnalysisGate({
    canManage: true,
    reportId: 'report-1',
    report: unstaged,
    activeJobId: undefined,
    starting: false,
    stageConfirmed: true,
  }), { type: 'proceed', reportId: 'report-1' })
})

test('start analysis does not fire while another job is running or the user cannot manage', () => {
  assert.equal(startAnalysisGate({
    canManage: false,
    reportId: 'report-1',
    starting: false,
    stageConfirmed: true,
  }).type, 'block')
  assert.equal(startAnalysisGate({
    canManage: true,
    reportId: 'report-1',
    activeJobId: 'job-1',
    starting: false,
    stageConfirmed: true,
  }).type, 'block')
})

test('failed start analysis maps stage and project-context errors to the matching dialog', () => {
  assert.equal(startAnalysisFailureAction({ code: 'REPORT_STAGE_REQUIRED' }, report()), 'assign-stage')
  assert.equal(startAnalysisFailureAction({ code: 'PROJECT_CONTEXT_INCOMPLETE' }, report()), 'edit-project')
  assert.equal(startAnalysisFailureAction({ code: 'MODEL_MISSING' }, report()), 'notice')
})

test('start analysis uses the analysis-page endpoint', () => {
  assert.equal(startAnalysisPath('r1'), '/api/reports/r1/analyze')
})

test('postAnalysisJob treats a job payload as success and anything else as failure', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/ok')) {
      return new Response(JSON.stringify({ job: { id: 'job-9' }, moduleStates: [] }), { status: 200 })
    }
    return new Response(JSON.stringify({ error: '失败' }), { status: 400 })
  }) as typeof fetch
  try {
    const ok = await postAnalysisJob('/ok')
    assert.equal(ok.ok, true)
    assert.equal(ok.body.job?.id, 'job-9')
    const failed = await postAnalysisJob('/fail')
    assert.equal(failed.ok, false)
    assert.equal(failed.body.error, '失败')
  } finally {
    globalThis.fetch = originalFetch
  }
})

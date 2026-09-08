import assert from 'node:assert/strict'
import test from 'node:test'

import {
  acceptUploadedDashboardReport,
  activateDashboardReport,
  activateDashboardReportForProject,
  emptyDashboardReportState,
  refreshActiveDashboardReport,
  replaceActiveDashboardReport,
  resetDashboardAnalysisState,
  resetDashboardReportState,
  sameWorkspaceReportIdentity,
  shouldAcceptUploadedReport,
} from '../components/dashboard-state'
import type { DashboardReportState } from '../components/dashboard-state'
import type { ReportVersion } from '../modules/reports/domain'

function createReport(id: string, projectId = 'project-1'): ReportVersion {
  return {
    id,
    projectId,
    version: 1,
    title: id,
    fileName: id + '.docx',
    fileHash: id,
    paragraphCount: 1,
    characterCount: 1,
    parseStatus: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function createState(): DashboardReportState {
  return {
    activeReportId: 'report-old',
    activeReport: createReport('report-old'),
    latestReport: createReport('report-latest'),
    analysisSnapshot: undefined,
    activeJobId: 'job-1',
    analysisJob: undefined,
    analysisModuleStates: [],
  }
}

test('dashboard report state resets analysis without changing report selection', () => {
  const state = createState()
  const reset = resetDashboardAnalysisState(state)
  assert.equal(reset.activeReportId, state.activeReportId)
  assert.equal(reset.activeReport, state.activeReport)
  assert.equal(reset.latestReport, state.latestReport)
  assert.equal(reset.activeJobId, undefined)
  assert.equal(reset.analysisJob, undefined)
  assert.deepEqual(reset.analysisModuleStates, [])
})

test('dashboard report state clears selection when project or top-level view changes', () => {
  const reset = resetDashboardReportState(createState())
  assert.deepEqual(reset, emptyDashboardReportState())
})

test('dashboard report activation preserves latest report and clears stale analysis', () => {
  const nextReport = createReport('report-new')
  const activated = activateDashboardReport(createState(), nextReport)
  assert.equal(activated.activeReportId, 'report-new')
  assert.equal(activated.activeReport, nextReport)
  assert.equal(activated.latestReport?.id, 'report-latest')
  assert.equal(activated.analysisSnapshot, undefined)
  assert.equal(activated.activeJobId, undefined)
})

test('refreshing the already active report retains its displayed snapshot', () => {
  const snapshot = { schemaVersion: 1 } as never
  const refreshed = refreshActiveDashboardReport({ ...createState(), analysisSnapshot: snapshot }, createReport('report-old'))
  assert.equal(refreshed.activeReportId, 'report-old')
  assert.equal(refreshed.activeReport?.id, 'report-old')
  assert.equal(refreshed.analysisSnapshot, snapshot)
  assert.equal(refreshed.activeJobId, undefined)
})

test('cross-project activation drops the previous latest report', () => {
  const next = activateDashboardReportForProject(createState(), createReport('report-b', 'project-2'), 'project-1')
  assert.equal(next.activeReportId, 'report-b')
  assert.equal(next.latestReport, undefined)
  assert.equal(next.activeJobId, undefined)
})

test('same-project activation keeps the latest report', () => {
  const next = activateDashboardReportForProject(createState(), createReport('report-new'), 'project-1')
  assert.equal(next.latestReport?.id, 'report-latest')
})

test('popstate keeps analysis when only the view changes for the same report', () => {
  assert.equal(sameWorkspaceReportIdentity({ projectId: 'p1', reportId: 'r1' }, { projectId: 'p1' }), true)
  assert.equal(sameWorkspaceReportIdentity({ projectId: 'p1', reportId: 'r1' }, { projectId: 'p1', reportId: 'r1' }), true)
  assert.equal(sameWorkspaceReportIdentity({ projectId: 'p1', reportId: 'r1' }, { projectId: 'p1', reportId: 'r2' }), false)
  assert.equal(sameWorkspaceReportIdentity({ projectId: 'p1', reportId: 'r1' }, { projectId: 'p2', reportId: 'r1' }), false)
})

test('uploaded reports are accepted only for the captured project and view generation', () => {
  const captured = { projectId: 'p1', viewGeneration: 3 }
  assert.equal(shouldAcceptUploadedReport(captured, captured), true)
  assert.equal(shouldAcceptUploadedReport(captured, { projectId: 'p2', viewGeneration: 3 }), false)
  assert.equal(shouldAcceptUploadedReport(captured, { projectId: 'p1', viewGeneration: 4 }), false)
  const accepted = acceptUploadedDashboardReport(createReport('report-new'))
  assert.equal(accepted.activeReportId, 'report-new')
  assert.equal(accepted.latestReport?.id, 'report-new')
  assert.equal(accepted.activeJobId, undefined)
})

test('replacing the active report clears analysis so the new job can reconnect', () => {
  const replaced = replaceActiveDashboardReport(createState(), createReport('report-old'))
  assert.equal(replaced.activeReportId, 'report-old')
  assert.equal(replaced.latestReport?.id, 'report-latest')
  assert.equal(replaced.activeJobId, undefined)
  assert.equal(replaced.analysisSnapshot, undefined)
})

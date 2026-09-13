import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = readFileSync(new URL('../components/workspace-app.tsx', import.meta.url), 'utf8')

test('native controller mounts the original visual components rather than a parallel simplified UI', () => {
  for (const component of ['OverviewWorkspace', 'ReportsRepositoryWorkspace', 'ProjectSetupGuideView', 'ProjectFirstReportOnboarding', 'DashboardView', 'InsightWorkspace', 'ReportHistoryView']) assert.ok(app.includes('<' + component), component)
  for (const retired of ['WorkspaceOverview', 'WorkspaceReportsLibrary', 'WorkspaceReportBoard', 'WorkspaceInsight', 'WorkspaceHistory', 'WorkspaceStageGroups', 'WorkspaceProjectCreateDialog']) assert.ok(!new RegExp('<' + retired + '(?![A-Za-z])').test(app), retired)
  assert.ok(app.includes('right-[calc(100%+0.75rem)]'))
  assert.ok(!app.includes('lg:w-72'))
  assert.ok(app.includes('<WorkspaceSubmitDialog'))
  assert.ok(app.includes('handleCommit'))
  assert.ok(app.includes('applyWorkspaceReportDetail'))
  assert.ok(!app.includes('ReportVersion'))
  assert.ok(!app.includes('deliveryType'))
})

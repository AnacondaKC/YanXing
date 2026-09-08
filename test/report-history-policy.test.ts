import assert from 'node:assert/strict'
import test from 'node:test'
import type { Milestone } from '../modules/projects/domain'
import type { ReportVersion } from '../modules/reports/domain'
import {
  canDeleteReportFromHistory,
  canReplaceReportFromHistory,
  latestReportedMilestoneIndex,
} from '../modules/reports/history-policy.ts'

const milestones: Milestone[] = [
  { id: 'stage-1', title: '阶段一', status: 'completed' },
  { id: 'stage-2', title: '阶段二', status: 'completed' },
  { id: 'stage-3', title: '阶段三', status: 'in_progress' },
]

function report(id: string, milestoneId?: string, version = 1): ReportVersion {
  return {
    id,
    projectId: 'project-1',
    milestoneId,
    deliveryType: milestoneId ? 'stage' : undefined,
    version,
    title: id,
    fileName: `${id}.docx`,
    fileHash: id,
    paragraphCount: 0,
    characterCount: 0,
    parseStatus: 'ready',
    createdAt: '2026-08-26T00:00:00.000Z',
    sourceUpdatedAt: '2026-08-26T00:00:00.000Z',
  }
}

test('only reports in the latest reported milestone can be deleted', () => {
  const reports = [report('old', 'stage-1'), report('latest-a', 'stage-2', 2), report('latest-b', 'stage-2', 3)]
  assert.equal(latestReportedMilestoneIndex(milestones, reports), 1)
  assert.equal(canDeleteReportFromHistory(reports[0], milestones, reports), false)
  assert.equal(canDeleteReportFromHistory(reports[1], milestones, reports), true)
  assert.equal(canDeleteReportFromHistory(reports[2], milestones, reports), true)
})

test('completed historical milestones can replace reports but cannot delete them', () => {
  const historical = report('historical', 'stage-1')
  const latest = report('latest', 'stage-2', 2)
  const reports = [historical, latest]
  assert.equal(canReplaceReportFromHistory(historical, milestones, reports), true)
  assert.equal(canReplaceReportFromHistory(latest, milestones, reports), false)
})

test('unassigned reports have no destructive history action', () => {
  const unassigned = report('legacy')
  const latest = report('latest', 'stage-2', 2)
  const reports = [unassigned, latest]
  assert.equal(canDeleteReportFromHistory(unassigned, milestones, reports), false)
  assert.equal(canReplaceReportFromHistory(unassigned, milestones, reports), false)
})

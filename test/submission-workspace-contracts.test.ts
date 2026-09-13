import assert from 'node:assert/strict'
import test from 'node:test'
import { isStagePlanEdit, isStageProjectCreate } from '../modules/projects/stage-project-contract'
import {
  isWorkspaceProjectSafeEdit,
  isWorkspaceReportDelete,
  WORKSPACE_API,
  WORKSPACE_RETIRED_CODES,
  WORKSPACE_RETIRED_PROJECT_FIELDS,
} from '../modules/contracts/submission-workspace'

test('workspace API keeps canonical native paths and retired codes', () => {
  assert.equal(WORKSPACE_API.reportUploads, '/api/projects/:projectId/report-uploads')
  assert.equal(WORKSPACE_API.stages, '/api/projects/:projectId/stages')
  assert.equal(WORKSPACE_API.jobRetry, '/api/jobs/:jobId/retry')
  assert.equal(WORKSPACE_API.overview, '/api/overview-stats')
  assert.deepEqual(WORKSPACE_RETIRED_CODES, {
    REPORT_STAGE_IMMUTABLE: 'REPORT_STAGE_IMMUTABLE',
    REPORT_SOURCE_IMMUTABLE: 'REPORT_SOURCE_IMMUTABLE',
    UPLOAD_PROTOCOL_RETIRED: 'UPLOAD_PROTOCOL_RETIRED',
    PROJECT_FIELD_RETIRED: 'PROJECT_FIELD_RETIRED',
    PROJECT_RETENTION_REQUIRED: 'PROJECT_RETENTION_REQUIRED',
  })
  assert.ok(WORKSPACE_RETIRED_PROJECT_FIELDS.includes('milestones'))
  assert.ok(WORKSPACE_RETIRED_PROJECT_FIELDS.includes('ownerId'))
})

test('native create and plan guards reject legacy milestone payloads', () => {
  const stages = [{ id: 'stage-1', title: '阶段一', description: '工作内容与预期成果', plannedEndAt: '2026-12-31' }]
  assert.equal(isStageProjectCreate({
    title: '课题', objective: '研究目标', description: '研究背景', ownerId: 'owner', stages,
  }), true)
  assert.equal(isStageProjectCreate({
    title: '课题', objective: '研究目标', description: '研究背景', ownerId: 'owner', stages, milestones: stages,
  }), false)
  assert.equal(isStagePlanEdit({ expectedPlanRevision: 1, nextStages: stages }), true)
  assert.equal(isStagePlanEdit({ expectedPlanRevision: 1, milestones: stages }), false)
  assert.equal(isWorkspaceProjectSafeEdit({ expectedUpdatedAt: '2026-01-01T00:00:00.000Z', title: '新标题' }), true)
  assert.equal(isWorkspaceProjectSafeEdit({ expectedUpdatedAt: 'not-a-date', title: '新标题' }), false)
  assert.equal(isWorkspaceProjectSafeEdit({ updatedAt: '2026-01-01T00:00:00.000Z', title: '新标题' }), false)
  assert.equal(isWorkspaceReportDelete({ reason: '重复上传' }), true)
  assert.equal(isWorkspaceReportDelete({}), false)
})

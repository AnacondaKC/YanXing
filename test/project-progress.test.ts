import assert from 'node:assert/strict'
import test from 'node:test'
import { applyReportDeliveryToMilestones, completeMilestonesWhenFinalRemains, reconcileMilestonesAfterReportDeletion } from '../modules/projects/progress'
import type { Milestone } from '../modules/projects/domain'

function milestones(): Milestone[] {
  return [
    { id: 'stage-1', title: '立项', status: 'in_progress', reportIds: ['old'] },
    { id: 'stage-2', title: '调研', status: 'not_started' },
    { id: 'stage-3', title: '交付', status: 'not_started' },
  ]
}

test('stage delivery completes the target and starts the next milestone', () => {
  const result = applyReportDeliveryToMilestones(milestones(), 'report-1', 'stage-1', 'stage')
  assert.equal(result.targetMilestoneId, 'stage-1')
  assert.equal(result.milestones[0].status, 'completed')
  assert.deepEqual(result.milestones[0].reportIds, ['report-1', 'old'])
  assert.equal(result.milestones[1].status, 'in_progress')
  assert.equal(result.milestones[2].status, 'not_started')
})

test('stage delivery cannot skip an unfinished earlier milestone', () => {
  assert.throws(
    () => applyReportDeliveryToMilestones(milestones(), 'report-skip', 'stage-3', 'stage'),
    /请先完成阶段/,
  )
})

test('final delivery completes every milestone and attaches the report to the last stage', () => {
  const result = applyReportDeliveryToMilestones(milestones(), 'report-9', 'stage-1', 'final')
  assert.equal(result.targetMilestoneId, 'stage-3')
  assert.deepEqual(result.milestones.map((milestone) => milestone.status), ['completed', 'completed', 'completed'])
  assert.deepEqual(result.milestones[0].reportIds, ['old'])
  assert.deepEqual(result.milestones[2].reportIds, ['report-9'])
})

test('reassignment moves a report to another stage', () => {
  const current = applyReportDeliveryToMilestones(milestones(), 'report-1', 'stage-1', 'stage').milestones
  const moved = applyReportDeliveryToMilestones(current, 'report-1', 'stage-2', 'stage')
  assert.equal(moved.milestones[0].reportIds?.includes('report-1'), false)
  assert.deepEqual(moved.milestones[1].reportIds, ['report-1'])
  assert.equal(moved.milestones[1].status, 'completed')
  assert.equal(moved.milestones[2].status, 'in_progress')
})

test('a completed stage cannot lose its only report to a later stage', () => {
  const current: Milestone[] = [
    { id: 'stage-1', title: '立项', status: 'completed', reportIds: ['only-report'] },
    { id: 'stage-2', title: '调研', status: 'in_progress' },
  ]
  assert.throws(
    () => applyReportDeliveryToMilestones(current, 'only-report', 'stage-2', 'stage'),
    /唯一交付报告/,
  )
})

test('moving a report backward reopens the emptied later milestone', () => {
  const first = applyReportDeliveryToMilestones(milestones(), 'report-1', 'stage-1', 'stage').milestones
  const second = applyReportDeliveryToMilestones(first, 'report-1', 'stage-2', 'stage').milestones
  const movedBack = applyReportDeliveryToMilestones(second, 'report-1', 'stage-1', 'stage')
  assert.equal(movedBack.milestones[1].reportIds?.includes('report-1') ?? false, false)
  assert.equal(movedBack.milestones[1].status, 'in_progress')
  assert.equal(movedBack.milestones[2].status, 'not_started')
})

test('moving a report backward cannot leave a later reported stage completed after a gap', () => {
  const current: Milestone[] = [
    { id: 'stage-1', title: '立项', status: 'completed', reportIds: ['report-a'] },
    { id: 'stage-2', title: '调研', status: 'completed', reportIds: ['report-b'] },
    { id: 'stage-3', title: '交付', status: 'completed', reportIds: ['report-c'] },
  ]
  const movedBack = applyReportDeliveryToMilestones(current, 'report-b', 'stage-1', 'stage').milestones
  assert.deepEqual(movedBack.map((milestone) => milestone.status), ['completed', 'in_progress', 'not_started'])
  assert.deepEqual(movedBack[2].reportIds, ['report-c'])
})

test('deletion reconciliation does not complete stages after the first delivery gap', () => {
  const current: Milestone[] = [
    { id: 'stage-1', title: '立项', status: 'completed', reportIds: ['report-a'] },
    { id: 'stage-2', title: '调研', status: 'completed' },
    { id: 'stage-3', title: '交付', status: 'completed', reportIds: ['report-c'] },
  ]
  const reconciled = reconcileMilestonesAfterReportDeletion(current, [
    { milestoneId: 'stage-1', deliveryType: 'stage' },
    { milestoneId: 'stage-3', deliveryType: 'stage' },
  ])
  assert.deepEqual(reconciled.map((milestone) => milestone.status), ['completed', 'in_progress', 'not_started'])
})

test('a milestone cannot exceed the persisted report limit', () => {
  const full: Milestone[] = [{
    id: 'stage-1',
    title: '立项',
    status: 'in_progress',
    reportIds: Array.from({ length: 100 }, (_, index) => `report-${index}`),
  }]
  assert.throws(
    () => applyReportDeliveryToMilestones(full, 'report-100', 'stage-1', 'stage'),
    /最多关联 100 份报告/,
  )
  assert.equal(applyReportDeliveryToMilestones(full, 'report-99', 'stage-1', 'stage').milestones[0].reportIds?.length, 100)
})

test('missing milestone is rejected', () => {
  assert.throws(() => applyReportDeliveryToMilestones(milestones(), 'report-1', 'missing', 'stage'), /不存在/)
})

test('remaining final delivery keeps every milestone complete after a backward stage move', () => {
  const current: Milestone[] = [
    { id: 'stage-1', title: '立项', status: 'completed', reportIds: ['report-a'] },
    { id: 'stage-2', title: '调研', status: 'completed', reportIds: ['report-b'] },
    { id: 'stage-3', title: '交付', status: 'completed', reportIds: ['report-c'] },
  ]
  const movedBack = applyReportDeliveryToMilestones(current, 'report-b', 'stage-1', 'stage').milestones
  const remaining = completeMilestonesWhenFinalRemains(movedBack, [
    { milestoneId: 'stage-1', deliveryType: 'stage' },
    { milestoneId: 'stage-1', deliveryType: 'stage' },
    { milestoneId: 'stage-3', deliveryType: 'final' },
  ])
  assert.deepEqual(remaining.map((milestone) => milestone.status), ['completed', 'completed', 'completed'])
  assert.deepEqual(movedBack.map((milestone) => milestone.status), ['completed', 'in_progress', 'not_started'])
})

test('stage reassignment without a remaining final still uses original adjustment rules', () => {
  const current: Milestone[] = [
    { id: 'stage-1', title: '立项', status: 'completed', reportIds: ['report-a'] },
    { id: 'stage-2', title: '调研', status: 'completed', reportIds: ['report-b'] },
    { id: 'stage-3', title: '交付', status: 'completed', reportIds: ['report-c'] },
  ]
  const movedBack = applyReportDeliveryToMilestones(current, 'report-b', 'stage-1', 'stage').milestones
  const remaining = completeMilestonesWhenFinalRemains(movedBack, [
    { milestoneId: 'stage-1', deliveryType: 'stage' },
    { milestoneId: 'stage-1', deliveryType: 'stage' },
    { milestoneId: 'stage-3', deliveryType: 'stage' },
  ])
  assert.deepEqual(remaining.map((milestone) => milestone.status), ['completed', 'in_progress', 'not_started'])
})

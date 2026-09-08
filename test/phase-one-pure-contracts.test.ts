import assert from 'node:assert/strict'
import test from 'node:test'

import { parsePagination, pageResult, PaginationRangeError, MAX_OFFSET } from '../lib/http/pagination'
import { nextExpandedIndexAfterDelete } from '../components/admin/ai-settings-types'
import { parseWorkspaceSearch } from '../lib/workspace-url'
import {
  evaluationContextsEqual,
  parseReportEvaluationContext,
  resolveReportEvaluationContext,
} from '../modules/analysis/evaluation-context'
import { PROJECT_FIELD_LIMITS, validateProjectConfiguration } from '../modules/projects/validation'
import type { Project, Milestone } from '../modules/projects/domain'
import type { ReportVersion } from '../modules/reports/domain'
import type { ReportEvaluationContext } from '../modules/contracts/analysis'

function createMilestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: 'stage-1',
    title: '阶段一',
    targetDate: '2026-12-31',
    description: '完成阶段目标与预期成果',
    status: 'not_started',
    ...overrides,
  }
}

function createProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    ownerId: 'user-1',
    title: '测试课题',
    objective: '研究目标',
    description: '研究背景',
    ownerName: '测试用户',
    status: 'in_progress',
    milestones: [createMilestone()],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function createReport(overrides: Partial<ReportVersion> = {}): ReportVersion {
  return {
    id: 'report-1',
    projectId: 'project-1',
    milestoneId: 'stage-1',
    version: 1,
    title: '测试报告',
    fileName: 'report.docx',
    fileHash: 'hash-1',
    paragraphCount: 1,
    characterCount: 10,
    parseStatus: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function createEvaluationContext(overrides: Partial<ReportEvaluationContext> = {}): ReportEvaluationContext {
  return {
    projectId: 'project-1',
    projectTitle: '测试课题',
    researchObjective: '研究目标',
    researchBackground: '研究背景',
    milestone: {
      id: 'stage-1',
      title: '阶段一',
      targetDate: '2026-12-31',
      workAndExpectedOutcomes: '完成阶段目标与预期成果',
    },
    ...overrides,
  }
}

test('项目配置验证覆盖有效边界和失败边界', () => {
  const base = {
    title: '测试课题',
    objective: '研究目标',
    description: '研究背景',
    milestones: [createMilestone()],
  }
  const cases: Array<{ name: string; input: typeof base; expected?: string }> = [
    { name: '最小有效配置', input: base },
    { name: '字段长度刚好达到上限', input: { ...base, title: '题'.repeat(PROJECT_FIELD_LIMITS.title) } },
    { name: '标题为空', input: { ...base, title: '   ' }, expected: '课题名称不能为空。' },
    { name: '标题超过上限', input: { ...base, title: '题'.repeat(PROJECT_FIELD_LIMITS.title + 1) }, expected: '课题字段长度超过限制。' },
    { name: '阶段为空', input: { ...base, milestones: [] }, expected: '请至少创建一个研究阶段。' },
    { name: '阶段数超过上限', input: { ...base, milestones: Array.from({ length: 13 }, (_, index) => createMilestone({ id: 'stage-' + index })) }, expected: '研究阶段不能超过 12 个。' },
    { name: '阶段编号重复', input: { ...base, milestones: [createMilestone(), createMilestone({ title: '阶段二' })] }, expected: '阶段 2 的编号为空、过长或重复。' },
    { name: '日期不是实际日期', input: { ...base, milestones: [createMilestone({ targetDate: '2026-02-30' })] }, expected: '请为阶段 1 选择有效的计划完成日期。' },
    { name: '阶段说明为空', input: { ...base, milestones: [createMilestone({ description: ' ' })] }, expected: '请填写阶段 1 的工作内容与预期成果。' },
  ]

  for (const item of cases) {
    assert.equal(validateProjectConfiguration(item.input), item.expected, item.name)
  }
})

test('报告评价上下文解析覆盖所有错误契约和成功契约', () => {
  const project = createProject()
  const report = createReport()
  const cases: Array<{ name: string; project?: Project; report?: ReportVersion; code?: string }> = [
    { name: '缺少课题', report, code: 'PROJECT_CONTEXT_INCOMPLETE' },
    { name: '缺少报告', project, code: 'PROJECT_CONTEXT_INCOMPLETE' },
    { name: '课题不匹配', project, report: createReport({ projectId: 'other-project' }), code: 'PROJECT_CONTEXT_INCOMPLETE' },
    { name: '报告未分配阶段', project, report: createReport({ milestoneId: undefined }), code: 'REPORT_STAGE_REQUIRED' },
    { name: '阶段不存在', project, report: createReport({ milestoneId: 'missing-stage' }), code: 'REPORT_STAGE_NOT_FOUND' },
    { name: '课题字段不完整', project: createProject({ objective: '   ' }), report, code: 'PROJECT_CONTEXT_INCOMPLETE' },
    { name: '上下文完整', project, report },
  ]

  for (const item of cases) {
    const result = resolveReportEvaluationContext(item.project, item.report)
    if (item.code) assert.equal(result.issue?.code, item.code, item.name)
    else assert.equal('context' in result, true, item.name)
  }

  const resolved = resolveReportEvaluationContext(createProject({ title: '  测试课题  ' }), report)
  assert.deepEqual(resolved.context, createEvaluationContext())
})

test('持久化评价上下文只接受可收窄的非空字符串字段', () => {
  const valid = createEvaluationContext()
  const cases: Array<{ name: string; value: unknown; accepted: boolean }> = [
    { name: '对象', value: valid, accepted: true },
    { name: 'JSON 字符串', value: JSON.stringify(valid), accepted: true },
    { name: '非法 JSON', value: '{', accepted: false },
    { name: '数组', value: [], accepted: false },
    { name: '缺少阶段', value: { ...valid, milestone: undefined }, accepted: false },
    { name: '空白字段', value: { ...valid, projectId: '   ' }, accepted: false },
  ]

  for (const item of cases) {
    assert.equal(Boolean(parseReportEvaluationContext(item.value)), item.accepted, item.name)
  }

  assert.equal(evaluationContextsEqual(valid, createEvaluationContext()), true)
  assert.equal(evaluationContextsEqual(valid, createEvaluationContext({ projectTitle: '不同课题' })), false)
  assert.equal(evaluationContextsEqual(undefined, valid), false)
})

test('分页解析覆盖默认值、配置边界和非法输入', () => {
  const cases = [
    { query: '', defaults: {}, expected: { limit: 100, offset: 0 } },
    { query: '?limit=1&offset=0', defaults: {}, expected: { limit: 1, offset: 0 } },
    { query: '?limit=100&offset=100000', defaults: {}, expected: { limit: 100, offset: 100000 } },
    { query: '?limit=nope&offset=-1', defaults: { limit: 20, maxLimit: 30 }, expected: { limit: 20, offset: 0 } },
    { query: '?limit=40', defaults: { limit: 50, maxLimit: 30 }, expected: { limit: 30, offset: 0 } },
  ]

  for (const item of cases) {
    assert.deepEqual(parsePagination(new Request('https://example.test/api/items' + item.query), item.defaults), item.expected, item.query)
  }

  assert.deepEqual(pageResult(['a', 'b'], 3, { limit: 2, offset: 0 }), {
    items: ['a', 'b'], total: 3, limit: 2, offset: 0, hasMore: true,
  })
  assert.equal(pageResult(['c'], 3, { limit: 2, offset: 2 }).hasMore, false)
  assert.equal(pageResult([], 3, { limit: 2, offset: 0 }).hasMore, false)
  assert.equal(pageResult(Array.from({ length: 100 }, () => 'x'), 200_000, { limit: 100, offset: MAX_OFFSET - 50 }).hasMore, false)
  assert.throws(
    () => parsePagination(new Request('https://example.test/api/items?limit=101&offset=100001')),
    PaginationRangeError,
  )
})

test('deleting a model card shifts later expanded indexes down', () => {
  assert.equal(nextExpandedIndexAfterDelete(null, 0), null)
  assert.equal(nextExpandedIndexAfterDelete(2, 2), null)
  assert.equal(nextExpandedIndexAfterDelete(3, 1), 2)
  assert.equal(nextExpandedIndexAfterDelete(1, 2), 1)
})

test('工作台 URL 只保留与视图匹配的参数', () => {
  const cases = [
    { search: '?view=insight&project=p1&report=r1', expected: { view: 'insight', projectId: 'p1', reportId: 'r1' } },
    { search: '?view=history', expected: { view: 'overview', projectId: '' } },
    { search: '?view=unknown&project=p1', expected: { view: 'dashboard', projectId: 'p1' } },
    { search: '?view=reports&project=p1&report=r1', expected: { view: 'reports', projectId: '' } },
  ] as const

  for (const item of cases) assert.deepEqual(parseWorkspaceSearch(item.search), item.expected, item.search)
})

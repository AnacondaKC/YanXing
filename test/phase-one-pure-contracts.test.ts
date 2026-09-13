import assert from 'node:assert/strict'
import test from 'node:test'

import { parsePagination, pageResult, PaginationRangeError, MAX_OFFSET } from '../lib/http/pagination'
import { nextExpandedIndexAfterDelete } from '../components/admin/ai-settings-types'
import { parseWorkspaceSearch } from '../lib/workspace-url'
import {
  parseReportEvaluationContext,
} from '../modules/analysis/evaluation-context'
import type { ReportEvaluationContext } from '../modules/contracts/analysis'

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

import assert from 'node:assert/strict'
import test from 'node:test'
import { isInsightGenerationInFlight } from '../components/insight-workspace'
import { insightEmptyCopy, insightEmptyKind } from '../lib/insight-empty-state'

test('failed insight jobs are not treated as still generating', () => {
  assert.equal(isInsightGenerationInFlight({ job: { id: 'job-1', status: 'failed', errorMessage: '模型调用失败。' } }), false)
  assert.equal(isInsightGenerationInFlight({ job: { id: 'job-2', status: 'queued' } }), true)
  assert.equal(isInsightGenerationInFlight({ generating: true }), true)
})

test('insight empty copy stays calm and specific to the current gap', () => {
  assert.equal(insightEmptyKind(false, false), 'missing-report')
  assert.equal(insightEmptyKind(true, true), 'generating')
  assert.equal(insightEmptyKind(true, false), 'ready')

  const missing = insightEmptyCopy('missing-report')
  assert.match(missing.lead, /洞察/)
  assert.match(missing.highlight, /上传/)
  assert.match(missing.action, /上传/)

  const generating = insightEmptyCopy('generating')
  assert.match(generating.status, /生成/)
  assert.equal(generating.action, '正在生成')
  assert.match(generating.highlight, /速读/)

  const ready = insightEmptyCopy('ready')
  assert.match(ready.action, /洞察/)
  assert.match(ready.highlight, /速读/)
})

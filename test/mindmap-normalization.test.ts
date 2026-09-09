import assert from 'node:assert/strict'
import test from 'node:test'
import { Value } from 'typebox/value'
import { normalizePageMindMapPayload } from '../modules/analysis/mind-map'
import { validatePageAnalysisOutput } from '../modules/analysis/gates'
import { AnalysisArtifactSchemas, MAX_MINDMAP_CHILDREN, MAX_MINDMAP_DEPTH, MAX_MINDMAP_LABEL_LENGTH, MAX_MINDMAP_NODES, type PageAnalysisMindMapNode } from '../modules/contracts/analysis'

function acceptsMindMap(payload: unknown): boolean {
  assert.ok(payload && typeof payload === 'object' && '思维导图' in payload)
  return Value.Check(AnalysisArtifactSchemas.page_analysis.properties['思维导图'], payload['思维导图'])
    && validatePageAnalysisOutput({ '思维导图': payload['思维导图'] }).length === 0
}

function pageWithChild(child: unknown) {
  return { '思维导图': { '名称': '研究报告', '子节点': [child] } }
}

test('fills only missing leaf arrays without mutating input or other report content', () => {
  const raw = {
    ...pageWithChild({ '名称': '研究结论', '子节点': [{ '名称': '执行条件' }, { '名称': '风险', '子节点': [] }] }),
    '综合评分': { '研究价值': 80 },
  }
  const original = structuredClone(raw)
  const normalized = normalizePageMindMapPayload(raw)
  assert.deepEqual(raw, original)
  assert.deepEqual(normalized.repairedPaths, ['/思维导图/子节点/0/子节点/0/子节点'])
  assert.deepEqual(normalized.payload, {
    ...raw,
    ...pageWithChild({ '名称': '研究结论', '子节点': [{ '名称': '执行条件', '子节点': [] }, { '名称': '风险', '子节点': [] }] }),
  })
  assert.equal(acceptsMindMap(normalized.payload), true)
  const repeated = normalizePageMindMapPayload(normalized.payload)
  assert.equal(repeated.payload, normalized.payload)
  assert.deepEqual(repeated.repairedPaths, [])
})

test('leaves valid payloads and unrelated root values unchanged', () => {
  for (const raw of [null, undefined, [], 'invalid', {}, pageWithChild({ '名称': '叶子', '子节点': [] })]) {
    const result = normalizePageMindMapPayload(raw)
    assert.equal(result.payload, raw)
    assert.deepEqual(result.repairedPaths, [])
  }
})

test('does not repair a missing or empty root child array', () => {
  for (const root of [{ '名称': '根节点' }, { '名称': '根节点', '子节点': [] }, null, []]) {
    const raw = { '思维导图': root }
    const result = normalizePageMindMapPayload(raw)
    assert.equal(result.payload, raw)
    assert.deepEqual(result.repairedPaths, [])
    assert.equal(acceptsMindMap(result.payload), false)
  }
})

test('rejects malformed children, aliases and invalid labels instead of discarding them', () => {
  const malformedChildren: unknown[] = [
    null, '叶子', 1, [], {},
    { '名称': '叶子', '子节点': null },
    { '名称': '叶子', '子节点': '[]' },
    { '名称': '叶子', '子节点': {} },
    { '名称': '叶子', '子节点': undefined },
    { '名称': '叶子', children: [{ '名称': '重要内容' }] },
    { '名称': '叶子', extra: '不能丢失' },
    { '名称': ' ' },
    { '名称': '\u200B\u200C\u200D\uFEFF' },
    { '名称': 42 },
    { '名称': '长'.repeat(MAX_MINDMAP_LABEL_LENGTH + 1) },
  ]
  for (const child of malformedChildren) {
    const raw = pageWithChild(child)
    const result = normalizePageMindMapPayload(raw)
    assert.equal(result.payload, raw)
    assert.deepEqual(result.repairedPaths, [])
    assert.equal(acceptsMindMap(result.payload), false)
  }
})

test('repairs leaves at every permitted depth but never beyond the depth limit', () => {
  for (let depth = 2; depth <= MAX_MINDMAP_DEPTH + 1; depth += 1) {
    let root: unknown = { '名称': '叶子' }
    for (let level = 1; level < depth; level += 1) root = { '名称': `层${level}`, '子节点': [root] }
    const raw = { '思维导图': root }
    const result = normalizePageMindMapPayload(raw)
    assert.equal(result.repairedPaths.length, depth <= MAX_MINDMAP_DEPTH ? 1 : 0)
    assert.equal(acceptsMindMap(result.payload), depth <= MAX_MINDMAP_DEPTH)
  }
})

test('retains over-wide arrays and does not turn them into valid trees', () => {
  const raw = { '思维导图': { '名称': '根', '子节点': Array.from({ length: MAX_MINDMAP_CHILDREN + 1 }, () => ({ '名称': '叶子' })) } }
  const result = normalizePageMindMapPayload(raw)
  assert.equal(result.payload, raw)
  assert.deepEqual(result.repairedPaths, [])
  assert.equal(acceptsMindMap(result.payload), false)
})

function buildTree(nodeCount: number): PageAnalysisMindMapNode {
  const root: PageAnalysisMindMapNode = { '名称': '根', '子节点': [] }
  const queue = [root]
  let created = 1
  for (let index = 0; created < nodeCount; index += 1) {
    const parent = queue[index]
    while (parent['子节点'].length < MAX_MINDMAP_CHILDREN && created < nodeCount) {
      const child: PageAnalysisMindMapNode = { '名称': `节点${created}`, '子节点': [] }
      parent['子节点'].push(child)
      queue.push(child)
      created += 1
    }
  }
  return root
}

test('preserves node-count boundaries and bounds repair work for oversized trees', () => {
  for (const count of [MAX_MINDMAP_NODES, MAX_MINDMAP_NODES + 1]) {
    const raw = { '思维导图': buildTree(count) }
    assert.equal(acceptsMindMap(normalizePageMindMapPayload(raw).payload), count <= MAX_MINDMAP_NODES)
  }
  const raw = { '思维导图': buildTree(MAX_MINDMAP_NODES * 2) }
  const omitted = JSON.parse(JSON.stringify(raw, (key, value) => key === '子节点' && Array.isArray(value) && value.length === 0 ? undefined : value)) as unknown
  const result = normalizePageMindMapPayload(omitted)
  assert.ok(result.repairedPaths.length <= MAX_MINDMAP_NODES - 1)
  assert.equal(acceptsMindMap(result.payload), false)
})

test('a repaired leaf does not hide another invalid node in the same tree', () => {
  const raw = { '思维导图': { '名称': '根', '子节点': [{ '名称': '可补齐' }, { '名称': '不可补齐', '子节点': null }] } }
  const original = structuredClone(raw)
  const result = normalizePageMindMapPayload(raw)
  assert.deepEqual(result.repairedPaths, ['/思维导图/子节点/0/子节点'])
  assert.equal(acceptsMindMap(result.payload), false)
  assert.deepEqual(raw, original)
  assert.deepEqual(result.payload, { '思维导图': { '名称': '根', '子节点': [{ '名称': '可补齐', '子节点': [] }, { '名称': '不可补齐', '子节点': null }] } })
})

test('bounds traversal of extremely deep untrusted trees', () => {
  let root: unknown = { '名称': '叶子' }
  for (let depth = 0; depth < 10_000; depth += 1) root = { '名称': '层', '子节点': [root] }
  const raw = { '思维导图': root }
  const result = normalizePageMindMapPayload(raw)
  assert.equal(result.payload, raw)
  assert.deepEqual(result.repairedPaths, [])
})

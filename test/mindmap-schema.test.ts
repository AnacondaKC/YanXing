import assert from 'node:assert/strict'
import test from 'node:test'
import { Value } from 'typebox/value'
import { AnalysisArtifactSchemas, MAX_MINDMAP_CHILDREN, MAX_MINDMAP_DEPTH, MAX_MINDMAP_LABEL_LENGTH } from '../modules/contracts/analysis'
import { serializeJsonSchema } from '../lib/ai/runtime/output-protocol'
import { getDefaultAiPromptConfig } from '../lib/ai/prompt-defaults'
import { PAGE_ANALYSIS_MIND_MAP_CONSTRAINTS, REPORT_INSIGHT_PROGRAM_CONSTRAINTS, STRUCTURED_ANALYSIS_PROGRAM_CONSTRAINTS } from '../lib/ai/prompt-constraints'
import { runAnalysisModuleAgent } from '../lib/ai/restricted-analysis-agent'

interface SerializedSchema {
  type?: string
  properties?: Record<string, SerializedSchema>
  required?: string[]
  additionalProperties?: boolean
  items?: SerializedSchema
  maxItems?: number
  minItems?: number
  maxLength?: number
}

const mindMapSchema = AnalysisArtifactSchemas.page_analysis.properties['思维导图']

test('serialized mind-map schema explicitly constrains every node level and leaf arrays', () => {
  let node: SerializedSchema = serializeJsonSchema(mindMapSchema)
  for (let depth = 1; depth <= MAX_MINDMAP_DEPTH; depth += 1) {
    assert.equal(node.type, 'object')
    assert.equal(node.additionalProperties, false)
    assert.deepEqual(node.required?.toSorted(), ['名称', '子节点'].toSorted())
    assert.equal(node.properties?.['名称'].type, 'string')
    assert.equal(node.properties?.['名称'].maxLength, MAX_MINDMAP_LABEL_LENGTH)
    const children = node.properties?.['子节点']
    assert.ok(children)
    assert.equal(children.type, 'array')
    assert.equal(children.maxItems, depth === MAX_MINDMAP_DEPTH ? 0 : MAX_MINDMAP_CHILDREN)
    if (depth === 1) assert.equal(children.minItems, 1)
    assert.ok(children.items)
    assert.equal(children.items.type, 'object')
    node = children.items
  }
})

function wrapAtDepth(node: unknown, depth: number): unknown {
  let root = node
  for (let level = 1; level < depth; level += 1) root = { '名称': '父节点', '子节点': [root] }
  return root
}

test('schema rejects missing fields and malformed nodes at every depth before business gates', () => {
  for (let depth = 1; depth <= MAX_MINDMAP_DEPTH; depth += 1) {
    for (const invalid of [
      { '名称': '未提供数组' }, { '子节点': [] }, { '名称': '错误类型', '子节点': null },
      { '名称': '错误字段', '子节点': [], children: [] }, '文本节点',
    ]) {
      assert.equal(Value.Check(mindMapSchema, wrapAtDepth(invalid, depth)), false)
    }
  }
  assert.equal(Value.Check(mindMapSchema, { '名称': '空根', '子节点': [] }), false)
  assert.equal(Value.Check(mindMapSchema, wrapAtDepth({ '名称': '叶子', '子节点': [] }, MAX_MINDMAP_DEPTH)), true)
  assert.equal(Value.Check(mindMapSchema, wrapAtDepth({ '名称': '叶子', '子节点': [] }, MAX_MINDMAP_DEPTH + 1)), false)
})

test('fixed and default analysis prompts share leaf rules without changing insight output rules', () => {
  assert.ok(STRUCTURED_ANALYSIS_PROGRAM_CONSTRAINTS.includes(PAGE_ANALYSIS_MIND_MAP_CONSTRAINTS))
  assert.ok(getDefaultAiPromptConfig('page_analysis').instructionPrompt.includes(PAGE_ANALYSIS_MIND_MAP_CONSTRAINTS))
  assert.match(PAGE_ANALYSIS_MIND_MAP_CONSTRAINTS, /叶子节点必须输出空数组 \[\]/)
  assert.match(PAGE_ANALYSIS_MIND_MAP_CONSTRAINTS, /"子节点":\[\]/)
  assert.equal(REPORT_INSIGHT_PROGRAM_CONSTRAINTS.includes(PAGE_ANALYSIS_MIND_MAP_CONSTRAINTS), false)
  assert.equal(getDefaultAiPromptConfig('report_insight').instructionPrompt.includes(PAGE_ANALYSIS_MIND_MAP_CONSTRAINTS), false)
})

test('old frozen custom prompts still receive fixed leaf rules on the first model request', async (context) => {
  const promptConfig = { ...getDefaultAiPromptConfig('page_analysis'), systemPrompt: '旧版自定义系统提示词', instructionPrompt: '旧版任务要求', version: 7 }
  const originalConfig = structuredClone(promptConfig)
  let requestBody: { messages: { role: string; content: string }[] } | undefined
  const mockFetch: typeof fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '{}' } }],
      usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const fetchMock = context.mock.method(globalThis, 'fetch', mockFetch)
  await runAnalysisModuleAgent({
    moduleId: 'page_analysis', prompt: promptConfig.instructionPrompt, promptConfig,
    schema: AnalysisArtifactSchemas.page_analysis, documentText: '研究报告正文', attempt: 1,
    runtime: { primary: { id: 'test-model', provider: 'chat_completions', baseUrl: 'http://127.0.0.1:9/v1' }, apiKey: 'test-key', maxContextCharacters: 40_000 },
  })
  assert.equal(fetchMock.mock.calls.length, 1)
  assert.ok(requestBody)
  const system = requestBody.messages.find((message) => message.role === 'system')?.content
  assert.ok(system?.includes(promptConfig.systemPrompt))
  assert.ok(system?.includes(PAGE_ANALYSIS_MIND_MAP_CONSTRAINTS))
  assert.deepEqual(promptConfig, originalConfig)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBudgetedDocumentPrompt, createAnalysisPromptPlan, PromptBudgetError } from '../lib/ai/prompt-budget'
import { getDefaultAiPromptConfig } from '../lib/ai/prompt-defaults'
import { runAnalysisModuleAgent } from '../lib/ai/restricted-analysis-agent'
import { runReportInsightAgent } from '../lib/ai/report-insight-agent'
import { buildPageAnalysisTaskPrompt } from '../modules/analysis/prompt'
import { AnalysisArtifactSchemas } from '../modules/contracts/analysis'

const config = getDefaultAiPromptConfig('page_analysis')
const taskPrompt = buildPageAnalysisTaskPrompt({ instructionPrompt: config.instructionPrompt })
const planInput = { target: 'page_analysis' as const, systemPrompt: config.systemPrompt, taskPrompt, maxContextCharacters: 8_000, modelLabel: 'test-model' }

test('prompt budget counts the same fixed protocol and rejects the exact boundary minus one', () => {
  for (const target of ['page_analysis', 'report_insight'] as const) {
    const input = { ...planInput, target }
    const plan = createAnalysisPromptPlan(input)
    const boundary = createAnalysisPromptPlan({ ...input, maxContextCharacters: plan.requiredCharacters })
    assert.ok(boundary.documentCharacterBudget > 0)
    assert.throws(() => createAnalysisPromptPlan({ ...input, maxContextCharacters: plan.requiredCharacters - 1 }), (error: unknown) => {
      assert.ok(error instanceof PromptBudgetError)
      assert.equal(error.requiredCharacters, plan.requiredCharacters)
      assert.equal(error.maxContextCharacters, plan.requiredCharacters - 1)
      assert.equal(error.retryable, false)
      assert.equal(error.code, 'prompt_context_exceeded')
      return true
    })
  }
})

test('document clipping preserves task metadata and accounts for its omission marker', () => {
  const prompt = buildPageAnalysisTaskPrompt({
    instructionPrompt: '任务起点' + '必须保留的规则'.repeat(100) + '任务终点',
    reportFacts: { paragraphCount: 10, characterCount: 100_000 },
    previousErrors: [{ code: 'SCHEMA_INVALID', path: '/思维导图/子节点/0/子节点', message: '必须是数组' }],
  })
  const plan = createAnalysisPromptPlan({ ...planInput, taskPrompt: prompt })
  const result = buildBudgetedDocumentPrompt(plan, '正文开始' + '原始正文'.repeat(10_000) + '正文结束')
  assert.ok(result.startsWith(plan.promptPrefix))
  assert.ok(result.includes('任务起点') && result.includes('任务终点'))
  assert.ok(result.includes('/思维导图/子节点/0/子节点'))
  assert.ok(result.includes('正文开始') && result.includes('正文结束'))
  assert.ok(result.includes('正文中间部分已省略'))
  assert.equal(plan.systemPrompt.length + result.length + plan.outputProtocol.length, plan.maxContextCharacters)
  assert.equal(buildBudgetedDocumentPrompt(plan, '短正文'), plan.promptPrefix + '短正文')
})

test('the final model request keeps instructions and schema intact within the configured context', async (context) => {
  const prompt = buildPageAnalysisTaskPrompt({ instructionPrompt: config.instructionPrompt, previousErrors: [{ code: 'SCHEMA_INVALID', path: '/思维导图/子节点/0/子节点', message: '必须是数组' }] })
  let messages: { role: string; content: string }[] = []
  const fetchMock: typeof fetch = async (_url, init) => {
    messages = JSON.parse(String(init?.body)).messages
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { headers: { 'content-type': 'application/json' } })
  }
  context.mock.method(globalThis, 'fetch', fetchMock)
  await runAnalysisModuleAgent({ moduleId: 'page_analysis', prompt, promptConfig: config, schema: AnalysisArtifactSchemas.page_analysis, documentText: '研究正文'.repeat(20_000), attempt: 2, runtime: { primary: { id: 'test-model', provider: 'chat_completions', baseUrl: 'http://127.0.0.1:9/v1', maxContextCharacters: 8_000 }, apiKey: 'test-key', maxContextCharacters: 8_000 } })
  assert.ok(messages.reduce((count, message) => count + message.content.length, 0) <= 8_000)
  const user = messages.find((message) => message.role === 'user')?.content
  assert.ok(user?.startsWith(prompt))
  assert.ok(user?.includes(JSON.stringify(AnalysisArtifactSchemas.page_analysis)))
  assert.equal(user?.includes('[提示词内容已按最大上下文截取。]'), false)
})

test('old frozen prompts fail before network or billing callbacks without mutating configuration', async (context) => {
  const frozen = { ...config, systemPrompt: '研'.repeat(4_500), version: 7 }
  const original = structuredClone(frozen)
  const fetchMock = context.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network call') })
  let started = 0
  const runtime = { primary: { id: 'old-model', provider: 'chat_completions' as const, baseUrl: 'http://127.0.0.1:9/v1', maxContextCharacters: 8_000 }, apiKey: 'test-key', maxContextCharacters: 8_000 }
  await assert.rejects(() => runAnalysisModuleAgent({ moduleId: 'page_analysis', prompt: taskPrompt, promptConfig: frozen, schema: AnalysisArtifactSchemas.page_analysis, documentText: '报告正文', attempt: 1, runtime, onCallStarted: () => { started += 1 } }), (error: unknown) => {
    assert.ok(error instanceof PromptBudgetError)
    assert.ok(error.requiredCharacters > 8_000)
    assert.match(error.message, /至少需要.*上限为 8000/)
    return true
  })
  await assert.rejects(() => runReportInsightAgent({ promptConfig: { ...frozen, target: 'report_insight', systemPrompt: '研'.repeat(8_000) }, file: { path: '/nonexistent-document-must-not-be-read' }, runtime }), PromptBudgetError)
  assert.equal(fetchMock.mock.calls.length, 0)
  assert.equal(started, 0)
  assert.deepEqual(frozen, original)
})

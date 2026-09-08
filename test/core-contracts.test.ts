import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const directory = await mkdtemp(tmpdir() + '/yanxing-core-contracts-')
const environment = process.env as Record<string, string | undefined>
const originalNodeEnv = environment.NODE_ENV
const originalModelCallsPerMinute = environment.YANXING_MODEL_CALLS_PER_MINUTE
environment.NODE_ENV = 'development'
environment.YANXING_DATABASE_PATH = path.join(directory, 'core-contracts.sqlite')
environment.YANXING_MODEL_CALLS_PER_MINUTE = '1000'

const { migrateDatabase } = await import('../lib/db/client')
migrateDatabase()
test.after(async () => {
  await rm(directory, { recursive: true, force: true })
  if (originalNodeEnv === undefined) delete environment.NODE_ENV
  else environment.NODE_ENV = originalNodeEnv
  if (originalModelCallsPerMinute === undefined) delete environment.YANXING_MODEL_CALLS_PER_MINUTE
  else environment.YANXING_MODEL_CALLS_PER_MINUTE = originalModelCallsPerMinute
})

// The node test runner may overlap sibling tests; serialize tests that share fetch/env globals.
let sharedStateTail = Promise.resolve()
let releaseSharedState: (() => void) | undefined
test.beforeEach(async () => {
  const previous = sharedStateTail
  let release!: () => void
  sharedStateTail = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  releaseSharedState = release
})
test.afterEach(() => {
  releaseSharedState?.()
  releaseSharedState = undefined
})

import {
  normalizeChatCompletionsBaseUrl,
  toChatCompletionsUrl,
} from '../lib/ai/runtime/chat-completions'
import { readResponseBytes, requestJson } from '../lib/ai/runtime/http'
import {
  buildChatRequest,
  runStructuredJson as runChatCompletionsStructuredJson,
  runText as runChatCompletionsText,
} from '../lib/ai/execute'
import { ChatCompletionsError } from '../lib/ai/runtime/errors'
import {
  validateModuleOutput,
  validatePageAnalysisOutput,
} from '../modules/analysis/gates'
import { retryDelay } from '../modules/analysis/pipeline'
import { buildVisualizationWordCloudItems, completeWordCloudOutput } from '../modules/analysis/word-cloud'
import { pageAnalysisModule } from '../modules/analysis/modules'
import { getDefaultAiPromptConfig } from '../lib/ai/prompt-defaults'
import { buildAnalysisProgress } from '../modules/analysis/progress'
import type { AnalysisJob } from '../modules/analysis/domain'
import { getVisualizationData } from '../lib/rendering/visualizations'
import { createWordCloudLayout } from '../lib/rendering/word-cloud-layout'
import { getMindMapNodeGeometry, getNodeDisplayLabel, getRootLabelLines } from '../lib/rendering/graph-layout'
import {
  AiScoreDimensions,
  AnalysisArtifactSchemas,
  ANALYSIS_SNAPSHOT_SCHEMA_VERSION,
  AnalysisStages,
  MAX_AI_SUGGESTIONS,
  MIN_WORD_CLOUD_KEYWORDS,
  MAX_WORD_CLOUD_KEYWORDS,
  ReportCompletenessDimensions,
  type AnalysisModuleState,
  type AnalysisSnapshotPayload,
  type PageAnalysisArtifact,
  type PageAnalysisMindMapNode,
  type ReportFacts,
} from '../modules/contracts/analysis'
import { persistReportStream, ReportUploadError } from '../lib/documents/report-storage'
import { isValidMaxOutputTokens } from '../lib/ai/runtime-options'
import { accountModelTokens, ModelUsageIncompleteError } from '../lib/ai/usage'

function createAnalysisJob(input: Partial<AnalysisJob> = {}): AnalysisJob {
  return {
    id: 'job-progress-test',
    reportVersionId: 'report-progress-test',
    type: 'initial',
    status: 'running',
    stage: 'validating',
    stageIndex: 0,
    attempts: 1,
    cancelRequested: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...input,
  }
}

function createModuleState(moduleId: AnalysisModuleState['moduleId'], status: AnalysisModuleState['status'], attempt = 1): AnalysisModuleState {
  return {
    moduleId,
    status,
    attempt,
    maxAttempts: 3,
    gateErrors: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function createReportFacts(): ReportFacts {
  return {
    title: '测试报告',
    paragraphCount: 2,
    characterCount: 22,
  }
}

function createWordCloudWords(count = MIN_WORD_CLOUD_KEYWORDS) {
  return Array.from({ length: count }, (_, index) => `主题${String.fromCodePoint(0x4e00 + index)}`)
}

function createPageSections(count = 1) {
  return Array.from({ length: count }, (_, index) => index === 0
    ? { '标题': '正文', '摘要': '分析项目投资方案与现金流安排。' }
    : { '标题': `章节${index + 1}`, '摘要': `第 ${index + 1} 章摘要。` })
}

function createPageAnalysis(overrides: Partial<PageAnalysisArtifact> = {}): PageAnalysisArtifact {
  return {
    '综合评分': {
      '研究价值': 80,
      '方法严谨': 75,
      '证据质量': 82,
      '逻辑一致': 78,
      '结论强度': 72,
      '可执行性': 70,
      '主要影响因素': '证据质量影响综合表现',
    },
    '报告详情': {
      '章节': createPageSections(),
      '完整度结论': '整体完整度良好',
    },
    '报告完整度': {
      '研究目标': 80,
      '方法与数据': 75,
      '证据覆盖': 82,
      '分析结构': 78,
      '结论覆盖': 72,
      '风险与建议': 70,
      '主要缺口': '方法与建议仍需补充验证',
    },
    '思维导图': { '名称': '项目投资分析', '子节点': [{ '名称': '收益', '子节点': [] }, { '名称': '风险', '子节点': [] }] },
    '词云': createWordCloudWords(),
    '热力图': [{
      '章节': '正文',
      '文献综述': 100,
      '定性分析': 55,
      '定量建模': 30,
      '案例研究': 0,
      '实地调研': 0,
      '对比分析': 45,
    }],
    'AI建议': ['补充现金流压力测试和风险缓释措施。'],
    ...overrides,
  }
}

function buildMindMapTree(count: number): PageAnalysisMindMapNode {
  const root: PageAnalysisMindMapNode = { '名称': '根节点', '子节点': [] }
  const queue = [root]
  let created = 1
  while (created < count && queue.length) {
    const current = queue.shift()!
    const capacity = Math.min(12, count - created)
    for (let index = 0; index < capacity; index += 1) {
      const child: PageAnalysisMindMapNode = { '名称': `节点${created + 1}`, '子节点': [] }
      current['子节点'].push(child)
      queue.push(child)
      created += 1;
    }
  }
  return root
}

function validatePageAnalysis(output: unknown) {
  return validateModuleOutput({
    schema: AnalysisArtifactSchemas.page_analysis,
    output,
    extra: validatePageAnalysisOutput,
  })
}

type ProviderErrorDetails = Error & { code?: unknown; retryable?: unknown }

async function expectProviderError(action: () => Promise<unknown>): Promise<ProviderErrorDetails> {
  let captured: unknown
  try {
    await action()
  } catch (error) {
    captured = error
  }
  assert.ok(captured instanceof Error)
  return captured as ProviderErrorDetails
}

test('chat request enforces JSON for structured calls and omits auto reasoning effort', () => {
  const jsonBody = buildChatRequest(
    { modelId: 'custom-model', maxOutputTokens: 4096, reasoningEffort: 'auto' },
    { type: 'json', system: 'system', user: 'prompt' },
  )
  assert.equal(jsonBody.model, 'custom-model')
  assert.deepEqual(jsonBody.response_format, { type: 'json_object' })
  assert.equal('reasoning_effort' in jsonBody, false)

  const textBody = buildChatRequest(
    { modelId: 'custom-model', reasoningEffort: 'high' },
    { type: 'text', system: 'system', user: 'prompt' },
  )
  assert.equal('response_format' in textBody, false)
  assert.equal(textBody.reasoning_effort, 'high')
})

test('generic Chat Completions runtime uses its configured endpoint and always enables JSON for structured output', async () => {
  const originalFetch = globalThis.fetch
  let requestUrl = ''
  let requestBody: Record<string, unknown> | undefined
  let requestRedirect: RequestRedirect | undefined
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input)
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    requestRedirect = init?.redirect
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  try {
    const result = await runChatCompletionsStructuredJson({
      model: {
        id: 'custom-model',
        provider: 'chat_completions',
        baseUrl: 'http://127.0.0.1/v1/chat/completions/',
        maxOutputTokens: 4096,
      },
      apiKey: 'test-key',
      systemPrompt: 'system',
      prompt: 'prompt',
      output: { name: 'test_output', description: 'submit result', schema: { type: 'object' } },
    })
    assert.deepEqual(result.value, { ok: true })
    assert.equal(normalizeChatCompletionsBaseUrl('http://127.0.0.1/v1/chat/completions/'), 'http://127.0.0.1/v1')
    assert.equal(requestUrl, 'http://127.0.0.1/v1/chat/completions')
    assert.equal(requestRedirect, undefined)
    assert.equal(requestBody?.model, 'custom-model')
    assert.equal(requestBody?.max_tokens, 4096)
    assert.equal(requestBody?.temperature, 0)
    assert.deepEqual(requestBody?.response_format, { type: 'json_object' })
    assert.equal('thinking' in (requestBody ?? {}), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('token accounting returns normalized input, output, and total tokens', () => {
  assert.deepEqual(accountModelTokens({
    inputTokens: 7,
    outputTokens: 5,
    totalTokens: 10,
    cacheHitTokens: 3,
    reasoningTokens: 2,
  }), {
    inputTokens: 7,
    outputTokens: 5,
    totalTokens: 12,
  })
  assert.throws(() => accountModelTokens({
    inputTokens: Number.MAX_SAFE_INTEGER,
    outputTokens: 1,
    totalTokens: Number.MAX_SAFE_INTEGER,
  }), ModelUsageIncompleteError)
})

test('token accounting rejects provider responses without complete token usage', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })

  try {
    const result = await runChatCompletionsStructuredJson({
      model: { id: 'custom-model', provider: 'chat_completions', baseUrl: 'http://127.0.0.1/v1', maxOutputTokens: 4096 },
      apiKey: 'test-key',
      systemPrompt: 'system',
      prompt: 'prompt',
      output: { name: 'test_output', description: 'submit result', schema: { type: 'object' } },
    })
    assert.equal(result.usage.usageComplete, false)
    assert.throws(() => accountModelTokens(result.usage), ModelUsageIncompleteError)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('generic Chat Completions preserves retryability for transient network failures', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new TypeError('network reset') }
  try {
    await assert.rejects(
      () => runChatCompletionsStructuredJson({
        model: { id: 'custom-model', provider: 'chat_completions', baseUrl: 'http://127.0.0.1/v1' },
        apiKey: 'test-key',
        systemPrompt: 'system',
        prompt: 'prompt',
        output: { name: 'test_output', description: 'submit result', schema: { type: 'object' } },
      }),
      (error: unknown) => error instanceof Error && 'retryable' in error && error.retryable === true,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('generic Chat Completions maps output failures to stable typed errors', async () => {
  const originalFetch = globalThis.fetch
  const scenarios = [
    { choice: { finish_reason: 'length', message: { content: 'partial' } }, code: 'length', retryable: false },
    { choice: { finish_reason: 'content_filter', message: { content: '' } }, code: 'content_filter', retryable: false },
    { choice: { finish_reason: 'tool_calls', message: { content: '' } }, code: 'tool_calls', retryable: false },
    { choice: { finish_reason: 'provider_specific_stop', message: { content: '' } }, code: 'invalid_model_output', retryable: false },
    { choice: { finish_reason: 'insufficient_system_resource', message: { content: '' } }, code: 'insufficient_system_resource', retryable: true },
    { choice: { finish_reason: 'stop', message: { content: '', reasoning_content: 'thinking' } }, code: 'reasoning_only', retryable: false },
    { choice: { finish_reason: 'stop', message: { content: '' } }, code: 'empty_json_content', retryable: true },
  ] as const

  try {
    for (const scenario of scenarios) {
      globalThis.fetch = async () => new Response(JSON.stringify({
        choices: [scenario.choice],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
      await assert.rejects(
        () => runChatCompletionsStructuredJson({
          model: { id: 'custom-model', provider: 'chat_completions', baseUrl: 'http://127.0.0.1/v1' },
          apiKey: 'test-key',
          systemPrompt: 'system',
          prompt: 'prompt',
          output: { name: 'test_output', description: 'submit result', schema: { type: 'object' } },
        }),
        (error: unknown) => {
          if (!(error instanceof ChatCompletionsError)) return false
          return error.code === scenario.code
            && error.retryable === scenario.retryable
            && error.usage?.totalTokens === 5
            && error.provider === 'chat_completions'
            && error.model === 'custom-model'
        },
      )
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('generic Chat Completions preserves status, Retry-After, and secret redaction', async () => {
  const originalFetch = globalThis.fetch
  const secret = 'sk-provider-contract-secret-1234567890'
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { code: 'insufficient_system_resource', message: `quota rejected ${secret}` },
  }), { status: 400, headers: { 'content-type': 'application/json', 'retry-after': '3' } })

  try {
    await assert.rejects(
      () => runChatCompletionsStructuredJson({
        model: { id: 'custom-model', provider: 'chat_completions', baseUrl: 'http://127.0.0.1/v1' },
        apiKey: secret,
        systemPrompt: 'system',
        prompt: 'prompt',
        output: { name: 'test_output', description: 'submit result', schema: { type: 'object' } },
      }),
      (error: unknown) => {
        if (!(error instanceof Error)) return false
        const typed = error as Error & { code?: unknown; status?: unknown; retryAfterMs?: unknown; retryable?: unknown }
        return typed.code === 'insufficient_system_resource'
          && typed.status === 400
          && typed.retryAfterMs === 3_000
          && typed.retryable === true
          && !error.message.includes(secret)
          && error.message.includes('[REDACTED]')
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('invalid Chat Completions URLs fail closed instead of falling back to OpenAI', () => {
  assert.throws(
    () => toChatCompletionsUrl('not a URL'),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'invalid_request'
      && 'retryable' in error
      && error.retryable === false,
  )
})

test('request start callbacks are awaited and can prevent the network request', async () => {
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  let callbackFinished = false
  globalThis.fetch = async () => {
    fetchCalls += 1
    assert.equal(callbackFinished, true)
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  try {
    const result = await requestJson({
      url: 'http://127.0.0.1/v1/chat/completions',
      apiKey: 'test-key',
      providerLabel: 'Chat Completions API',
      json: { prompt: 'test' },
      onRequestStarted: async () => {
        await Promise.resolve()
        callbackFinished = true
      },
    })
    assert.equal(result.ok, true)
    assert.equal(result.value.ok, true)
    await assert.rejects(
      () => requestJson({
        url: 'http://127.0.0.1/v1/chat/completions',
        apiKey: 'test-key',
        providerLabel: 'Chat Completions API',
        json: { prompt: 'blocked' },
        onRequestStarted: async () => {
          throw new Error('reservation failed')
        },
      }),
      /reservation failed/,
    )
    assert.equal(fetchCalls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('aborted request start does not invoke the start callback', async () => {
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  let callbackCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const controller = new AbortController()
  controller.abort()
  try {
    await assert.rejects(
      () => requestJson({
        url: 'http://127.0.0.1/v1/chat/completions',
        apiKey: 'test-key',
        providerLabel: 'Chat Completions API',
        json: { prompt: 'blocked' },
        signal: controller.signal,
        onRequestStarted: async () => {
          callbackCalls += 1
        },
      }),
      /请求已取消/,
    )
    assert.equal(fetchCalls, 0)
    assert.equal(callbackCalls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('response diagnostics redact decoded secrets, keys, and control characters', async () => {
  const originalFetch = globalThis.fetch
  const secret = 'sk-escaped-control-secret-123456789'
  const encodedSecret = '\\u0073k-escaped-control-secret-123456789'
  const responseText = JSON.stringify({
    details: { message: 'provider said ' + secret + '\nnext line' },
    [secret]: [secret, { nested: secret }],
  }).replaceAll(secret, encodedSecret)
  globalThis.fetch = async () => new Response(responseText, { status: 400 })

  try {
    const result = await requestJson({
      url: 'http://127.0.0.1/v1/chat/completions',
      apiKey: secret,
      providerLabel: 'Chat Completions API',
    })
    assert.equal(result.raw.includes(secret), false)
    assert.equal(JSON.stringify(result.value).includes(secret), false)
    assert.match(result.raw, /\[REDACTED\]/)
    assert.match(result.raw, /next line/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('successful JSON object diagnostics stringify raw only when read', async () => {
  const originalFetch = globalThis.fetch
  const payload = { ok: true, message: 'ready' }
  globalThis.fetch = async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    const result = await requestJson({
      url: 'http://127.0.0.1/v1/chat/completions',
      apiKey: 'test-key',
      providerLabel: 'Chat Completions API',
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value, payload)
    const descriptor = Object.getOwnPropertyDescriptor(result, 'raw')
    assert.equal(typeof descriptor?.get, 'function')
    assert.equal(result.raw, JSON.stringify(payload))
    assert.equal(result.raw, JSON.stringify(payload))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('HTTP status fallbacks and provider codes preserve stable retryability', async () => {
  const originalFetch = globalThis.fetch
  const scenarios = [
    { status: 401, code: 'unauthorized', retryable: false },
    { status: 402, code: 'payment_required', retryable: false },
    { status: 400, code: 'invalid_request', retryable: false },
    { status: 422, code: 'invalid_request', retryable: false },
  ] as const

  try {
    for (const scenario of scenarios) {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'rejected' } }), { status: scenario.status })
      await assert.rejects(
        () => runChatCompletionsStructuredJson({
          model: { id: 'custom-model', provider: 'chat_completions', baseUrl: 'http://127.0.0.1/v1' },
          apiKey: 'test-key',
          systemPrompt: 'system',
          prompt: 'prompt',
          output: { name: 'test_output', description: 'submit result', schema: { type: 'object' } },
        }),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === scenario.code
          && 'retryable' in error
          && error.retryable === scenario.retryable,
      )
    }

    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'invalid_request', message: 'bad input' } }), { status: 429 })
    await assert.rejects(
      () => runChatCompletionsStructuredJson({
        model: { id: 'custom-model', provider: 'chat_completions', baseUrl: 'http://127.0.0.1/v1' },
        apiKey: 'test-key',
        systemPrompt: 'system',
        prompt: 'prompt',
        output: { name: 'test_output', description: 'submit result', schema: { type: 'object' } },
      }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'invalid_request'
        && 'retryable' in error
        && error.retryable === false,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('missing credentials and text-empty output use stable non-retryable codes', async () => {
  let fetchCalls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    fetchCalls += 1
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }), { status: 200 })
  }

  try {
    await assert.rejects(
      () => runChatCompletionsStructuredJson({
        model: { id: 'custom-model', provider: 'chat_completions', baseUrl: 'http://127.0.0.1/v1' },
        apiKey: '  ',
        systemPrompt: 'system',
        prompt: 'prompt',
        output: { name: 'test_output', description: 'submit result', schema: { type: 'object' } },
      }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'unauthorized'
        && 'retryable' in error
        && error.retryable === false,
    )
    await assert.rejects(
      () => runChatCompletionsStructuredJson({
        model: { id: '  ', provider: 'chat_completions', baseUrl: 'http://127.0.0.1/v1' },
        apiKey: 'test-key',
        systemPrompt: 'system',
        prompt: 'prompt',
        output: { name: 'test_output', description: 'submit result', schema: { type: 'object' } },
      }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'invalid_request'
        && 'retryable' in error
        && error.retryable === false,
    )
    const textError = await expectProviderError(() => runChatCompletionsText({
      model: { id: 'custom-model', provider: 'chat_completions', baseUrl: 'http://127.0.0.1/v1' },
      apiKey: 'test-key',
      systemPrompt: 'system',
      prompt: 'prompt',
      outputLabel: '洞察 HTML',
    }))
    assert.equal(textError.code, 'empty_content')
    assert.equal(textError.retryable, false)
    assert.equal(fetchCalls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('pending response reads abort without waiting for a hanging upstream cancel', async () => {
  const originalFetch = globalThis.fetch
  const abortController = new AbortController()
  let cancelStarted = false
  const source = new ReadableStream<Uint8Array>({
    cancel() {
      cancelStarted = true
      return new Promise<void>(() => undefined)
    },
  })
  globalThis.fetch = async () => new Response(source, { status: 200 })

  try {
    const pending = requestJson({
      url: 'http://127.0.0.1/v1/chat/completions',
      apiKey: 'test-key',
      providerLabel: 'Chat Completions API',
      signal: abortController.signal,
      timeoutMs: 5_000,
    })
    const pendingError = expectProviderError(() => pending)
    await new Promise((resolve) => setTimeout(resolve, 10))
    abortController.abort()
    const error = await pendingError
    assert.equal(error.code, 'aborted')
    assert.equal(error.retryable, false)
    assert.equal(cancelStarted, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('TLS request failures are deterministic and non-retryable', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw Object.assign(new Error('certificate expired'), { code: 'CERT_HAS_EXPIRED' })
  }

  try {
    const error = await expectProviderError(() => runChatCompletionsStructuredJson({
      model: { id: 'custom-model', provider: 'chat_completions', baseUrl: 'http://127.0.0.1/v1' },
      apiKey: 'test-key',
      systemPrompt: 'system',
      prompt: 'prompt',
      output: { name: 'test_output', description: 'submit result', schema: { type: 'object' } },
    }))
    assert.equal(error.code, 'tls_error')
    assert.equal(error.retryable, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Chat Completions normalizes HTTP and HTTPS endpoints identically in every environment', () => {
  const previousNodeEnv = environment.NODE_ENV
  const cases = [
    ['https://cpa.luelue.vip/v1', 'https://cpa.luelue.vip/v1'],
    [' HTTPS://CPA.LUELUE.VIP:443/v1/chat/completions/// ', 'https://cpa.luelue.vip/v1'],
    ['http://models.example.com:80/v1/', 'http://models.example.com/v1'],
    ['https://models.example.com/custom/CHAT/COMPLETIONS/', 'https://models.example.com/custom'],
    ['https://models.example.com/', 'https://models.example.com'],
    ['http://localhost:11434/v1', 'http://localhost:11434/v1'],
    ['https://localhost/v1', 'https://localhost/v1'],
    ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434/v1'],
    ['http://10.0.0.8/v1', 'http://10.0.0.8/v1'],
    ['https://172.16.0.8/v1', 'https://172.16.0.8/v1'],
    ['http://192.168.1.10:8080/v1', 'http://192.168.1.10:8080/v1'],
    ['http://169.254.169.254/v1', 'http://169.254.169.254/v1'],
    ['https://1.1.1.1/v1', 'https://1.1.1.1/v1'],
    ['http://[::1]:11434/v1', 'http://[::1]:11434/v1'],
    ['https://[fd00::1]/v1', 'https://[fd00::1]/v1'],
    ['http://[fe80::1]:8080/v1', 'http://[fe80::1]:8080/v1'],
    ['https://[2001:4860:4860::8888]/v1', 'https://[2001:4860:4860::8888]/v1'],
    ['http://unresolved.invalid/v1', 'http://unresolved.invalid/v1'],
  ] as const

  try {
    for (const nodeEnv of ['production', 'development']) {
      environment.NODE_ENV = nodeEnv
      for (const [input, expected] of cases) {
        assert.equal(normalizeChatCompletionsBaseUrl(input), expected, nodeEnv + ': ' + input)
        assert.equal(toChatCompletionsUrl(input), expected + '/chat/completions')
      }
    }
  } finally {
    if (previousNodeEnv === undefined) delete environment.NODE_ENV
    else environment.NODE_ENV = previousNodeEnv
  }
})

test('Chat Completions rejects malformed URLs, unsupported protocols, and URL metadata', () => {
  const invalidValues = [
    undefined, null, 42, {}, '', '   ', 'not a URL', '/v1', '//models.example.com/v1',
    'https://', 'http://[invalid]/v1', 'https://models.example.com:99999/v1',
    'ftp://models.example.com/v1', 'file:///v1', 'ws://localhost/v1', 'data:text/plain,model',
    'https://user@models.example.com/v1', 'https://:secret@models.example.com/v1',
    'https://user:secret@models.example.com/v1',
    'https://models.example.com/v1?key=value', 'https://models.example.com/v1#section',
  ]

  for (const value of invalidValues) {
    assert.equal(normalizeChatCompletionsBaseUrl(value), undefined, String(value))
    if (typeof value === 'string') {
      assert.throws(() => toChatCompletionsUrl(value), /地址无效/)
    }
  }
})

test('direct text request omits JSON response format and returns model HTML unchanged', async () => {
  const originalFetch = globalThis.fetch
  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '<article><h2>洞察</h2></article>' } }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  try {
    const result = await runChatCompletionsText({
      model: {
        id: 'custom-model',
        provider: 'chat_completions',
        baseUrl: 'http://127.0.0.1/v1',
        maxOutputTokens: 4096,
      },
      apiKey: 'test-key',
      systemPrompt: 'system',
      prompt: 'prompt',
      outputLabel: '洞察 HTML',
    })
    assert.equal(result.content, '<article><h2>洞察</h2></article>')
    assert.equal('response_format' in (requestBody ?? {}), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('length-limited model output reports a readable truncation error', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'length', message: { content: '{"partial":' } }],
    usage: { prompt_tokens: 2, completion_tokens: 4096, total_tokens: 4098 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })

  try {
    await assert.rejects(
      () => runChatCompletionsStructuredJson({
        model: {
          id: 'custom-model',
          provider: 'chat_completions',
          baseUrl: 'http://127.0.0.1/v1',
          maxOutputTokens: 4096,
        },
        apiKey: 'test-key',
        systemPrompt: 'system',
        prompt: 'prompt',
        output: { name: 'report_insight', description: 'submit result', schema: { type: 'object' } },
      }),
      /输出达到最大长度，未能生成完整的?report_insight/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('maximum output setting permits the documented output length', () => {
  assert.equal(isValidMaxOutputTokens(384_000), true)
  assert.equal(isValidMaxOutputTokens(384_001), false)
})

test('structured JSON uses a regular chat completion and sends configured reasoning effort', async () => {
  const originalFetch = globalThis.fetch
  const requestBodies: Array<Record<string, unknown>> = []
  const requestUrls: string[] = []
  globalThis.fetch = async (input, init) => {
    requestUrls.push(String(input))
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '```json\n{"ok":true}\n```' } }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  try {
    const result = await runChatCompletionsStructuredJson({
      model: {
        id: 'custom-model',
        provider: 'chat_completions',
        baseUrl: 'http://127.0.0.1/v1',
        reasoningEffort: 'high',
      },
      apiKey: 'test-key',
      systemPrompt: 'system',
      prompt: 'prompt',
      output: { name: 'test_output', description: 'submit result', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    })
    assert.deepEqual(result.value, { ok: true })
    assert.deepEqual(requestUrls, ['http://127.0.0.1/v1/chat/completions'])
    assert.equal(requestBodies.length, 1)
    assert.deepEqual(requestBodies[0].response_format, { type: 'json_object' })
    assert.equal(requestBodies[0].reasoning_effort, 'high')
    assert.equal('thinking' in requestBodies[0], false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('structured JSON honors the configured maximum context', async () => {
  const originalFetch = globalThis.fetch
  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  try {
    const systemPrompt = 'system instruction'
    const maxContextCharacters = 8_000
    await runChatCompletionsStructuredJson({
      model: {
        id: 'custom-model',
        provider: 'chat_completions',
        baseUrl: 'http://127.0.0.1/v1',
        maxContextCharacters,
      },
      apiKey: 'test-key',
      systemPrompt,
      prompt: `开头${'x'.repeat(12_000)}结尾`,
      output: { name: 'test_output', description: 'submit result', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    })
    const messages = requestBody?.messages as Array<{ content?: unknown }>
    const requestPrompt = String(messages[1]?.content ?? '')
    assert.equal(requestPrompt.length <= maxContextCharacters - systemPrompt.length, true)
    assert.equal(requestPrompt.includes('[提示词内容已按最大上下文截取。]'), true)
    assert.equal(requestPrompt.includes('结尾'), true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('structured analysis applies the configured reasoning effort', async () => {
  const originalFetch = globalThis.fetch
  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  try {
    await runChatCompletionsStructuredJson({
      model: {
        id: 'custom-model',
        provider: 'chat_completions',
        baseUrl: 'http://127.0.0.1/v1',
        maxOutputTokens: 4096,
        reasoningEffort: 'max',
      },
      apiKey: 'test-key',
      systemPrompt: 'system',
      prompt: 'prompt',
      output: { name: 'test_output', description: 'submit result', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    })
    assert.equal('thinking' in (requestBody ?? {}), false)
    assert.equal(requestBody?.reasoning_effort, 'max')
    assert.equal(requestBody?.max_tokens, 4096)
    assert.deepEqual(requestBody?.response_format, { type: 'json_object' })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('仅含思考内容的响应不会被当作 JSON 结果', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '', reasoning_content: 'thinking' } }],
    usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })

  try {
    await assert.rejects(
      () => runChatCompletionsStructuredJson({
        model: { id: 'custom-model', provider: 'chat_completions', baseUrl: 'http://127.0.0.1/v1' },
        apiKey: 'test-key',
        systemPrompt: 'system',
        prompt: 'prompt',
        output: { name: 'test_output', description: 'submit result', schema: { type: 'object' } },
      }),
      /只返回了 reasoning/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('invalid DOCX upload is rejected before any report can be created', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([0, 1, 2, 3]))
      controller.close()
    },
  })
  await assert.rejects(
    () => persistReportStream({ reportId: 'test-invalid-docx', fileName: 'invalid.docx', body, contentLength: 4 }),
    (error: unknown) => error instanceof ReportUploadError && error.status === 422,
  )
})

test('page_analysis is the single analysis module with the four-stage pipeline', () => {
  assert.equal(pageAnalysisModule.id, 'page_analysis')
  assert.equal(pageAnalysisModule.schemaVersion, 1)
  assert.equal(pageAnalysisModule.maxAttempts, 3)
  assert.deepEqual(AnalysisStages, ['validating', 'page_analysis', 'quality_gate', 'completed'])
  assert.equal(AnalysisStages.length, 4)
  assert.equal((AnalysisStages as readonly string[]).includes('report_insight'), false)
})

test('page_analysis prompt includes frozen context and retry errors only', () => {
  const context = {
    jobId: 'job-prompt-test',
    reportVersionId: 'report-1',
    reportFacts: createReportFacts(),
    reportSource: {
      path: '/tmp/test.pdf',
      fileName: 'test.pdf',
      mimeType: 'application/pdf',
      size: 100,
      sha256: 'prompt-test-hash',
    },
    evaluationContext: {
      projectId: 'project-1',
      projectTitle: '测试课题',
      researchObjective: '测试研究目标',
      researchBackground: '测试研究背景',
      milestone: { id: 'stage-1', title: '阶段一', targetDate: '2026-12-31', workAndExpectedOutcomes: '完成测试成果' },
    },
    maxContextCharacters: 100_000,
    promptConfig: getDefaultAiPromptConfig('page_analysis'),
    attempt: 1,
    previousErrors: [],
  }
  const prompt = pageAnalysisModule.buildPrompt(context)
  assert.match(prompt, /课题与阶段评价基准.*测试研究目标/)
  assert.match(prompt, /报告本地事实.*paragraphCount.*characterCount/)
  assert.match(prompt, /固定中文键/)
  assert.doesNotMatch(prompt, /sourceRefs|rationale|完整度 [0-9]|权重分数/)
  const retryPrompt = pageAnalysisModule.buildPrompt({
    ...context,
    attempt: 2,
    previousErrors: [{ code: 'SCHEMA_INVALID', path: '/词云', message: '词云无效。' }],
  })
  assert.match(retryPrompt, /修正以下门禁错误.*SCHEMA_INVALID/)
})

test('analysis progress keeps queue outside the four analysis steps', () => {
  const queued = buildAnalysisProgress({
    job: createAnalysisJob({ status: 'queued' }),
    moduleStates: [createModuleState('page_analysis', 'pending', 0)],
  })

  assert.equal(queued.title, '正在准备开始分析')
  assert.equal(queued.detail, '已进入队列，稍后自动开始')
  assert.equal(queued.activeStepIndex, -1)
  assert.equal(queued.nodes.every((node) => node.state === 'pending'), true)
})

test('analysis progress exposes the active step, retry detail, and node states', () => {
  const generating = buildAnalysisProgress({
    job: createAnalysisJob({ stage: 'page_analysis', stageIndex: 1 }),
    moduleStates: [
      createModuleState('page_analysis', 'running'),
    ],
  })
  const retrying = buildAnalysisProgress({
    job: createAnalysisJob({ stage: 'page_analysis', stageIndex: 1 }),
    moduleStates: [
      { ...createModuleState('page_analysis', 'retrying', 2), gateErrors: [{ code: 'SCHEMA_INVALID', path: '/词云', message: '词云无效。' }] },
    ],
  })
  const gating = buildAnalysisProgress({
    job: createAnalysisJob({ stage: 'page_analysis', stageIndex: 1 }),
    moduleStates: [
      createModuleState('page_analysis', 'gating'),
    ],
  })
  const publishing = buildAnalysisProgress({
    job: createAnalysisJob({ stage: 'quality_gate', stageIndex: 2 }),
    moduleStates: [
      createModuleState('page_analysis', 'accepted'),
    ],
  })

  assert.equal(generating.title, '正在生成分析页')
  assert.equal(generating.activeStepIndex, 1)
  assert.equal(generating.nodes[1].shortLabel, '分析')
  assert.equal(retrying.title, '正在重新生成分析页')
  assert.equal(retrying.detail, '第 2/3 次 · 词云无效。')
  assert.equal(retrying.nodes[1].state, 'active')
  assert.equal(gating.title, '正在校验分析结果')
  assert.equal(gating.detail, '正在核对分析页是否完整')
  assert.equal(gating.activeStepIndex, 2)
  assert.equal(gating.nodes[1].state, 'completed')
  assert.equal(gating.nodes[2].state, 'active')
  assert.equal(publishing.title, '正在发布分析结果')
  assert.equal(publishing.activeStepIndex, 3)
})

test('analysis progress distinguishes failed execution from published success', () => {
  const failed = buildAnalysisProgress({
    job: createAnalysisJob({ status: 'failed', stage: 'page_analysis', stageIndex: 1, errorMessage: '模型请求失败。' }),
    moduleStates: [
      createModuleState('page_analysis', 'running'),
    ],
  })
  const published = buildAnalysisProgress({
    job: createAnalysisJob({ status: 'completed', stage: 'completed', stageIndex: 3 }),
    moduleStates: [createModuleState('page_analysis', 'accepted')],
  })

  assert.equal(failed.nodes[1].state, 'failed')
  assert.equal(failed.detail, '模型请求失败。')
  assert.equal(published.title, '分析结果已发布')
  assert.equal(published.nodes[3].state, 'completed')
})

test('page_analysis accepts the complete fixed contract and rejects extra fields', () => {
  const accepted = validatePageAnalysis(createPageAnalysis())
  assert.equal(accepted.accepted, true)
  assert.deepEqual(accepted.value, createPageAnalysis())

  const withExtra = validatePageAnalysis({
    ...createPageAnalysis(),
    '总分': 90,
  })
  assert.equal(withExtra.accepted, false)
  assert.equal(withExtra.errors.some((error) => error.code === 'SCHEMA_INVALID' && error.path === '/'), true)

  const withWordWeight = validatePageAnalysis({
    ...createPageAnalysis(),
    '词云': createPageAnalysis()['词云'].map((word, index) => ({ label: word, weight: 100 - index })),
  })
  assert.equal(withWordWeight.accepted, false)

  const missingScore = createPageAnalysis()['综合评分'] as Record<string, unknown>
  delete missingScore['证据质量']
  const acceptedMissing = validatePageAnalysis({
    ...createPageAnalysis(),
    '综合评分': missingScore,
  })
  assert.equal(acceptedMissing.accepted, false)
  assert.equal(acceptedMissing.errors.some((error) => error.code === 'MISSING_FIXED_SCORE' || error.code === 'SCHEMA_INVALID'), true)
})

test('page_analysis rejects whitespace-only, zero-width and BOM text', () => {
  const cases: Array<{ '标题': string }> = [
    { '标题': '   ' },
    { '标题': '\u200B\u200C\u200D' },
    { '标题': '\uFEFF' },
  ]
  for (const caseTitle of cases) {
    const result = validatePageAnalysis(createPageAnalysis({ '报告详情': { '章节': [{ '标题': caseTitle['标题'], '摘要': '第 1 章摘要。' }], '完整度结论': '整体完整度良好' } }))
    assert.equal(result.accepted, false, JSON.stringify(caseTitle))
    assert.equal(result.errors.some((error) => error.code === 'BLANK_TEXT'), true, JSON.stringify(caseTitle))
  }
  const blankSuggestion = validatePageAnalysis(createPageAnalysis({ 'AI建议': ['   '] }))
  assert.equal(blankSuggestion.errors.some((error) => error.code === 'BLANK_TEXT'), true)
  const blankFactor = validatePageAnalysis(createPageAnalysis({ '综合评分': { ...createPageAnalysis()['综合评分'], '主要影响因素': '\uFEFF' } }))
  assert.equal(blankFactor.errors.some((error) => error.code === 'BLANK_TEXT'), true)
})

test('page_analysis rejects duplicate report detail section titles', () => {
  const duplicate = createPageAnalysis({
    '报告详情': {
      '章节': [...createPageSections(), { ...createPageSections()[0] }],
      '完整度结论': '整体完整度良好',
    },
  })
  const result = validatePageAnalysis(duplicate)
  assert.equal(result.accepted, false)
  assert.equal(result.errors.some((error) => error.code === 'DUPLICATE_REPORT_DETAIL_SECTION'), true)
})

test('heatmap chapter titles must exactly match report detail titles', () => {
  const mismatched = validatePageAnalysis(createPageAnalysis({
    '热力图': [{
      '章节': '正文 ',
      '文献综述': 100,
      '定性分析': 55,
      '定量建模': 30,
      '案例研究': 0,
      '实地调研': 0,
      '对比分析': 45,
    }],
  }))
  assert.equal(mismatched.accepted, false)
  assert.equal(mismatched.errors.some((error) => error.code === 'HEATMAP_CHAPTER_NOT_IN_DETAILS'), true)

  const duplicated = validatePageAnalysis(createPageAnalysis({
    '热力图': [
      { '章节': '正文', '文献综述': 100, '定性分析': 55, '定量建模': 30, '案例研究': 0, '实地调研': 0, '对比分析': 45 },
      { '章节': '正文', '文献综述': 60, '定性分析': 40, '定量建模': 20, '案例研究': 0, '实地调研': 0, '对比分析': 30 },
    ],
  }))
  assert.equal(duplicated.errors.some((error) => error.code === 'DUPLICATE_HEATMAP_ROW'), true)

  const tooManyRows = createPageAnalysis({
    '热力图': Array.from({ length: 13 }, (_, index) => ({
      '章节': index === 0 ? '正文' : `章节${index + 1}`,
      '文献综述': 100,
      '定性分析': 55,
      '定量建模': 30,
      '案例研究': 0,
      '实地调研': 0,
      '对比分析': 45,
    })),
  })
  assert.equal(tooManyRows['热力图'].length, 13)
  assert.equal(validatePageAnalysis(tooManyRows).accepted, false)
})

test('word cloud accepts 50-60 unique keywords and rejects boundaries', () => {
  assert.equal(validatePageAnalysis(createPageAnalysis({ '词云': createWordCloudWords(49) })).accepted, false)
  assert.equal(validatePageAnalysis(createPageAnalysis({ '词云': createWordCloudWords(MIN_WORD_CLOUD_KEYWORDS) })).accepted, true)
  assert.equal(validatePageAnalysis(createPageAnalysis({ '词云': createWordCloudWords(MAX_WORD_CLOUD_KEYWORDS) })).accepted, true)
  assert.equal(validatePageAnalysis(createPageAnalysis({ '词云': createWordCloudWords(61) })).accepted, false)
  const duplicate = validatePageAnalysis(createPageAnalysis({
    '词云': [...createWordCloudWords(MIN_WORD_CLOUD_KEYWORDS - 1), ...createWordCloudWords(1)],
  }))
  assert.equal(duplicate.errors.some((error) => error.code === 'DUPLICATE_WORD_LABEL'), true)
  const lowInformation = validatePageAnalysis(createPageAnalysis({
    '词云': [...createWordCloudWords(MIN_WORD_CLOUD_KEYWORDS - 1), '报告'],
  }))
  assert.equal(lowInformation.errors.some((error) => error.code === 'LOW_INFORMATION_WORD'), true)
})

test('mind map enforces node count, depth and child-width limits', () => {
  assert.equal(validatePageAnalysis(createPageAnalysis({ '思维导图': buildMindMapTree(199) })).accepted, true)
  assert.equal(validatePageAnalysis(createPageAnalysis({ '思维导图': buildMindMapTree(200) })).accepted, true)
  const tooManyNodes = validatePageAnalysis(createPageAnalysis({ '思维导图': buildMindMapTree(201) }))
  assert.equal(tooManyNodes.accepted, false)
  assert.equal(tooManyNodes.errors.some((error) => error.code === 'MINDMAP_NODE_LIMIT_EXCEEDED'), true)

  const tooWide = { '名称': 'root', '子节点': Array.from({ length: 13 }, (_, index) => ({ '名称': `子${index}`, '子节点': [] })) }
  const wideResult = validatePageAnalysis(createPageAnalysis({ '思维导图': tooWide }))
  assert.equal(wideResult.accepted, false)
  assert.equal(wideResult.errors.some((error) => error.code === 'SCHEMA_INVALID' || error.code === 'TOO_MANY_MINDMAP_CHILDREN'), true)

  const tooDeep = { '名称': 'root', '子节点': [{ '名称': 'L2', '子节点': [{ '名称': 'L3', '子节点': [{ '名称': 'L4', '子节点': [{ '名称': 'L5', '子节点': [{ '名称': 'L6', '子节点': [] }] }] }] }] }] }
  const deepResult = validatePageAnalysis(createPageAnalysis({ '思维导图': tooDeep }))
  assert.equal(deepResult.errors.some((error) => error.code === 'MINDMAP_DEPTH_EXCEEDED'), true)
})

test('AI suggestions allow at most three non-empty items', () => {
  const valid = validatePageAnalysis(createPageAnalysis({
    'AI建议': ['建议一', '建议二'],
  }))
  assert.equal(valid.accepted, true)
  const tooMany = validatePageAnalysis(createPageAnalysis({
    'AI建议': Array.from({ length: MAX_AI_SUGGESTIONS + 1 }, (_, index) => `建议${index + 1}`),
  }))
  assert.equal(tooMany.accepted, false)
  const blank = validatePageAnalysis(createPageAnalysis({ 'AI建议': [''] }))
  assert.equal(blank.accepted, false)
})

test('snapshot display payload uses schema 1 and renders visualization data', () => {
  const page = createPageAnalysis()
  const snapshot: AnalysisSnapshotPayload = {
    schemaVersion: ANALYSIS_SNAPSHOT_SCHEMA_VERSION,
    reportDetails: {
      sections: page['报告详情']['章节'].map((section, index) => ({ id: `section-${index + 1}`, title: section['标题'], summary: section['摘要'] })),
      completenessConclusion: page['报告详情']['完整度结论'],
    },
    reportCompleteness: {
      overall: 78,
      dimensions: ReportCompletenessDimensions.map((dimension, index) => ({ id: dimension.id, label: dimension.id, score: 76 + index })),
      mainGap: '方法与建议仍需补充验证',
    },
    aiScore: {
      overall: 76,
      summary: page['综合评分']['主要影响因素'],
      dimensions: AiScoreDimensions.map((dimension, index) => ({ id: dimension.id, label: dimension.label, score: 76 + index })),
    },
    suggestions: page['AI建议'].map((detail, index) => ({ id: `suggestion-${index + 1}`, detail })),
    visualization: {
      mindMap: { id: 'mindmap-root', label: '项目投资分析', children: [{ id: 'mindmap-root-1', label: '收益', children: [] }] },
      wordCloud: buildVisualizationWordCloudItems(page['词云']),
      heatmap: { rows: [{ id: 'heatmap-1', label: '正文', values: [100, 55, 30, 0, 0, 45] }] },
    },
  }
  assert.deepEqual(Object.keys(snapshot).sort(), ['aiScore', 'reportCompleteness', 'reportDetails', 'schemaVersion', 'suggestions', 'visualization'])
  const data = getVisualizationData(snapshot)
  assert.equal(data.mindMap.label, '项目投资分析')
  assert.equal(data.wordCloud[0].weight, 100)
  assert.equal(data.heatmap.rows[0].cells[0].ratio, 1)
  const horizontalLeaf = getMindMapNodeGeometry('leaf', 6)
  assert.equal(horizontalLeaf.width, 36)
  assert.equal(horizontalLeaf.height, 98)
  assert.equal(getMindMapNodeGeometry('branch', 7).width, 40)
  const wrappedRoot = getMindMapNodeGeometry('root', 50)
  assert.equal(wrappedRoot.width, 400)
  assert.equal(wrappedRoot.height, 100)
  assert.deepEqual(getRootLabelLines('一二三四五六七八九十'.repeat(5)), [
    '一二三四五六七八九十一二三四五六七八九十',
    '一二三四五六七八九十一二三四五六七八九十',
    '一二三四五六七八九十',
  ])
})

test('word cloud fills from source text and derives stable display layout', () => {
  const sourceWords = ['项目投资', ...createWordCloudWords(MIN_WORD_CLOUD_KEYWORDS - 1)]
  const sourceText = sourceWords.join('。')
  const completed = completeWordCloudOutput({ words: ['项目投资', 'Property SPV', '报告'] }, sourceText) as { words: string[] }
  assert.equal(completed.words.length, MIN_WORD_CLOUD_KEYWORDS)
  assert.equal(completed.words[0], '项目投资')
  assert.equal(completed.words.includes('Property SPV'), true)
  assert.equal(completed.words.includes('报告'), false)
  assert.deepEqual(validatePageAnalysisOutput({ ...createPageAnalysis(), '词云': completed.words }), [])
  assert.equal(completed.words.every((word) => word.length >= 2 && word.length <= 12), true)

  const displayItems = buildVisualizationWordCloudItems(createWordCloudWords(MAX_WORD_CLOUD_KEYWORDS))
  assert.equal(displayItems.length, MAX_WORD_CLOUD_KEYWORDS)
  assert.equal(displayItems[0].weight, 100)
  assert.equal(displayItems.at(-1)?.weight, 28)
  assert.equal(new Set(displayItems.map((item) => item.id)).size, MAX_WORD_CLOUD_KEYWORDS)

  const layout = createWordCloudLayout(displayItems, { width: 1200, height: 600 })
  assert.equal(layout.words.length, MAX_WORD_CLOUD_KEYWORDS)
  assert.ok(layout.maxFontSize > layout.minFontSize)
  assert.ok(layout.words[0].fontSize > layout.words.at(-1)!.fontSize)
  assert.equal(layout.words[0].fontWeight, 700)
  assert.equal(layout.words.at(-1)!.fontWeight, 600)

  const narrowLayout = createWordCloudLayout(displayItems, { width: 320, height: 180 })
  const compactLayout = createWordCloudLayout(displayItems, { width: 320, height: 180 }, 0.7)
  assert.ok(narrowLayout.minFontSize >= 8)
  assert.ok(narrowLayout.maxFontSize <= 20)
  assert.equal(compactLayout.padding, 2)
})

test('mind map labels are truncated per node type beyond the character cap', () => {
  assert.equal(getNodeDisplayLabel('short', 'leaf'), 'short')
  assert.equal(getNodeDisplayLabel('a'.repeat(10), 'leaf'), 'a'.repeat(10))
  assert.equal(getNodeDisplayLabel('a'.repeat(12), 'leaf'), `${'a'.repeat(9)}…`)
  assert.equal(getNodeDisplayLabel('a'.repeat(15), 'branch'), `${'a'.repeat(11)}…`)
  assert.equal(getNodeDisplayLabel('a'.repeat(12), 'branch'), 'a'.repeat(12))
  assert.equal(getNodeDisplayLabel('a'.repeat(40), 'root'), 'a'.repeat(40))
  assert.equal(getNodeDisplayLabel('a'.repeat(50), 'root'), `${'a'.repeat(39)}…`)
  assert.equal(getNodeDisplayLabel('a'.repeat(12), 'leaf').length, 10)
  assert.equal(getNodeDisplayLabel('a'.repeat(50), 'root').length, 40)
})

test('retry delay is interrupted by cancellation without waiting for Retry-After', async () => {
  const controller = new AbortController()
  const startedAt = Date.now()
  const waiting = retryDelay(1, 120_000, controller.signal)
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(waiting, /Analysis cancelled/)
  assert.ok(Date.now() - startedAt < 1_000)
})

test('AI response readers bound body bytes', async () => {
  const oversized = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('1234'))
      controller.close()
    },
  }))
  await assert.rejects(
    () => readResponseBytes(oversized, 'test-key', { maxBytes: 3, providerLabel: '测试模型' }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'response_too_large',
  )
})

import { accountModelTokens, ModelUsageIncompleteError, type ModelUsage } from '@/lib/ai/usage'

export type ModelProviderErrorInit = {
  status?: number
  code?: string
  retryable?: boolean
  retryAfterMs?: number
}

export type CompletedModelUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export class ModelProviderError extends Error {
  readonly status?: number
  readonly code?: string
  readonly retryable: boolean
  readonly retryAfterMs?: number

  constructor(message: string, init: ModelProviderErrorInit = {}) {
    super(message)
    this.name = 'ModelProviderError'
    this.status = init.status
    this.code = init.code
    this.retryAfterMs = init.retryAfterMs
    this.retryable = init.retryable ?? isRetryableProviderStatus(init.status, init.code)
  }
}

export class ChatCompletionsError extends ModelProviderError {
  readonly usage?: CompletedModelUsage
  readonly provider?: string
  readonly model?: string

  constructor(
    message: string,
    status?: number,
    retryAfterMs?: number,
    init: Pick<ModelProviderErrorInit, 'code' | 'retryable'> & {
      usage?: CompletedModelUsage
      provider?: string
      model?: string
    } = {},
  ) {
    super(message, {
      status,
      retryAfterMs,
      code: init.code,
      retryable: init.retryable ?? isRetryableProviderStatus(status, init.code),
    })
    this.name = 'ChatCompletionsError'
    this.usage = init.usage
    this.provider = init.provider
    this.model = init.model
  }
}

export function tryCompletedUsage(usage: ModelUsage) {
  try {
    return accountModelTokens(usage)
  } catch (error) {
    if (error instanceof ModelUsageIncompleteError) return undefined
    throw error
  }
}

export function withCompletedUsage(error: unknown, usage: ModelUsage, identity: { provider: string; model: string }): never {
  const completed = tryCompletedUsage(usage)
  if (!completed) throw error
  if (error instanceof ChatCompletionsError && error.usage) throw error
  if (error instanceof ChatCompletionsError) {
    throw new ChatCompletionsError(error.message, error.status, error.retryAfterMs, {
      code: error.code,
      retryable: error.retryable,
      usage: completed,
      provider: identity.provider,
      model: identity.model,
    })
  }
  throw new ChatCompletionsError(error instanceof Error ? error.message : String(error), undefined, undefined, {
    code: 'invalid_model_output',
    retryable: false,
    usage: completed,
    provider: identity.provider,
    model: identity.model,
  })
}

export function completedCallFromError(error: unknown) {
  if (!(error instanceof ChatCompletionsError) || !error.usage || !error.provider || !error.model) return undefined
  return {
    provider: error.provider,
    model: error.model,
    tokens: error.usage.totalTokens,
  }
}

function isRetryableProviderStatus(status?: number, code?: string) {
  if (code === 'timeout' || code === 'empty_json_content' || code === 'invalid_model_output' || code === 'insufficient_system_resource' || code === 'network_error') return true
  if (
    code === 'aborted'
    || code === 'content_filter'
    || code === 'length'
    || code === 'tool_calls'
    || code === 'reasoning_only'
    || code === 'payment_required'
    || code === 'unauthorized'
    || code === 'invalid_request'
    || code === 'empty_content'
  ) return false
  if (!status) return false
  if (status === 400 || status === 401 || status === 402 || status === 403 || status === 404 || status === 422) return false
  return status === 408 || status === 409 || status === 429 || status >= 500
}

export function parseRetryAfter(value: string | null) {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(120_000, Math.ceil(seconds * 1_000))
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return undefined
  return Math.min(120_000, Math.max(0, timestamp - Date.now()))
}

export function redactSecret<T>(value: T, secret: string): T {
  if (!secret) return value
  const patterns = [secret]
  // 渠道可能回显密钥的截断形态：补齐常见的前缀/后缀片段，避免只做全量匹配漏掉。
  if (secret.length >= 20) {
    patterns.push(secret.slice(0, 12), secret.slice(-12))
  }
  const redactString = (input: string) => {
    let output = input
    for (const pattern of patterns) output = output.split(pattern).join('[REDACTED]')
    return output
  }
  const redactValue = (input: unknown): unknown => {
    if (typeof input === 'string') return redactString(input)
    if (Array.isArray(input)) return input.map(redactValue)
    if (!input || typeof input !== 'object') return input
    return Object.fromEntries(
      Object.entries(input).map(([key, entry]) => [redactString(key), redactValue(entry)]),
    )
  }
  return redactValue(value) as T
}

export function providerErrorMessage(payload: Record<string, unknown>) {
  const error = payload.error
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message.slice(0, 1200)
  }
  if (typeof error === 'string' && error.trim()) return error.slice(0, 1200)
  if (typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message.slice(0, 1200)
  }
  const detail = serializeProviderErrorDetail(error ?? payload.raw ?? payload)
  return detail.trim() ? detail.slice(0, 1200) : '未知错误'
}

function serializeProviderErrorDetail(value: unknown) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

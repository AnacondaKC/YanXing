import { ChatCompletionsError } from '@/lib/ai/runtime/errors'
import type { StructuredJsonDefinition } from '@/lib/ai/runtime/output-protocol'
import type { AiChannel, ReasoningEffort } from '@/lib/ai/model/freeze'

export const DEFAULT_CHAT_COMPLETIONS_BASE_URL = 'https://api.openai.com/v1'

export interface ChatCompletionsModel {
  id: string
  provider: AiChannel
  baseUrl: string
  maxContextCharacters?: number
  maxOutputTokens?: number
  reasoningEffort?: ReasoningEffort
}

export interface ChatCompletionsUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** Provider reported complete input, output, and total token usage. */
  usageComplete?: boolean
  cacheHitTokens?: number
  cacheMissTokens?: number
  reasoningTokens?: number
}

export interface ChatCompletionsStructuredJsonResult {
  value: unknown
  usage: ChatCompletionsUsage
}

export interface ChatCompletionsTextResult {
  content: string
  usage: ChatCompletionsUsage
}

export interface ChatCompletionsTextInput {
  model: ChatCompletionsModel
  apiKey: string
  systemPrompt: string
  prompt: string
  outputLabel: string
  timeoutMs?: number
  signal?: AbortSignal
  /** 在 HTTP 请求即将发出前通知调用方，便于持久化调用开始状态。 */
  onCallStarted?: () => void | PromiseLike<void>
}

export interface ChatCompletionsStructuredJsonInput {
  model: ChatCompletionsModel
  apiKey: string
  systemPrompt: string
  prompt: string
  output: StructuredJsonDefinition
  timeoutMs?: number
  signal?: AbortSignal
  /** 在 HTTP 请求即将发出前通知调用方，便于持久化调用开始状态。 */
  onCallStarted?: () => void | PromiseLike<void>
}

export function normalizeChatCompletionsBaseUrl(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol)) return undefined
    if (url.username || url.password || url.search || url.hash) return undefined
    const pathname = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '')
    url.pathname = pathname || '/'
    return url.toString().replace(/\/+$/, '')
  } catch {
    return undefined
  }
}

export function toChatCompletionsUrl(baseUrl: string) {
  const normalized = normalizeChatCompletionsBaseUrl(baseUrl)
  if (!normalized) {
    throw new ChatCompletionsError('Chat Completions API 地址无效。', undefined, undefined, { code: 'invalid_request', retryable: false })
  }
  return normalized + '/chat/completions'
}

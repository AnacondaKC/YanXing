import {
  toChatCompletionsUrl,
  type ChatCompletionsStructuredJsonInput,
  type ChatCompletionsStructuredJsonResult,
  type ChatCompletionsTextInput,
  type ChatCompletionsTextResult,
  type ChatCompletionsUsage,
} from '@/lib/ai/runtime/chat-completions'
import { ChatCompletionsError, ModelProviderError, withCompletedUsage } from '@/lib/ai/runtime/errors'
import { httpErrorMessage, requestJson } from '@/lib/ai/runtime/http'
import {
  buildStructuredPrompt,
  fitPromptToBudget,
  getMaxContextCharacters,
  getMaxOutputTokens,
  parseJsonContent,
  serializeJsonSchema,
} from '@/lib/ai/runtime/output-protocol'
import type { ReasoningEffort } from '@/lib/ai/model/freeze'

export type ExecuteCall =
  | { type: 'json'; system: string; user: string }
  | { type: 'text'; system: string; user: string }

export type ChatRequestPlan = {
  modelId: string
  maxOutputTokens?: number
  reasoningEffort?: ReasoningEffort
}

/**
 * 结构化分析调用强制使用 JSON 响应格式；文本调用（洞察 HTML）
 * 不带 response_format，避免把非 JSON 输出逼成 json_object。
 */
export function buildChatRequest(plan: ChatRequestPlan, call: ExecuteCall): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: plan.modelId,
    messages: [
      { role: 'system', content: call.system },
      { role: 'user', content: call.user },
    ],
    stream: false,
    max_tokens: getMaxOutputTokens(plan.maxOutputTokens),
    temperature: 0,
  }
  if (call.type === 'json') {
    body.response_format = { type: 'json_object' }
  }
  if (plan.reasoningEffort && plan.reasoningEffort !== 'auto') {
    body.reasoning_effort = plan.reasoningEffort
  }
  return body
}

export async function runStructuredJson(input: ChatCompletionsStructuredJsonInput): Promise<ChatCompletionsStructuredJsonResult> {
  const schema = serializeJsonSchema(input.output.schema)
  const maxUserPromptCharacters = getMaxContextCharacters(input.model.maxContextCharacters) - input.systemPrompt.length
  const prompt = buildStructuredPrompt(input.prompt, input.output, schema, maxUserPromptCharacters)
  const result = await requestChatCompletion({
    ...input,
    prompt,
    outputLabel: input.output.name + ' JSON',
  }, 'json')
  try {
    return { value: parseJsonContent(result.content, input.output.name), usage: result.usage }
  } catch (error) {
    withCompletedUsage(error, result.usage, { provider: input.model.provider, model: input.model.id })
  }
}

export async function runText(input: ChatCompletionsTextInput): Promise<ChatCompletionsTextResult> {
  const maxUserPromptCharacters = getMaxContextCharacters(input.model.maxContextCharacters) - input.systemPrompt.length
  if (maxUserPromptCharacters <= 0) throw new ChatCompletionsError('最大上下文不足以容纳模型提示词。')
  return requestChatCompletion({
    ...input,
    prompt: fitPromptToBudget(input.prompt, maxUserPromptCharacters),
  }, 'text')
}

async function requestChatCompletion(input: ChatCompletionsTextInput, callType: ExecuteCall['type']): Promise<ChatCompletionsTextResult> {
  if (!input.apiKey.trim()) throw new ChatCompletionsError('Chat Completions API 密钥不能为空。', undefined, undefined, { code: 'unauthorized', retryable: false })
  if (!input.model.id.trim()) throw new ChatCompletionsError('模型名称不能为空。', undefined, undefined, { code: 'invalid_request', retryable: false })
  if (input.signal?.aborted) throw new ChatCompletionsError('Chat Completions API 请求已取消。', undefined, undefined, { code: 'aborted', retryable: false })

  try {
    const result = await requestJson({
      url: toChatCompletionsUrl(input.model.baseUrl),
      apiKey: input.apiKey,
      providerLabel: 'Chat Completions API',
      json: buildChatRequest({
        modelId: input.model.id,
        maxOutputTokens: input.model.maxOutputTokens,
        reasoningEffort: input.model.reasoningEffort,
      }, {
        type: callType,
        system: input.systemPrompt,
        user: input.prompt,
      }),
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      onRequestStarted: input.onCallStarted,
    })
    if (!result.ok) {
      throw new ChatCompletionsError(
        'Chat Completions API 请求失败（' + result.status + '）：' + httpErrorMessage(result.value, input.apiKey),
        result.status,
        result.retryAfterMs,
        { code: providerErrorCode(result.value, result.status) },
      )
    }
    const usage = getUsage(result.value)
    try {
      return { content: getMessageContent(result.value, input.outputLabel, callType), usage }
    } catch (error) {
      withCompletedUsage(error, usage, { provider: input.model.provider, model: input.model.id })
    }
  } catch (error) {
    if (error instanceof ChatCompletionsError) throw error
    if (error instanceof ModelProviderError) {
      throw new ChatCompletionsError(error.message, error.status, error.retryAfterMs, { code: error.code, retryable: error.retryable })
    }
    throw new ChatCompletionsError('Chat Completions API 请求失败：' + (error instanceof Error ? error.message : String(error)))
  }
}

function getMessageContent(payload: Record<string, unknown>, outputLabel: string, callType: ExecuteCall['type']) {
  const choices = Array.isArray(payload.choices) ? payload.choices : []
  const firstChoice = choices[0]
  if (!firstChoice || typeof firstChoice !== 'object') throw invalidModelOutput('模型未返回' + outputLabel + '。')
  const choice = firstChoice as { finish_reason?: unknown; message?: unknown }
  if (Object.prototype.hasOwnProperty.call(choice, 'finish_reason')) {
    if (choice.finish_reason === null) throw finishReasonError('incomplete', outputLabel)
    if (typeof choice.finish_reason === 'string' && choice.finish_reason !== 'stop') {
      throw finishReasonError(choice.finish_reason, outputLabel)
    }
  }
  if (!choice.message || typeof choice.message !== 'object') throw invalidModelOutput('模型未返回' + outputLabel + '。')
  const message = choice.message as { content?: unknown; refusal?: unknown; reasoning_content?: unknown; reasoning?: unknown }
  if (typeof message.refusal === 'string' && message.refusal.trim()) {
    throw new ChatCompletionsError('模型拒绝生成' + outputLabel + '：' + message.refusal.trim().slice(0, 600), undefined, undefined, { code: 'provider_refusal', retryable: false })
  }
  const content = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content
        .filter((part): part is { type?: unknown; text?: unknown } => Boolean(part && typeof part === 'object'))
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string)
        .join('')
      : ''
  if (content.trim()) return content
  if ((typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) || (typeof message.reasoning === 'string' && message.reasoning.trim())) {
    throw new ChatCompletionsError('模型只返回了 reasoning，未返回' + outputLabel + '；请提高最大输出预算或降低推理强度。', undefined, undefined, { code: 'reasoning_only', retryable: false })
  }
  const isStructuredOutput = callType === 'json'
  const code = isStructuredOutput ? 'empty_json_content' : 'empty_content'
  throw new ChatCompletionsError('模型未返回' + outputLabel + '。', undefined, undefined, {
    code,
    retryable: isStructuredOutput,
  })
}

function finishReasonError(reason: string, outputLabel: string) {
  const code = reason === 'length' || reason === 'content_filter' || reason === 'tool_calls' || reason === 'insufficient_system_resource'
    ? reason
    : 'invalid_model_output'
  const message = reason === 'length'
    ? 'Chat Completions API 输出达到最大长度，未能生成完整的' + outputLabel + '。'
    : 'Chat Completions API 提前结束生成（' + reason + '），未获得完整的' + outputLabel + '。'
  return new ChatCompletionsError(message, undefined, undefined, {
    code,
    retryable: code === 'insufficient_system_resource',
  })
}

function invalidModelOutput(message: string) {
  return new ChatCompletionsError(message, undefined, undefined, { code: 'invalid_model_output', retryable: false })
}

function providerErrorCode(payload: Record<string, unknown>, status: number) {
  const providerError = payload.error
  const nestedCode = providerError && typeof providerError === 'object'
    ? (providerError as { code?: unknown }).code
    : undefined
  const providerCode = [nestedCode, payload.code].find((code): code is string => typeof code === 'string' && code.trim().length > 0)
  if (providerCode) return providerCode
  if (status === 401) return 'unauthorized'
  if (status === 402) return 'payment_required'
  if (status === 400 || status === 422) return 'invalid_request'
  return undefined
}

function getUsage(payload: Record<string, unknown>): ChatCompletionsUsage {
  const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage as Record<string, unknown> : {}
  const inputTokens = tokenValue(usage.prompt_tokens) ?? tokenValue(usage.input_tokens)
  const outputTokens = tokenValue(usage.completion_tokens) ?? tokenValue(usage.output_tokens)
  const reportedTotalTokens = tokenValue(usage.total_tokens)
  const details = usage.completion_tokens_details && typeof usage.completion_tokens_details === 'object'
    ? usage.completion_tokens_details as Record<string, unknown>
    : {}
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens: reportedTotalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
    usageComplete: inputTokens !== undefined && outputTokens !== undefined
      && (usage.total_tokens === undefined || reportedTotalTokens !== undefined),
    cacheHitTokens: tokenValue(usage.prompt_cache_hit_tokens) ?? 0,
    cacheMissTokens: tokenValue(usage.prompt_cache_miss_tokens) ?? 0,
    reasoningTokens: tokenValue(details.reasoning_tokens) ?? 0,
  }
}

function tokenValue(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

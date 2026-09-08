import { ChatCompletionsError } from '@/lib/ai/runtime/errors'
import {
  DEFAULT_MAX_CONTEXT_CHARACTERS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  isValidMaxContextCharacters,
  isValidMaxOutputTokens,
} from '@/lib/ai/runtime-options'

export interface StructuredJsonDefinition {
  name: string
  description: string
  schema: unknown
}

export function getMaxContextCharacters(maxContextCharacters?: number) {
  return isValidMaxContextCharacters(maxContextCharacters) ? maxContextCharacters : DEFAULT_MAX_CONTEXT_CHARACTERS
}

export function getMaxOutputTokens(maxOutputTokens?: number) {
  return isValidMaxOutputTokens(maxOutputTokens) ? maxOutputTokens : DEFAULT_MAX_OUTPUT_TOKENS
}

export function serializeJsonSchema(value: unknown): Record<string, unknown> {
  try {
    const serialized = JSON.parse(JSON.stringify(value)) as unknown
    if (!serialized || typeof serialized !== 'object' || Array.isArray(serialized)) {
      throw new Error('根值不是 JSON 对象')
    }
    return serialized as Record<string, unknown>
  } catch {
    throw new ChatCompletionsError('输出 Schema 必须是 JSON 对象。')
  }
}

export function buildStructuredOutputProtocol(output: StructuredJsonDefinition, schema: Record<string, unknown>) {
  return '\n\n输出协议：只输出一个 JSON 对象，不要输出 reasoning、Markdown、代码围栏或其他解释文字。该 JSON 用于提交 ' + output.name + '，必须符合以下 Schema：' + JSON.stringify(schema) + '\n输出说明：' + output.description
}

export function buildStructuredPrompt(prompt: string, output: StructuredJsonDefinition, schema: Record<string, unknown>, maxPromptCharacters: number) {
  const protocol = buildStructuredOutputProtocol(output, schema)
  if (maxPromptCharacters <= protocol.length) {
    throw new ChatCompletionsError('最大上下文不足以容纳结构化输出协议。')
  }
  return fitPromptToBudget(prompt, maxPromptCharacters - protocol.length) + protocol
}

export function fitPromptToBudget(prompt: string, characterBudget: number) {
  if (prompt.length <= characterBudget) return prompt
  const truncationNotice = '\n\n[提示词内容已按最大上下文截取。]\n\n'
  if (characterBudget <= truncationNotice.length + 2) return prompt.slice(0, characterBudget)
  const availableCharacters = characterBudget - truncationNotice.length
  const headLength = Math.ceil(availableCharacters * 0.6)
  const tailLength = availableCharacters - headLength
  return prompt.slice(0, headLength) + truncationNotice + prompt.slice(-tailLength)
}

export function parseJsonContent(content: string, outputName: string) {
  const trimmed = content.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim() ?? trimmed
  try {
    const parsed = JSON.parse(fenced) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('根值不是 JSON 对象')
    return parsed
  } catch (error) {
    throw new ChatCompletionsError(
      '模型返回的 ' + outputName + ' 不是合法 JSON：' + (error instanceof Error ? error.message : String(error)),
      undefined,
      undefined,
      { code: 'invalid_model_output', retryable: true },
    )
  }
}

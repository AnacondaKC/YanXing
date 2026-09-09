export const DEFAULT_MAX_CONTEXT_CHARACTERS = 1_000_000
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384
/** Chat Completions 自定义渠道的可编辑默认上限；不参与分析/洞察运行时策略。 */
export const DEFAULT_CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS = 65_536
export const DEFAULT_REASONING_EFFORT = 'auto'

export const MIN_MAX_CONTEXT_CHARACTERS = 8_000
export const MAX_MAX_CONTEXT_CHARACTERS = 1_000_000
export const MIN_MAX_OUTPUT_TOKENS = 256
export const MAX_MAX_OUTPUT_TOKENS = 384_000

export const AI_REASONING_EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type AiReasoningEffort = (typeof AI_REASONING_EFFORTS)[number]

export function isAiReasoningEffort(value: unknown): value is AiReasoningEffort {
  return typeof value === 'string' && AI_REASONING_EFFORTS.includes(value as AiReasoningEffort)
}

export function isValidMaxContextCharacters(value: unknown): value is number {
  return isIntegerInRange(value, MIN_MAX_CONTEXT_CHARACTERS, MAX_MAX_CONTEXT_CHARACTERS)
}

export function isValidMaxOutputTokens(value: unknown): value is number {
  return isIntegerInRange(value, MIN_MAX_OUTPUT_TOKENS, MAX_MAX_OUTPUT_TOKENS)
}

export function readRuntimeLimit(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
}

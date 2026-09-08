export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** False means the provider response did not contain complete token usage. */
  usageComplete?: boolean
  cacheHitTokens?: number
  cacheMissTokens?: number
  reasoningTokens?: number
}

export type AiCallDetails = {
  tokens?: number
  provider?: string
  model?: string
  stage?: string
  module?: string
  attempt?: number
}

export class ModelUsageIncompleteError extends Error {
  constructor() {
    super('模型未返回完整的 token usage，无法记录 token 用量。')
    this.name = 'ModelUsageIncompleteError'
  }
}

export function accountModelTokens(usage: ModelUsage) {
  if (usage.usageComplete === false) throw new ModelUsageIncompleteError()
  const inputTokens = requiredTokens(usage.inputTokens)
  const outputTokens = requiredTokens(usage.outputTokens)
  const reportedTotalTokens = requiredTokens(usage.totalTokens)
  const summedTokens = inputTokens + outputTokens
  if (!Number.isSafeInteger(summedTokens)) throw new ModelUsageIncompleteError()
  return {
    inputTokens,
    outputTokens,
    totalTokens: Math.max(reportedTotalTokens, summedTokens),
  }
}

function requiredTokens(value: number | undefined) {
  if (Number.isSafeInteger(value) && Number(value) >= 0) return Number(value)
  throw new ModelUsageIncompleteError()
}

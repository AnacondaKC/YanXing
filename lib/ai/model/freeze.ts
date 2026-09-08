import type { AiReasoningEffort } from '@/lib/ai/runtime-options'

export type ReasoningEffort = AiReasoningEffort

export type AiChannel = 'chat_completions'

export type ModelProfile = {
  id: string
  channelId: string
  modelName: string
  maxContextCharacters: number
  maxOutputTokens: number
  reasoningEffort: ReasoningEffort
  createdAt: string
  updatedAt: string
}

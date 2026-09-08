import { DEFAULT_CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS, DEFAULT_MAX_CONTEXT_CHARACTERS, DEFAULT_REASONING_EFFORT } from '@/lib/ai/runtime-options'
import type { AiReasoningEffort } from '@/lib/ai/runtime-options'
import type { AnalysisModuleId } from '@/modules/contracts/analysis'

export type AiModelSelectionTarget = AnalysisModuleId | 'report_insight'

export type AiModelProfile = {
  id: string
  channelId: string
  modelName: string
  maxContextCharacters: number
  maxOutputTokens: number
  reasoningEffort: AiReasoningEffort
  createdAt: string
  updatedAt: string
}

export type AiModelChannel = {
  id: string
  name: string
  baseUrl: string
  hasApiKey: boolean
  apiKeyLastFour: string
  apiKeyUnavailable?: boolean
  models: AiModelProfile[]
  createdAt: string
  updatedAt: string
  updatedBy: string
}

export type AiModelAssignment = {
  target: AiModelSelectionTarget
  modelId?: string
  updatedAt: string
  updatedBy: string
}

export type AiModelSettings = {
  revision: number
  channels: AiModelChannel[]
  assignments: AiModelAssignment[]
}

export const modelSelectionTargets: AiModelSelectionTarget[] = [
  'page_analysis',
  'report_insight',
]

export const modelSelectionTargetDetails: Record<AiModelSelectionTarget, { label: string; detail: string }> = {
  page_analysis: { label: '生成分析页', detail: '一次生成综合评分、报告详情、完整度和三类可视化数据。' },
  report_insight: { label: '生成报告洞察', detail: '把当前报告编排为五分钟单页洞察。' },
}

export type AiModelProfileDraft = Omit<AiModelProfile, 'id' | 'channelId' | 'createdAt' | 'updatedAt'> & { id?: string }

export type AiModelChannelDraft = {
  key: string
  id?: string
  name: string
  baseUrl: string
  apiKey: string
  clearApiKey: boolean
  hasApiKey: boolean
  apiKeyLastFour: string
  apiKeyUnavailable: boolean
  dirty: boolean
  originalBaseUrl?: string
  models: AiModelProfileDraft[]
}

export function createModelDraft(): AiModelProfileDraft {
  return {
    modelName: '',
    maxContextCharacters: DEFAULT_MAX_CONTEXT_CHARACTERS,
    maxOutputTokens: DEFAULT_CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
  }
}

export function createChannelDraft(key: string): AiModelChannelDraft {
  return {
    key,
    name: '',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    clearApiKey: false,
    hasApiKey: false,
    apiKeyLastFour: '',
    apiKeyUnavailable: false,
    dirty: false,
    models: [createModelDraft()],
  }
}

export function channelToDraft(channel: AiModelChannel, key = 'channel-' + channel.id): AiModelChannelDraft {
  return {
    key,
    id: channel.id,
    name: channel.name,
    baseUrl: channel.baseUrl,
    apiKey: '',
    clearApiKey: false,
    hasApiKey: channel.hasApiKey,
    apiKeyLastFour: channel.apiKeyLastFour,
    apiKeyUnavailable: channel.apiKeyUnavailable === true,
    dirty: false,
    originalBaseUrl: channel.baseUrl,
    models: channel.models.map((model) => ({
      id: model.id,
      modelName: model.modelName,
      maxContextCharacters: model.maxContextCharacters,
      maxOutputTokens: model.maxOutputTokens,
      reasoningEffort: model.reasoningEffort,
    })),
  }
}

export function assignmentsToDraft(assignments: AiModelAssignment[]) {
  const draft = {} as Record<AiModelSelectionTarget, string>
  for (const target of modelSelectionTargets) draft[target] = assignments.find((assignment) => assignment.target === target)?.modelId ?? ''
  return draft
}

export function normalizeBaseUrlForComparison(value: string) {
  return value.trim().replace(/\/+$/, '')
}

export function nextExpandedIndexAfterDelete(current: number | null, deletedIndex: number) {
  if (current === null) return null
  if (current === deletedIndex) return null
  if (current > deletedIndex) return current - 1
  return current
}

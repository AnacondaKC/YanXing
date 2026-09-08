import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  DEFAULT_CHAT_COMPLETIONS_BASE_URL,
  normalizeChatCompletionsBaseUrl,
} from '@/lib/ai/runtime/chat-completions'
import {
  DEFAULT_CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_CONTEXT_CHARACTERS,
  DEFAULT_REASONING_EFFORT,
  isAiReasoningEffort,
  MAX_MAX_CONTEXT_CHARACTERS,
  MAX_MAX_OUTPUT_TOKENS,
  MIN_MAX_CONTEXT_CHARACTERS,
  MIN_MAX_OUTPUT_TOKENS,
  readRuntimeLimit,
} from '@/lib/ai/runtime-options'
import {
  AI_PROMPT_TARGETS,
  DEFAULT_UNIFIED_SYSTEM_PROMPT,
  GLOBAL_SYSTEM_PROMPT_TARGET,
  getDefaultAiPromptConfig,
} from '@/lib/ai/prompt-defaults'
import { encryptSecret } from '@/lib/db/settings-crypto'
import { runtimeConfig } from '@/lib/config/environment'

export const INITIAL_AI_SETTINGS_VERSION = 'initial-ai-settings-v2'

const INITIAL_MODEL_ASSIGNMENT_TARGETS = ['page_analysis', 'report_insight'] as const

/**
 * 为最终 schema 写入首次运行的 AI 配置。
 * 环境变量只在空白配置表读取；管理员保存后，后续启动不会覆盖它。
 * 调用方必须已经开启事务。
 */
export function seedInitialAiSettings(database: DatabaseSync) {
  const state = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM ai_model_channels) AS channel_count,
      (SELECT COUNT(*) FROM ai_model_profiles) AS model_count,
      (SELECT COUNT(*) FROM ai_model_assignments) AS assignment_count
  `).get() as { channel_count: number; model_count: number; assignment_count: number }

  if (state.channel_count === 0 && state.model_count === 0 && state.assignment_count === 0) {
    seedDefaultModelSettings(database)
  } else if (state.assignment_count !== INITIAL_MODEL_ASSIGNMENT_TARGETS.length) {
    throw new Error('AI 模型选择配置不完整；请重建数据库或通过管理员设置修复。')
  }

  seedDefaultAiPromptSettings(database)
  seedInitialSettingsRevisions(database)
}

function seedDefaultModelSettings(database: DatabaseSync) {
  const defaults = getDefaults()
  const updatedAt = now()
  const updatedBy = '系统初始化'
  const encryptedApiKey = defaults.apiKey ? encryptSecret(defaults.apiKey) : null
  const channelId = createChannelId()

  database.prepare(`
    INSERT INTO ai_model_channels (
      id, name, channel, base_url, api_key_encrypted, created_at, updated_at, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    channelId,
    'Chat Completions API',
    'chat_completions',
    defaults.baseUrl,
    encryptedApiKey,
    updatedAt,
    updatedAt,
    updatedBy,
  )

  const modelName = normalizeGenericModelId(defaults.primaryModel)
  if (!modelName) {
    seedModelAssignments(database, updatedAt, updatedBy)
    return
  }

  const modelId = createModelId()
  database.prepare(`
    INSERT INTO ai_model_profiles (
      id, channel_id, model_name, max_context_characters, max_output_tokens, reasoning_effort, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    modelId,
    channelId,
    modelName,
    defaults.maxContextCharacters,
    defaults.maxOutputTokens,
    defaults.reasoningEffort,
    updatedAt,
    updatedAt,
  )
  seedModelAssignments(database, updatedAt, updatedBy, modelId)
}

function seedDefaultAiPromptSettings(database: DatabaseSync) {
  const timestamp = now()
  const statement = database.prepare(`
    INSERT OR IGNORE INTO ai_prompt_settings(target, system_prompt, instruction_prompt, version, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  statement.run(GLOBAL_SYSTEM_PROMPT_TARGET, DEFAULT_UNIFIED_SYSTEM_PROMPT, '', 1, timestamp, '系统默认')
  for (const target of AI_PROMPT_TARGETS) {
    const prompt = getDefaultAiPromptConfig(target)
    statement.run(target, prompt.systemPrompt, prompt.instructionPrompt, prompt.version, timestamp, prompt.updatedBy)
  }
}

function seedModelAssignments(database: DatabaseSync, updatedAt: string, updatedBy: string, modelId?: string) {
  const statement = database.prepare(`
    INSERT INTO ai_model_assignments(target, model_id, updated_at, updated_by)
    VALUES (?, ?, ?, ?)
  `)
  for (const target of INITIAL_MODEL_ASSIGNMENT_TARGETS) {
    statement.run(target, modelId ?? null, updatedAt, updatedBy)
  }
}

function seedInitialSettingsRevisions(database: DatabaseSync) {
  const timestamp = now()
  database.prepare(`
    INSERT OR IGNORE INTO settings_revisions(scope, revision, updated_at, updated_by)
    VALUES ('models', 1, ?, '系统初始化'), ('prompts', 1, ?, '系统初始化')
  `).run(timestamp, timestamp)
}

function getDefaults() {
  const chatCompletions = runtimeConfig.chatCompletions
  const model = runtimeConfig.model
  const reasoningEffort = model.reasoningEffort
  return {
    primaryModel: normalizeGenericModelId(chatCompletions.model) || 'gpt-4.1-mini',
    baseUrl: normalizeChatCompletionsBaseUrl(chatCompletions.baseUrl) ?? DEFAULT_CHAT_COMPLETIONS_BASE_URL,
    apiKey: chatCompletions.apiKey,
    maxContextCharacters: readRuntimeLimit(
      model.maxContextCharacters,
      DEFAULT_MAX_CONTEXT_CHARACTERS,
      MIN_MAX_CONTEXT_CHARACTERS,
      MAX_MAX_CONTEXT_CHARACTERS,
    ),
    maxOutputTokens: readRuntimeLimit(
      model.maxOutputTokens,
      DEFAULT_CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS,
      MIN_MAX_OUTPUT_TOKENS,
      MAX_MAX_OUTPUT_TOKENS,
    ),
    reasoningEffort: isAiReasoningEffort(reasoningEffort) ? reasoningEffort : DEFAULT_REASONING_EFFORT,
  }
}

function normalizeGenericModelId(value: unknown) {
  if (typeof value !== 'string') return ''
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= 160 ? normalized : ''
}

function createChannelId() {
  return `channel-${randomUUID()}`
}

function createModelId() {
  return `model-${randomUUID()}`
}

function now() {
  return new Date().toISOString()
}

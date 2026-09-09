import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { normalizeChatCompletionsBaseUrl } from '@/lib/ai/runtime/chat-completions'
import { createAnalysisPromptPlan } from '@/lib/ai/prompt-budget'
import { buildPageAnalysisTaskPrompt } from '@/modules/analysis/prompt'
import type { AiChannel, ModelProfile, ReasoningEffort } from '@/lib/ai/model/freeze'
import {
  DEFAULT_MAX_CONTEXT_CHARACTERS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_REASONING_EFFORT,
  isAiReasoningEffort,
  isValidMaxContextCharacters,
  isValidMaxOutputTokens,
  MAX_MAX_CONTEXT_CHARACTERS,
  MAX_MAX_OUTPUT_TOKENS,
  MIN_MAX_CONTEXT_CHARACTERS,
  MIN_MAX_OUTPUT_TOKENS,
  readRuntimeLimit,
} from '@/lib/ai/runtime-options'
import { getDatabase } from '@/lib/db/client'
import { decryptSecret, encryptSecret } from '@/lib/db/settings-crypto'
import { AnalysisModuleIds, type AnalysisGlobalSystemPrompt, type AnalysisPromptConfig } from '@/modules/contracts/analysis'
import {
  AI_PROMPT_TARGETS,
  GLOBAL_SYSTEM_PROMPT_TARGET,
  MAX_AI_PROMPT_TEXT_LENGTH,
  DEFAULT_UNIFIED_SYSTEM_PROMPT,
  getDefaultAiPromptConfig,
  getDefaultGlobalSystemPrompt,
  isAiPromptTarget,
  type AiPromptTarget,
} from '@/lib/ai/prompt-defaults'

const AI_CHANNELS = ['chat_completions'] as const
export type { AiChannel }

export const AI_MODEL_SELECTION_TARGETS = [
  ...AnalysisModuleIds,
  'report_insight',
] as const
export type AiModelSelectionTarget = (typeof AI_MODEL_SELECTION_TARGETS)[number]

export const AI_MODEL_SELECTION_TARGET_LABELS: Record<AiModelSelectionTarget, string> = {
  page_analysis: '生成分析页',
  report_insight: '生成报告洞察',
}

function isAiChannel(value: unknown): value is AiChannel {
  return typeof value === 'string' && AI_CHANNELS.includes(value as AiChannel)
}

export function isAiModelSelectionTarget(value: unknown): value is AiModelSelectionTarget {
  return typeof value === 'string' && AI_MODEL_SELECTION_TARGETS.includes(value as AiModelSelectionTarget)
}

export type PublicAiModelProfile = ModelProfile

export interface PublicAiModelChannel {
  id: string
  name: string
  baseUrl: string
  hasApiKey: boolean
  apiKeyLastFour: string
  /** 密文存在但无法解密（服务器加密密钥丢失或更换）；设置页必须提示重新输入。 */
  apiKeyUnavailable?: boolean
  models: PublicAiModelProfile[]
  createdAt: string
  updatedAt: string
  updatedBy: string
}

export interface AiModelAssignment {
  target: AiModelSelectionTarget
  modelId?: string
  updatedAt: string
  updatedBy: string
}

export interface PublicAiModelSettings {
  revision: number
  channels: PublicAiModelChannel[]
  assignments: AiModelAssignment[]
}

export class SettingsRevisionConflictError extends Error {
  constructor(readonly scope: 'models' | 'prompts', readonly expectedRevision: number, readonly actualRevision: number) {
    super('设置已被其他管理员更新，请刷新后重试。')
    this.name = 'SettingsRevisionConflictError'
  }
}

export interface AiModelProfileInput {
  id?: string
  modelName: string
  maxContextCharacters: number
  maxOutputTokens: number
  reasoningEffort: ReasoningEffort
}

export interface AiModelChannelInput {
  name: string
  baseUrl: string
  apiKey?: string
  clearApiKey?: boolean
  models: AiModelProfileInput[]
  updatedBy: string
}

export interface AiModelAssignmentInput {
  target: AiModelSelectionTarget
  modelId?: string
}

export type PublicAiPromptSetting = AnalysisPromptConfig

export interface AiPromptSettingInput {
  systemPrompt: unknown
  prompts: unknown
}

export interface PublicAiPromptSettings {
  revision: number
  systemPrompt: AnalysisGlobalSystemPrompt
  prompts: PublicAiPromptSetting[]
}

export interface AiModelRuntimeConfiguration {
  target: AiModelSelectionTarget
  channelId: string
  channelName: string
  channel: AiChannel
  baseUrl: string
  apiKey?: string
  modelId: string
  modelName: string
  maxContextCharacters: number
  maxOutputTokens: number
  reasoningEffort: ReasoningEffort
}

/** 入队时写入 analysis_jobs 的不可变模型配置；API 密钥仍以现有密文形式保存。 */
export interface AiModelRuntimeSnapshot extends Omit<AiModelRuntimeConfiguration, 'apiKey'> {
  apiKeyEncrypted: string | null
  settingsRevision: number
}

type ChannelRow = {
  id: string
  name: string
  channel: unknown
  base_url: string
  api_key_encrypted: string | null
  created_at: string
  updated_at: string
  updated_by: string
}

type ModelRow = {
  id: string
  channel_id: string
  model_name: string
  max_context_characters: unknown
  max_output_tokens: unknown
  reasoning_effort: unknown
  created_at: string
  updated_at: string
}

type AssignmentRow = {
  target: unknown
  model_id: string | null
  updated_at: string
  updated_by: string
}

type PromptRow = {
  target: unknown
  system_prompt: string
  instruction_prompt: string
  version: unknown
  updated_at: string
  updated_by: string
}

type RuntimeRow = {
  target: unknown
  channel_id: string | null
  channel_name: string | null
  channel: unknown
  base_url: string | null
  api_key_encrypted: string | null
  model_id: string | null
  model_name: string | null
  max_context_characters: unknown
  max_output_tokens: unknown
  reasoning_effort: unknown
}

type FallbackModelRow = {
  id: string
  channel_id: string
  channel: unknown
  base_url: string
  api_key_encrypted: string | null
  channel_created_at: string
  model_created_at: string
}


/** Resolve a stored Chat Completions key only for its configured endpoint. */
export function getChannelApiKeyForBaseUrl(channelId: string, baseUrl: string): string | undefined {
  const normalizedBaseUrl = normalizeChatCompletionsBaseUrl(baseUrl)
  if (!normalizedBaseUrl) return undefined
  const database = getDatabase()
  const row = database.prepare(`
    SELECT channel, base_url, api_key_encrypted
    FROM ai_model_channels
    WHERE id = ?
  `).get(channelId) as Pick<ChannelRow, 'channel' | 'base_url' | 'api_key_encrypted'> | undefined
  if (!row || row.channel !== 'chat_completions' || !row.api_key_encrypted) return undefined
  if (normalizeChatCompletionsBaseUrl(row.base_url) !== normalizedBaseUrl) return undefined
  try {
    return decryptSecret(row.api_key_encrypted)
  } catch {
    return undefined
  }
}

export function getPublicAiModelSettings(): PublicAiModelSettings {
  const database = getDatabase()
  const revision = readSettingsRevision(database, 'models')
  const channels = database.prepare(`
    SELECT id, name, channel, base_url, api_key_encrypted, created_at, updated_at, updated_by
    FROM ai_model_channels
    ORDER BY created_at, id
  `).all() as ChannelRow[]
  const models = database.prepare(`
    SELECT id, channel_id, model_name, max_context_characters, max_output_tokens, reasoning_effort, created_at, updated_at
    FROM ai_model_profiles
    ORDER BY created_at, id
  `).all() as ModelRow[]
  const assignments = database.prepare(`
    SELECT target, model_id, updated_at, updated_by
    FROM ai_model_assignments
  `).all() as AssignmentRow[]

  const modelsByChannel = new Map<string, PublicAiModelProfile[]>()
  for (const model of models) {
    const profile = toPublicModelProfile(model)
    const current = modelsByChannel.get(profile.channelId) ?? []
    current.push(profile)
    modelsByChannel.set(profile.channelId, current)
  }

  const publicChannels = channels.map((channel) => toPublicChannel(channel, modelsByChannel.get(channel.id) ?? []))
  const assignmentsByTarget = new Map(assignments.flatMap((assignment) => {
    if (!isAiModelSelectionTarget(assignment.target)) return []
    return [[assignment.target, toAssignment(assignment)] as const]
  }))

  return {
    revision,
    channels: publicChannels,
    assignments: AI_MODEL_SELECTION_TARGETS.map((target) => assignmentsByTarget.get(target) ?? {
      target,
      updatedAt: '',
      updatedBy: '',
    }),
  }
}

export function getPublicAiPromptSettings(): PublicAiPromptSettings {
  const database = getDatabase()
  const revision = readSettingsRevision(database, 'prompts')
  const rows = database.prepare(`
    SELECT target, system_prompt, instruction_prompt, version, updated_at, updated_by
    FROM ai_prompt_settings
    ORDER BY rowid
  `).all() as PromptRow[]
  const global = toGlobalSystemPrompt(rows.find((row) => row.target === GLOBAL_SYSTEM_PROMPT_TARGET))
  const promptsByTarget = new Map(rows.flatMap((row) => {
    if (!isAiPromptTarget(row.target)) return []
    return [[row.target, row] as const]
  }))
  return {
    revision,
    systemPrompt: global,
    prompts: AI_PROMPT_TARGETS.map((target) => toPublicAiPromptSetting(promptsByTarget.get(target), target, global)),
  }
}

/** 返回创建分析任务时需要冻结的提示词副本。 */
export function getAiPromptSettingsSnapshot(): AnalysisPromptConfig[] {
  return getPublicAiPromptSettings().prompts.map((prompt) => ({ ...prompt }))
}

export function getAiPromptConfiguration(target: AiPromptTarget): AnalysisPromptConfig {
  return getPublicAiPromptSettings().prompts.find((prompt) => prompt.target === target) ?? getDefaultAiPromptConfig(target)
}

export function saveAiPromptSettings(input: AiPromptSettingInput, updatedBy: string, actorId?: string, expectedRevision?: number): PublicAiPromptSettings {
  const systemPrompt = normalizePromptText(input.systemPrompt, '系统提示词')
  const instructions = normalizeInstructionPrompts(input.prompts)
  const editor = normalizePromptUpdatedBy(updatedBy)
  const database = getDatabase()
  const timestamp = now()
  database.exec('BEGIN IMMEDIATE')
  try {
    assertActiveAdmin(database, actorId)
    assertSettingsRevision(database, 'prompts', expectedRevision)
    upsertPromptRow(database, GLOBAL_SYSTEM_PROMPT_TARGET, systemPrompt, null, editor, timestamp)
    for (const target of AI_PROMPT_TARGETS) {
      upsertPromptRow(database, target, systemPrompt, instructions.get(target)!, editor, timestamp)
    }
    assertAiPromptModelCompatibility(database)
    bumpSettingsRevision(database, 'prompts', editor, timestamp)
    database.exec('COMMIT')
  } catch (error) {
    try { database.exec('ROLLBACK') } catch { /* transaction already closed */ }
    throw error
  }
  return getPublicAiPromptSettings()
}

export function restoreAiPromptSettings(
  targets: AiPromptTarget[] | undefined,
  updatedBy: string,
  options?: { includeSystemPrompt?: boolean; actorId?: string; expectedRevision?: number },
): PublicAiPromptSettings {
  const selectedTargets = normalizeAiPromptTargets(targets)
  const includeSystemPrompt = options?.includeSystemPrompt === true
  const editor = normalizePromptUpdatedBy(updatedBy)
  const database = getDatabase()
  const timestamp = now()
  database.exec('BEGIN IMMEDIATE')
  try {
    assertActiveAdmin(database, options?.actorId)
    assertSettingsRevision(database, 'prompts', options?.expectedRevision)
    if (includeSystemPrompt) {
      upsertPromptRow(database, GLOBAL_SYSTEM_PROMPT_TARGET, DEFAULT_UNIFIED_SYSTEM_PROMPT, null, editor, timestamp)
    }
    const systemPrompt = readGlobalSystemPromptText(database)
    const selectedTargetSet = new Set(selectedTargets)
    const targetsToSync = includeSystemPrompt ? AI_PROMPT_TARGETS : selectedTargets
    for (const target of targetsToSync) {
      const instructionPrompt = selectedTargetSet.has(target) ? getDefaultAiPromptConfig(target).instructionPrompt : null
      upsertPromptRow(database, target, systemPrompt, instructionPrompt, editor, timestamp)
    }
    assertAiPromptModelCompatibility(database)
    bumpSettingsRevision(database, 'prompts', editor, timestamp)
    database.exec('COMMIT')
  } catch (error) {
    try { database.exec('ROLLBACK') } catch { /* transaction already closed */ }
    throw error
  }
  return getPublicAiPromptSettings()
}

/** 写入一行提示词配置；内容未变化时保留原版本号，避免让缓存的分析产物整体失效。 */
function upsertPromptRow(
  database: ReturnType<typeof getDatabase>,
  target: AiPromptTarget | typeof GLOBAL_SYSTEM_PROMPT_TARGET,
  systemPrompt: string,
  instructionPrompt: string | null,
  editor: string,
  timestamp: string,
) {
  const existing = database.prepare('SELECT system_prompt, instruction_prompt, version FROM ai_prompt_settings WHERE target = ?').get(target) as {
    system_prompt?: unknown
    instruction_prompt?: unknown
    version?: unknown
  } | undefined
  const nextSystemPrompt = systemPrompt
  const nextInstructionPrompt = instructionPrompt ?? readTextColumn(existing?.instruction_prompt) ?? ''
  if (readTextColumn(existing?.system_prompt) === nextSystemPrompt && readTextColumn(existing?.instruction_prompt) === nextInstructionPrompt) return
  const currentVersion = Number.isInteger(existing?.version) && Number(existing?.version) > 0 ? Number(existing?.version) : 0
  database.prepare(`
    INSERT INTO ai_prompt_settings(target, system_prompt, instruction_prompt, version, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(target) DO UPDATE SET
      system_prompt = excluded.system_prompt,
      instruction_prompt = excluded.instruction_prompt,
      version = excluded.version,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).run(target, nextSystemPrompt, nextInstructionPrompt, currentVersion + 1, timestamp, editor)
}

function readGlobalSystemPromptText(database: ReturnType<typeof getDatabase>) {
  const row = database.prepare('SELECT system_prompt FROM ai_prompt_settings WHERE target = ?').get(GLOBAL_SYSTEM_PROMPT_TARGET) as { system_prompt?: unknown } | undefined
  return readTextColumn(row?.system_prompt) ?? DEFAULT_UNIFIED_SYSTEM_PROMPT
}

/**
 * 保存设置前验证每个已分配模型能容纳当前提示词和固定输出协议。
 * 文档正文仍会按运行时上下文截取；这里只拒绝连配置本身都无法容纳的组合，
 * 避免请求发出后才因 system prompt 或 JSON Schema 协议过长失败。
 */
function assertAiPromptModelCompatibility(database: DatabaseSync) {
  const systemPrompt = readGlobalSystemPromptText(database)
  const promptRows = database.prepare(`
    SELECT target, instruction_prompt
    FROM ai_prompt_settings
  `).all() as Array<{ target?: unknown; instruction_prompt?: unknown }>
  const instructionByTarget = new Map<AiPromptTarget, string>()
  for (const row of promptRows) {
    if (isAiPromptTarget(row.target)) instructionByTarget.set(row.target, readTextColumn(row.instruction_prompt) ?? getDefaultAiPromptConfig(row.target).instructionPrompt)
  }

  const assignments = database.prepare(`
    SELECT assignments.target, assignments.model_id, profiles.model_name,
           profiles.max_context_characters
    FROM ai_model_assignments AS assignments
    LEFT JOIN ai_model_profiles AS profiles ON profiles.id = assignments.model_id
  `).all() as Array<{ target?: unknown; model_id?: unknown; model_name?: unknown; max_context_characters?: unknown }>

  for (const assignment of assignments) {
    if (!isAiModelSelectionTarget(assignment.target) || typeof assignment.model_id !== 'string' || !assignment.model_id) continue
    if (typeof assignment.model_name !== 'string' || !assignment.model_name) continue
    const target = assignment.target
    const instructionPrompt = instructionByTarget.get(target) ?? getDefaultAiPromptConfig(target).instructionPrompt
    const maxContextCharacters = readRuntimeLimit(
      assignment.max_context_characters,
      DEFAULT_MAX_CONTEXT_CHARACTERS,
      MIN_MAX_CONTEXT_CHARACTERS,
      MAX_MAX_CONTEXT_CHARACTERS,
    )
    createAnalysisPromptPlan({
      target,
      systemPrompt,
      taskPrompt: target === 'page_analysis' ? buildPageAnalysisTaskPrompt({ instructionPrompt }) : instructionPrompt,
      maxContextCharacters,
      modelLabel: assignment.model_name,
    })
  }
}

function readTextColumn(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null
}

function toGlobalSystemPrompt(row: PromptRow | undefined): AnalysisGlobalSystemPrompt {
  const fallback = getDefaultGlobalSystemPrompt()
  if (!row) return fallback
  return {
    systemPrompt: readTextColumn(row.system_prompt) ?? fallback.systemPrompt,
    version: Number.isInteger(row.version) && Number(row.version) > 0 ? Number(row.version) : fallback.version,
    updatedAt: row.updated_at || fallback.updatedAt,
    updatedBy: row.updated_by || fallback.updatedBy,
  }
}

function toPublicAiPromptSetting(row: PromptRow | undefined, target: AiPromptTarget, global: AnalysisGlobalSystemPrompt): PublicAiPromptSetting {
  const fallback = getDefaultAiPromptConfig(target)
  return {
    target,
    systemPrompt: global.systemPrompt,
    instructionPrompt: (row && readTextColumn(row.instruction_prompt)) ?? fallback.instructionPrompt,
    version: row && Number.isInteger(row.version) && Number(row.version) > 0 ? Number(row.version) : fallback.version,
    updatedAt: row?.updated_at || fallback.updatedAt,
    updatedBy: row?.updated_by || fallback.updatedBy,
  }
}

function normalizeInstructionPrompts(input: unknown) {
  if (!Array.isArray(input)) throw new Error('必须为全部分析环节提交任务提示词。')
  const prompts = new Map<AiPromptTarget, string>()
  for (const item of input) {
    if (!item || typeof item !== 'object' || !isAiPromptTarget((item as { target?: unknown }).target) || prompts.has((item as { target: AiPromptTarget }).target)) {
      throw new Error('提示词配置内容无效。')
    }
    const target = (item as { target: AiPromptTarget }).target
    prompts.set(target, normalizePromptText((item as { instructionPrompt?: unknown }).instructionPrompt, '任务提示词'))
  }
  if (prompts.size !== AI_PROMPT_TARGETS.length) throw new Error('必须为全部分析环节提交任务提示词。')
  return prompts
}

function normalizeAiPromptTargets(targets: AiPromptTarget[] | undefined) {
  if (targets === undefined) return [...AI_PROMPT_TARGETS]
  if (!Array.isArray(targets)) throw new Error('至少选择一个要恢复的提示词。')
  const unique = new Set<AiPromptTarget>()
  for (const target of targets) {
    if (!isAiPromptTarget(target) || unique.has(target)) throw new Error('提示词目标无效。')
    unique.add(target)
  }
  return AI_PROMPT_TARGETS.filter((target) => unique.has(target))
}

function normalizePromptText(value: unknown, label: string) {
  if (typeof value !== 'string') throw new Error(`${label}不能为空。`)
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label}不能为空。`)
  if (normalized.length > MAX_AI_PROMPT_TEXT_LENGTH) throw new Error(`${label}不能超过 ${MAX_AI_PROMPT_TEXT_LENGTH} 个字符。`)
  return normalized
}

function normalizePromptUpdatedBy(value: string) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new Error('更新人信息无效。')
  return value.trim()
}

function readAssignedAiModelRuntime(target: AiModelSelectionTarget) {
  const row = getDatabase().prepare(`
    SELECT
      assignments.target,
      channels.id AS channel_id,
      channels.name AS channel_name,
      channels.channel,
      channels.base_url,
      channels.api_key_encrypted,
      profiles.id AS model_id,
      profiles.model_name,
      profiles.max_context_characters,
      profiles.max_output_tokens,
      profiles.reasoning_effort
    FROM ai_model_assignments AS assignments
    LEFT JOIN ai_model_profiles AS profiles ON profiles.id = assignments.model_id
    LEFT JOIN ai_model_channels AS channels ON channels.id = profiles.channel_id
    WHERE assignments.target = ?
  `).get(target) as RuntimeRow | undefined

  if (!row || !row.model_id || !row.channel_id || !row.channel_name || !isAiChannel(row.channel) || !row.model_name) return undefined
  const modelName = normalizeGenericModelId(row.model_name)
  if (!modelName) return undefined
  return {
    row,
    channelId: row.channel_id,
    channelName: row.channel_name,
    channel: row.channel,
    modelId: row.model_id,
    modelName,
  }
}

function decryptChannelApiKey(channelName: string, encrypted: string | null) {
  try {
    return decryptSecret(encrypted)
  } catch {
    throw new Error('渠道「' + channelName + '」的 API 密钥无法解密（服务器加密密钥已更换或丢失），请在管理页重新输入并保存。')
  }
}

export function getAiModelRuntimeConfiguration(target: AiModelSelectionTarget): AiModelRuntimeConfiguration | undefined {
  const assigned = readAssignedAiModelRuntime(target)
  if (!assigned) return undefined
  const { row, channelId, channelName, channel, modelId, modelName } = assigned

  return {
    target,
    channelId,
    channelName,
    channel,
    baseUrl: normalizeChatCompletionsBaseUrl(row.base_url) ?? '',
    apiKey: decryptChannelApiKey(channelName, row.api_key_encrypted),
    modelId,
    modelName,
    maxContextCharacters: readRuntimeLimit(
      row.max_context_characters,
      DEFAULT_MAX_CONTEXT_CHARACTERS,
      MIN_MAX_CONTEXT_CHARACTERS,
      MAX_MAX_CONTEXT_CHARACTERS,
    ),
    maxOutputTokens: readRuntimeLimit(
      row.max_output_tokens,
      DEFAULT_MAX_OUTPUT_TOKENS,
      MIN_MAX_OUTPUT_TOKENS,
      MAX_MAX_OUTPUT_TOKENS,
    ),
    reasoningEffort: isAiReasoningEffort(row.reasoning_effort) ? row.reasoning_effort : DEFAULT_REASONING_EFFORT,
  }
}

export function getAiModelRuntimeSnapshot(target: AiModelSelectionTarget): AiModelRuntimeSnapshot | undefined {
  const assigned = readAssignedAiModelRuntime(target)
  if (!assigned) return undefined
  const { row, channelId, channelName, channel, modelId, modelName } = assigned
  decryptChannelApiKey(channelName, row.api_key_encrypted)
  return {
    target,
    channelId,
    channelName,
    channel,
    baseUrl: normalizeChatCompletionsBaseUrl(row.base_url) ?? '',
    apiKeyEncrypted: row.api_key_encrypted,
    modelId,
    modelName,
    maxContextCharacters: readRuntimeLimit(
      row.max_context_characters,
      DEFAULT_MAX_CONTEXT_CHARACTERS,
      MIN_MAX_CONTEXT_CHARACTERS,
      MAX_MAX_CONTEXT_CHARACTERS,
    ),
    maxOutputTokens: readRuntimeLimit(
      row.max_output_tokens,
      DEFAULT_MAX_OUTPUT_TOKENS,
      MIN_MAX_OUTPUT_TOKENS,
      MAX_MAX_OUTPUT_TOKENS,
    ),
    reasoningEffort: isAiReasoningEffort(row.reasoning_effort) ? row.reasoning_effort : DEFAULT_REASONING_EFFORT,
    settingsRevision: readSettingsRevision(getDatabase(), 'models'),
  }
}
export function saveAiModelChannel(input: AiModelChannelInput, existingChannelId?: string, actorId?: string, expectedRevision?: number): PublicAiModelSettings {
  const normalized = normalizeChannelInput(input)
  const database = getDatabase()
  const timestamp = now()

  database.exec('BEGIN IMMEDIATE')
  try {
    assertActiveAdmin(database, actorId)
    assertSettingsRevision(database, 'models', expectedRevision)
    const existing = existingChannelId
      ? database.prepare(`
          SELECT id, name, channel, base_url, api_key_encrypted, created_at, updated_at, updated_by
          FROM ai_model_channels
          WHERE id = ?
        `).get(existingChannelId) as ChannelRow | undefined
      : undefined
    if (existingChannelId && !existing) throw new Error('渠道不存在或已被删除。')

    const channelId = existing?.id ?? createChannelId()
    const existingModels = existing
      ? database.prepare(`
          SELECT id, channel_id, model_name, max_context_characters, max_output_tokens, reasoning_effort, created_at, updated_at
          FROM ai_model_profiles
          WHERE channel_id = ?
        `).all(channelId) as ModelRow[]
      : []
    const existingModelIds = new Set(existingModels.map((model) => model.id))
    const requestedModelsById = new Map<string, (typeof normalized.models)[number]>()
    for (const model of normalized.models) {
      if (model.id && !existingModelIds.has(model.id)) throw new Error('模型不属于当前渠道。')
      if (model.id && requestedModelsById.has(model.id)) throw new Error('同一渠道不能重复提交同一个模型。')
      if (model.id) requestedModelsById.set(model.id, model)
    }

    const apiKeyEncrypted = resolveApiKeyEncrypted(existing, normalized)
    if (existing) {
      database.prepare(`
        UPDATE ai_model_channels
        SET name = ?, channel = ?, base_url = ?, api_key_encrypted = ?, updated_at = ?, updated_by = ?
        WHERE id = ?
      `).run(
        normalized.name,
        normalized.channel,
        normalized.baseUrl,
        apiKeyEncrypted,
        timestamp,
        normalized.updatedBy,
        channelId,
      )
    } else {
      database.prepare(`
        INSERT INTO ai_model_channels (
          id, name, channel, base_url, api_key_encrypted, created_at, updated_at, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        channelId,
        normalized.name,
        normalized.channel,
        normalized.baseUrl,
        apiKeyEncrypted,
        timestamp,
        timestamp,
        normalized.updatedBy,
      )
    }

    const temporaryModels = existingModels.filter((model) => {
      const requested = requestedModelsById.get(model.id)
      return !requested || requested.modelName !== model.model_name
    })
    for (const model of temporaryModels) {
      database.prepare('UPDATE ai_model_profiles SET model_name = ? WHERE id = ?').run(`__yanxing_pending_${model.id}`, model.id)
    }

    const retainedModelIds = new Set<string>()
    for (const model of normalized.models) {
      const modelId = model.id ?? createModelId()
      retainedModelIds.add(modelId)
      if (model.id) {
        database.prepare(`
          UPDATE ai_model_profiles
          SET model_name = ?, max_context_characters = ?, max_output_tokens = ?, reasoning_effort = ?, updated_at = ?
          WHERE id = ?
        `).run(
          model.modelName,
          model.maxContextCharacters,
          model.maxOutputTokens,
          model.reasoningEffort,
          timestamp,
          modelId,
        )
      } else {
        database.prepare(`
          INSERT INTO ai_model_profiles (
            id, channel_id, model_name, max_context_characters, max_output_tokens, reasoning_effort, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          modelId,
          channelId,
          model.modelName,
          model.maxContextCharacters,
          model.maxOutputTokens,
          model.reasoningEffort,
          timestamp,
          timestamp,
        )
      }
    }

    const removedModelIds = existingModels
      .filter((model) => !retainedModelIds.has(model.id))
      .map((model) => model.id)
    reassignRemovedModelAssignments(database, removedModelIds, normalized.updatedBy, timestamp, channelId)
    for (const modelId of removedModelIds) {
      database.prepare('DELETE FROM ai_model_profiles WHERE id = ?').run(modelId)
    }
    assertAiPromptModelCompatibility(database)
    bumpSettingsRevision(database, 'models', normalized.updatedBy, timestamp)

    database.exec('COMMIT')
  } catch (error) {
    try { database.exec('ROLLBACK') } catch { /* transaction already closed */ }
    throw error
  }

  return getPublicAiModelSettings()
}

export function deleteAiModelChannel(channelId: string, updatedBy = '系统管理员', actorId?: string, expectedRevision?: number): PublicAiModelSettings {
  if (!isSafeIdentifier(channelId)) throw new Error('渠道标识无效。')
  if (typeof updatedBy !== 'string' || !updatedBy.trim() || updatedBy.trim().length > 80) throw new Error('更新人信息无效。')
  const database = getDatabase()
  const timestamp = now()

  database.exec('BEGIN IMMEDIATE')
  try {
    assertActiveAdmin(database, actorId)
    assertSettingsRevision(database, 'models', expectedRevision)
    const models = database.prepare('SELECT id FROM ai_model_profiles WHERE channel_id = ?').all(channelId) as Array<{ id: string }>
    reassignRemovedModelAssignments(database, models.map((model) => model.id), updatedBy.trim(), timestamp)
    const result = database.prepare('DELETE FROM ai_model_channels WHERE id = ?').run(channelId)
    if (!result.changes) throw new Error('渠道不存在或已被删除。')
    assertAiPromptModelCompatibility(database)
    bumpSettingsRevision(database, 'models', updatedBy.trim(), timestamp)
    database.exec('COMMIT')
  } catch (error) {
    try { database.exec('ROLLBACK') } catch { /* transaction already closed */ }
    throw error
  }

  return getPublicAiModelSettings()
}

/** Reassign targets before removing models so surviving configured models remain runnable. */
function reassignRemovedModelAssignments(
  database: DatabaseSync,
  removedModelIds: string[],
  updatedBy: string,
  timestamp: string,
  preferredChannelId?: string,
) {
  if (!removedModelIds.length) return
  const placeholders = removedModelIds.map(() => '?').join(', ')
  const affected = database.prepare(`
    SELECT target
    FROM ai_model_assignments
    WHERE model_id IN (${placeholders})
  `).all(...removedModelIds) as Array<{ target: unknown }>
  if (!affected.length) return

  const fallbackModelId = findFallbackModelId(database, new Set(removedModelIds), preferredChannelId)
  const update = database.prepare(`
    UPDATE ai_model_assignments
    SET model_id = ?, updated_at = ?, updated_by = ?
    WHERE target = ?
  `)
  for (const assignment of affected) {
    if (!isAiModelSelectionTarget(assignment.target)) continue
    update.run(fallbackModelId ?? null, timestamp, updatedBy, assignment.target)
  }
}

function findFallbackModelId(database: DatabaseSync, excludedModelIds: Set<string>, preferredChannelId?: string) {
  const candidates = database.prepare(`
    SELECT
      profiles.id,
      profiles.channel_id,
      channels.channel,
      channels.base_url,
      channels.api_key_encrypted,
      channels.created_at AS channel_created_at,
      profiles.created_at AS model_created_at
    FROM ai_model_profiles AS profiles
    INNER JOIN ai_model_channels AS channels ON channels.id = profiles.channel_id
    WHERE channels.api_key_encrypted IS NOT NULL AND trim(channels.api_key_encrypted) <> ''
    ORDER BY
      CASE WHEN channels.id = ? THEN 0 ELSE 1 END,
      channels.created_at,
      channels.id,
      profiles.created_at,
      profiles.id
  `).all(preferredChannelId ?? '') as FallbackModelRow[]

  for (const candidate of candidates) {
    if (excludedModelIds.has(candidate.id) || !isAiChannel(candidate.channel)) continue
    return candidate.id
  }
  return undefined
}

export function saveAiModelAssignments(input: AiModelAssignmentInput[], updatedBy: string, actorId?: string, expectedRevision?: number): PublicAiModelSettings {
  if (!Array.isArray(input) || input.length !== AI_MODEL_SELECTION_TARGETS.length) {
    throw new Error('必须为全部分析环节提交模型选择。')
  }
  const assignments = new Map<AiModelSelectionTarget, string | undefined>()
  for (const item of input) {
    if (!item || !isAiModelSelectionTarget(item.target) || assignments.has(item.target)) {
      throw new Error('模型选择内容无效。')
    }
    if (item.modelId !== undefined && !isSafeIdentifier(item.modelId)) throw new Error('模型标识无效。')
    assignments.set(item.target, item.modelId)
  }
  if (assignments.size !== AI_MODEL_SELECTION_TARGETS.length) throw new Error('必须为全部分析环节提交模型选择。')

  const database = getDatabase()
  const selectedIds = Array.from(new Set(Array.from(assignments.values()).filter((modelId): modelId is string => Boolean(modelId))))
  if (selectedIds.length) {
    const placeholders = selectedIds.map(() => '?').join(', ')
    const rows = database.prepare(`SELECT id FROM ai_model_profiles WHERE id IN (${placeholders})`).all(...selectedIds) as Array<{ id: string }>
    if (rows.length !== selectedIds.length) throw new Error('所选模型不存在或已被删除。')
  }

  const timestamp = now()
  database.exec('BEGIN IMMEDIATE')
  try {
    assertActiveAdmin(database, actorId)
    assertSettingsRevision(database, 'models', expectedRevision)
    const statement = database.prepare(`
      INSERT INTO ai_model_assignments(target, model_id, updated_at, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(target) DO UPDATE SET
        model_id = excluded.model_id,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `)
    for (const target of AI_MODEL_SELECTION_TARGETS) {
      statement.run(target, assignments.get(target) ?? null, timestamp, updatedBy)
    }
    assertAiPromptModelCompatibility(database)
    bumpSettingsRevision(database, 'models', updatedBy, timestamp)
    database.exec('COMMIT')
  } catch (error) {
    try { database.exec('ROLLBACK') } catch { /* transaction already closed */ }
    throw error
  }

  return getPublicAiModelSettings()
}

function assertActiveAdmin(database: DatabaseSync, actorId?: string) {
  if (!actorId) return
  const actor = database.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'admin' AND status = 'active'").get(actorId)
  if (!actor) throw new Error('管理员权限已变更，请重新登录。')
}

function readSettingsRevision(database: DatabaseSync, scope: 'models' | 'prompts') {
  const row = database.prepare('SELECT revision FROM settings_revisions WHERE scope = ?').get(scope) as { revision?: unknown } | undefined
  const revision = row?.revision
  return Number.isSafeInteger(revision) && Number(revision) > 0 ? Number(revision) : 1
}

function assertSettingsRevision(database: DatabaseSync, scope: 'models' | 'prompts', expectedRevision?: number) {
  if (expectedRevision === undefined) return
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('设置版本无效。')
  const actualRevision = readSettingsRevision(database, scope)
  if (expectedRevision !== actualRevision) throw new SettingsRevisionConflictError(scope, expectedRevision, actualRevision)
}

function bumpSettingsRevision(database: DatabaseSync, scope: 'models' | 'prompts', updatedBy: string, timestamp: string) {
  database.prepare(`
    INSERT INTO settings_revisions(scope, revision, updated_at, updated_by) VALUES (?, 1, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET revision = settings_revisions.revision + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `).run(scope, timestamp, updatedBy)
}

function normalizeChannelInput(input: AiModelChannelInput) {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > 80) throw new Error('渠道名称不能为空，且不能超过 80 个字符。')
  if (!Array.isArray(input.models) || input.models.length < 1 || input.models.length > 32) {
    throw new Error('每个渠道必须配置 1 到 32 个模型。')
  }
  const normalizedBaseUrl = normalizeChatCompletionsBaseUrl(input.baseUrl)
  if (!normalizedBaseUrl) throw new Error('Chat Completions API 地址无效。')
  if (typeof input.updatedBy !== 'string' || !input.updatedBy.trim() || input.updatedBy.trim().length > 80) {
    throw new Error('更新人信息无效。')
  }
  const apiKey = input.apiKey?.trim()
  if (apiKey && apiKey.length > 10_000) throw new Error('API 密钥长度无效。')

  const seenModels = new Set<string>()
  const models = input.models.map((model) => {
    if (!model || (model.id !== undefined && !isSafeIdentifier(model.id))) throw new Error('模型标识无效。')
    const modelName = normalizeGenericModelId(model.modelName)
    if (!modelName) throw new Error('模型名称不能为空，且不能超过 160 个字符。')
    if (seenModels.has(modelName)) throw new Error('同一渠道不能重复添加相同模型。')
    seenModels.add(modelName)
    if (!isValidMaxContextCharacters(model.maxContextCharacters)) {
      throw new Error('最大上下文必须为 ' + MIN_MAX_CONTEXT_CHARACTERS + ' 到 ' + MAX_MAX_CONTEXT_CHARACTERS + ' 之间的整数（字符）。')
    }
    if (!isValidMaxOutputTokens(model.maxOutputTokens)) {
      throw new Error('最大输出必须为 ' + MIN_MAX_OUTPUT_TOKENS + ' 到 ' + MAX_MAX_OUTPUT_TOKENS + ' 之间的整数（tokens）。')
    }
    if (!isAiReasoningEffort(model.reasoningEffort)) throw new Error('请选择有效的推理强度。')
    return {
      id: model.id,
      modelName,
      maxContextCharacters: model.maxContextCharacters,
      maxOutputTokens: model.maxOutputTokens,
      reasoningEffort: model.reasoningEffort,
    }
  })

  return {
    name,
    channel: 'chat_completions',
    baseUrl: normalizedBaseUrl,
    apiKey,
    clearApiKey: input.clearApiKey === true,
    models,
    updatedBy: input.updatedBy.trim(),
  }
}

function resolveApiKeyEncrypted(existing: ChannelRow | undefined, input: ReturnType<typeof normalizeChannelInput>) {
  if (input.clearApiKey) return null
  if (input.apiKey) return encryptSecret(input.apiKey)
  if (!existing) return null
  const existingChannel = isAiChannel(existing.channel) ? existing.channel : undefined
  const sameCredentialScope = existingChannel === input.channel && normalizeChatCompletionsBaseUrl(existing.base_url) === input.baseUrl
  return sameCredentialScope ? existing.api_key_encrypted : null
}

function toPublicChannel(row: ChannelRow, models: PublicAiModelProfile[]): PublicAiModelChannel {
  // hasApiKey 表示"已配置密钥"（密文存在）；解密失败不改变该语义，只置 apiKeyUnavailable，
  // 保证密钥丢失或更换后设置页仍可打开并提示重新输入，而不是把渠道显示成未配置。
  const configured = Boolean(row.api_key_encrypted)
  let apiKey: string | undefined
  try {
    apiKey = decryptSecret(row.api_key_encrypted)
  } catch {
    apiKey = undefined
  }
  return {
    id: row.id,
    name: row.name,
    baseUrl: normalizeChatCompletionsBaseUrl(row.base_url) ?? '',
    hasApiKey: configured,
    apiKeyLastFour: apiKey ? apiKey.slice(-4) : '',
    apiKeyUnavailable: configured && !apiKey ? true : undefined,
    models,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  }
}

function toPublicModelProfile(row: ModelRow): PublicAiModelProfile {
  return {
    id: row.id,
    channelId: row.channel_id,
    modelName: row.model_name,
    maxContextCharacters: readRuntimeLimit(
      row.max_context_characters,
      DEFAULT_MAX_CONTEXT_CHARACTERS,
      MIN_MAX_CONTEXT_CHARACTERS,
      MAX_MAX_CONTEXT_CHARACTERS,
    ),
    maxOutputTokens: readRuntimeLimit(
      row.max_output_tokens,
      DEFAULT_MAX_OUTPUT_TOKENS,
      MIN_MAX_OUTPUT_TOKENS,
      MAX_MAX_OUTPUT_TOKENS,
    ),
    reasoningEffort: isAiReasoningEffort(row.reasoning_effort) ? row.reasoning_effort : DEFAULT_REASONING_EFFORT,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toAssignment(row: AssignmentRow): AiModelAssignment {
  return {
    target: row.target as AiModelSelectionTarget,
    modelId: row.model_id ?? undefined,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  }
}

function normalizeGenericModelId(value: unknown) {
  if (typeof value !== 'string') return ''
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= 160 ? normalized : ''
}


function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 120
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
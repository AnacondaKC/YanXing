import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { getDefaultAiPromptConfig, getDefaultGlobalSystemPrompt } from '../lib/ai/prompt-defaults'

const directory = await mkdtemp(`${tmpdir()}/yanxing-model-settings-`)
process.env.YANXING_DATABASE_PATH = path.join(directory, 'model-settings.sqlite')
process.env.YANXING_SETTINGS_ENCRYPTION_KEY = 'model-settings-test-encryption-key'

const {
  AI_MODEL_SELECTION_TARGETS,
  deleteAiModelChannel,
  getPublicAiModelSettings,
  getPublicAiPromptSettings,
  getAiPromptSettingsSnapshot,
  getChannelApiKeyForBaseUrl,
  saveAiModelAssignments,
  saveAiModelChannel,
  saveAiPromptSettings,
  restoreAiPromptSettings,
} = await import('../lib/db/settings-repository')
const { createModelRuntime } = await import('../lib/ai/model-router')

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

test('model channels preserve multiple profiles, resolve per target, and fall back after removal', () => {
  const initial = getPublicAiModelSettings()
  assert.equal(initial.channels.length, 1)
  assert.equal(initial.channels[0]?.models[0]?.maxContextCharacters, 1_000_000)
  assert.equal(Object.hasOwn(initial.channels[0], 'channel'), false)
  assert.equal(initial.assignments.length, 2)
  assert.deepEqual(initial.assignments.map((assignment) => assignment.target), ['page_analysis', 'report_insight'])
  assert.equal(initial.assignments.every((assignment) => assignment.modelId === initial.channels[0].models[0].id), true)

  const fallbackSettings = saveAiModelChannel({
    name: '备用 OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'fallback-model-settings-test-key',
    models: [{
      modelName: 'gpt-4.1-nano',
      maxContextCharacters: 120_000,
      maxOutputTokens: 4_096,
      reasoningEffort: 'low',
    }],
    updatedBy: 'test-admin',
  })
  const fallbackChannel = fallbackSettings.channels.find((channel) => channel.name === '备用 OpenAI')
  assert.ok(fallbackChannel)

  const created = saveAiModelChannel({
    name: '研究团队 OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'generic-model-settings-test-key',
    models: [{
      modelName: 'gpt-4.1-mini',
      maxContextCharacters: 240_000,
      maxOutputTokens: 8_192,
      reasoningEffort: 'high',
    }],
    updatedBy: 'test-admin',
  })
  const genericChannel = created.channels.find((channel) => channel.name === '研究团队 OpenAI')
  assert.ok(genericChannel)
  assert.equal(genericChannel.hasApiKey, true)
  assert.equal(genericChannel.apiKeyLastFour, '-key')
  assert.equal(genericChannel.models.length, 1)
  assert.equal(getChannelApiKeyForBaseUrl(genericChannel.id, 'https://api.openai.com/v1/chat/completions'), 'generic-model-settings-test-key')
  assert.equal(getChannelApiKeyForBaseUrl(genericChannel.id, 'https://untrusted.example/v1'), undefined)

  const selected = saveAiModelAssignments(created.assignments.map((assignment) => ({
    target: assignment.target,
    modelId: assignment.target === 'page_analysis' ? genericChannel.models[0].id : assignment.modelId,
  })), 'test-admin')
  assert.equal(selected.assignments.find((assignment) => assignment.target === 'page_analysis')?.modelId, genericChannel.models[0].id)

  const runtime = createModelRuntime('page_analysis')
  assert.deepEqual(runtime.primary, {
    id: 'gpt-4.1-mini',
    provider: 'chat_completions',
    baseUrl: 'https://api.openai.com/v1',
    maxContextCharacters: 240_000,
    maxOutputTokens: 8_192,
    reasoningEffort: 'high',
  })
  assert.equal(runtime.apiKey, 'generic-model-settings-test-key')

  const deleted = deleteAiModelChannel(genericChannel.id, 'test-admin')
  const fallbackAssignment = deleted.assignments.find((assignment) => assignment.target === 'page_analysis')?.modelId
  assert.ok(fallbackAssignment)
  assert.notEqual(fallbackAssignment, genericChannel.models[0].id)
  assert.equal(createModelRuntime('page_analysis').primary.id, deleted.channels.flatMap((channel) => channel.models).find((model) => model.id === fallbackAssignment)?.modelName)

  const multiModelSettings = saveAiModelChannel({
    name: '同渠道备用模型',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'multi-model-settings-test-key',
    models: [
      {
        modelName: 'gpt-4.1-mini',
        maxContextCharacters: 240_000,
        maxOutputTokens: 8_192,
        reasoningEffort: 'high',
      },
      {
        modelName: 'gpt-4.1-nano',
        maxContextCharacters: 120_000,
        maxOutputTokens: 4_096,
        reasoningEffort: 'low',
      },
    ],
    updatedBy: 'test-admin',
  })
  const multiModelChannel = multiModelSettings.channels.find((channel) => channel.name === '同渠道备用模型')
  assert.ok(multiModelChannel)
  const [primaryModel, siblingModel] = multiModelChannel.models

  saveAiModelAssignments(multiModelSettings.assignments.map((assignment) => ({
    target: assignment.target,
    modelId: assignment.target === 'page_analysis' ? primaryModel.id : assignment.modelId,
  })), 'test-admin')
  const afterModelRemoval = saveAiModelChannel({
    name: multiModelChannel.name,
    baseUrl: multiModelChannel.baseUrl,
    models: [
      {
        id: siblingModel.id,
        modelName: siblingModel.modelName,
        maxContextCharacters: siblingModel.maxContextCharacters,
        maxOutputTokens: siblingModel.maxOutputTokens,
        reasoningEffort: siblingModel.reasoningEffort,
      },
      {
        modelName: primaryModel.modelName,
        maxContextCharacters: primaryModel.maxContextCharacters,
        maxOutputTokens: primaryModel.maxOutputTokens,
        reasoningEffort: primaryModel.reasoningEffort,
      },
    ],
    updatedBy: 'test-admin',
  }, multiModelChannel.id)
  assert.equal(afterModelRemoval.assignments.find((assignment) => assignment.target === 'page_analysis')?.modelId, siblingModel.id)
  const updatedMultiModelChannel = afterModelRemoval.channels.find((channel) => channel.id === multiModelChannel.id)
  assert.ok(updatedMultiModelChannel?.models.some((model) => model.id !== primaryModel.id && model.modelName === primaryModel.modelName))
})

test('prompt settings persist versions, snapshots, and selective default restoration', () => {
  const initial = getPublicAiPromptSettings()
  assert.equal(initial.prompts.length, 2)
  assert.deepEqual(initial.prompts.map((prompt) => prompt.target), ['page_analysis', 'report_insight'])
  assert.ok(initial.systemPrompt.systemPrompt.length > 0)
  assert.equal(initial.prompts.every((prompt) => prompt.version === 1), true)
  assert.equal(initial.prompts.every((prompt) => prompt.systemPrompt === initial.systemPrompt.systemPrompt), true)

  const saved = saveAiPromptSettings({
    systemPrompt: '统一测试系统提示词。',
    prompts: initial.prompts.map(({ target, instructionPrompt }) => ({
      target,
      instructionPrompt: target === 'page_analysis' ? '测试分析页任务提示词。' : instructionPrompt,
    })),
  }, 'test-admin')
  const savedPageAnalysis = saved.prompts.find((prompt) => prompt.target === 'page_analysis')
  assert.ok(savedPageAnalysis)
  assert.equal(savedPageAnalysis.instructionPrompt, '测试分析页任务提示词。')
  assert.equal(savedPageAnalysis.systemPrompt, '统一测试系统提示词。')
  assert.equal(savedPageAnalysis.version, 2)
  assert.equal(saved.systemPrompt.systemPrompt, '统一测试系统提示词。')

  const snapshot = getAiPromptSettingsSnapshot()
  assert.equal(snapshot.find((prompt) => prompt.target === 'page_analysis')?.instructionPrompt, '测试分析页任务提示词。')
  assert.equal(snapshot.every((prompt) => prompt.systemPrompt === '统一测试系统提示词。'), true)
  assert.notEqual(snapshot, saved.prompts)

  const restored = restoreAiPromptSettings(['page_analysis'], 'test-admin')
  const restoredPageAnalysis = restored.prompts.find((prompt) => prompt.target === 'page_analysis')
  const unchangedInsight = restored.prompts.find((prompt) => prompt.target === 'report_insight')
  assert.ok(restoredPageAnalysis)
  assert.ok(unchangedInsight)
  assert.equal(restoredPageAnalysis.instructionPrompt, getDefaultAiPromptConfig('page_analysis').instructionPrompt)
  assert.equal(restoredPageAnalysis.version, 3)
  assert.equal(unchangedInsight.version, 2)
  assert.equal(restored.systemPrompt.systemPrompt, '统一测试系统提示词。')

  const defaultRestored = restoreAiPromptSettings(undefined, 'test-admin', { includeSystemPrompt: true })
  const unifiedDefault = getDefaultGlobalSystemPrompt().systemPrompt
  assert.equal(defaultRestored.systemPrompt.systemPrompt, unifiedDefault)
  assert.equal(defaultRestored.prompts.every((prompt) => prompt.systemPrompt === unifiedDefault), true)
  assert.equal(defaultRestored.prompts.find((prompt) => prompt.target === 'page_analysis')?.instructionPrompt, getDefaultAiPromptConfig('page_analysis').instructionPrompt)
})

test('prompt and model settings reject combinations that cannot fit the selected context', () => {
  const originalPrompts = getPublicAiPromptSettings()
  const tinyChannel = saveAiModelChannel({
    name: '上下文不足测试',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'context-validation-test-key',
    models: [{
      modelName: 'context-validation-model',
      maxContextCharacters: 8_000,
      maxOutputTokens: 4_096,
      reasoningEffort: 'low',
    }],
    updatedBy: 'test-admin',
  })
  const tinyModel = tinyChannel.channels.find((channel) => channel.name === '上下文不足测试')?.models[0]
  assert.ok(tinyModel)

  saveAiPromptSettings({
    systemPrompt: '系统约束'.repeat(2_000),
    prompts: originalPrompts.prompts.map(({ target, instructionPrompt }) => ({ target, instructionPrompt })),
  }, 'test-admin')
  try {
    assert.throws(
      () => saveAiModelAssignments(originalPrompts.prompts.map(({ target }) => ({ target, modelId: tinyModel.id })), 'test-admin'),
      /无法容纳.*系统提示词.*输出协议/,
    )
    assert.notEqual(getPublicAiModelSettings().assignments.find((assignment) => assignment.target === 'page_analysis')?.modelId, tinyModel.id)
  } finally {
    restoreAiPromptSettings(undefined, 'test-admin', { includeSystemPrompt: true })
    deleteAiModelChannel(tinyChannel.channels.find((channel) => channel.name === '上下文不足测试')!.id, 'test-admin')
  }
})

test('hot-reloaded client module rechecks the canonical migration ledger', async () => {
  const initial = await import('../lib/db/client')
  const first = initial.migrateDatabase()
  const reloaded = await import('../lib/db/client.ts?hot-reload=' + Date.now())
  const second = reloaded.migrateDatabase()
  const database = reloaded.getDatabase()
  const ledger = database.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as Array<{ version: number; name: string; checksum: string }>
  assert.equal(first.version, first.migrations.at(-1)?.version)
  assert.equal(second.version, first.version)
  assert.deepEqual(ledger.map((row) => ({ ...row })), first.migrations.map((migration) => ({
    version: migration.version,
    name: migration.name,
    checksum: migration.checksum,
  })))

  const checksum = first.migrations[0]?.checksum ?? ''
  database.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run('tampered')
  assert.throws(() => reloaded.migrateDatabase(), /迁移账本校验失败.*破坏性 schema 重置/)
  database.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run(checksum)
  assert.equal(reloaded.migrateDatabase().version, first.version)
})

test('unreadable channel ciphertext keeps settings readable and fails model runtime with a clear error', () => {
  const drill = saveAiModelChannel({
    name: '解密失败演练',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'decrypt-drill-test-key',
    models: [{
      modelName: 'decrypt-drill-model',
      maxContextCharacters: 120_000,
      maxOutputTokens: 4_096,
      reasoningEffort: 'low',
    }],
    updatedBy: 'test-admin',
  })
  const drillModel = drill.channels.find((channel) => channel.name === '解密失败演练')?.models[0]
  assert.ok(drillModel)
  saveAiModelAssignments(AI_MODEL_SELECTION_TARGETS.map((target) => ({ target, modelId: drillModel.id })), 'test-admin')
  assert.equal(createModelRuntime('page_analysis').apiKey, 'decrypt-drill-test-key')

  const originalKey = process.env.YANXING_SETTINGS_ENCRYPTION_KEY
  process.env.YANXING_SETTINGS_ENCRYPTION_KEY = 'rotated-away-from-original-key'
  try {
    const settings = getPublicAiModelSettings()
    const unreadable = settings.channels.find((channel) => channel.name === '解密失败演练')
    assert.ok(unreadable)
    assert.equal(unreadable.hasApiKey, true)
    assert.equal(unreadable.apiKeyLastFour, '')
    assert.equal(unreadable.apiKeyUnavailable, true)
    assert.throws(() => createModelRuntime('page_analysis'), /无法解密/)
  } finally {
    process.env.YANXING_SETTINGS_ENCRYPTION_KEY = originalKey
  }

  const restored = getPublicAiModelSettings()
  const recovered = restored.channels.find((channel) => channel.name === '解密失败演练')
  assert.ok(recovered)
  assert.equal(recovered.apiKeyUnavailable, undefined)
  assert.equal(recovered.apiKeyLastFour, '-key')
  assert.equal(createModelRuntime('page_analysis').apiKey, 'decrypt-drill-test-key')
})

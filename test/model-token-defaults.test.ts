import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'
import { createModelDraft } from '../components/admin/ai-settings-types'
import { getMaxOutputTokens } from '../lib/ai/runtime/output-protocol'
import {
  DEFAULT_CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from '../lib/ai/runtime-options'
import { seedInitialAiSettings } from '../lib/db/initial-ai-settings'
import { databaseMigrations } from '../lib/db/migrations'

const OUTPUT_TOKEN_ENV = 'YANXING_MODEL_MAX_OUTPUT_TOKENS'
const EXPLICIT_MAX_OUTPUT_TOKENS = 32_768
const EXISTING_PROFILE_MAX_OUTPUT_TOKENS = 131_072

function readSeededMaxOutputTokens(database: DatabaseSync) {
  const row = database.prepare('SELECT max_output_tokens AS maxOutputTokens FROM ai_model_profiles').get() as
    | { maxOutputTokens: number }
    | undefined
  assert.ok(row, 'expected a seeded model profile')
  return Number(row.maxOutputTokens)
}

function runInImmediateTransaction(database: DatabaseSync, operate: () => void) {
  database.exec('BEGIN IMMEDIATE')
  try {
    operate()
    database.exec('COMMIT')
  } catch (error) {
    try { database.exec('ROLLBACK') } catch { /* transaction already closed */ }
    throw error
  }
}

function createIsolatedDatabase(context: TestContext) {
  const database = new DatabaseSync(':memory:')
  context.after(() => database.close())
  database.exec('PRAGMA foreign_keys = ON;')
  runInImmediateTransaction(database, () => {
    for (const migration of databaseMigrations) {
      migration.apply(database)
    }
  })
  return database
}

async function withOutputTokenEnv<T>(value: string | undefined, operate: () => T | Promise<T>) {
  const previous = process.env[OUTPUT_TOKEN_ENV]
  try {
    if (value === undefined) delete process.env[OUTPUT_TOKEN_ENV]
    else process.env[OUTPUT_TOKEN_ENV] = value
    return await operate()
  } finally {
    if (previous === undefined) delete process.env[OUTPUT_TOKEN_ENV]
    else process.env[OUTPUT_TOKEN_ENV] = previous
  }
}

test('createModelDraft defaults maxOutputTokens to 65536', () => {
  assert.equal(DEFAULT_CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS, 65_536)
  assert.equal(createModelDraft().maxOutputTokens, DEFAULT_CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS)
})

test('runtime getMaxOutputTokens still falls back to 16384', () => {
  assert.equal(DEFAULT_MAX_OUTPUT_TOKENS, 16_384)
  assert.equal(getMaxOutputTokens(), DEFAULT_MAX_OUTPUT_TOKENS)
  assert.equal(getMaxOutputTokens(undefined), DEFAULT_MAX_OUTPUT_TOKENS)
  assert.equal(getMaxOutputTokens(65_536), 65_536)
})

test('first seedInitialAiSettings reads the 65536 default after env override is cleared', async (context) => {
  await withOutputTokenEnv(undefined, async () => {
    const { runtimeConfig } = await import('../lib/config/environment')
    assert.equal(runtimeConfig.model.maxOutputTokens, undefined)
    const database = createIsolatedDatabase(context)
    assert.equal(readSeededMaxOutputTokens(database), DEFAULT_CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS)
  })
})

test('explicit env and runtimeConfig values take priority over the 65536 default', async (context) => {
  await withOutputTokenEnv(String(EXPLICIT_MAX_OUTPUT_TOKENS), async () => {
    const { runtimeConfig } = await import('../lib/config/environment')
    assert.equal(runtimeConfig.model.maxOutputTokens, String(EXPLICIT_MAX_OUTPUT_TOKENS))
    const database = createIsolatedDatabase(context)
    assert.equal(readSeededMaxOutputTokens(database), EXPLICIT_MAX_OUTPUT_TOKENS)
  })
})

test('seedInitialAiSettings does not rewrite an existing 131072 profile', async (context) => {
  const database = await withOutputTokenEnv(undefined, () => createIsolatedDatabase(context))
  assert.equal(readSeededMaxOutputTokens(database), DEFAULT_CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS)

  database.prepare('UPDATE ai_model_profiles SET max_output_tokens = ?').run(EXISTING_PROFILE_MAX_OUTPUT_TOKENS)
  assert.equal(readSeededMaxOutputTokens(database), EXISTING_PROFILE_MAX_OUTPUT_TOKENS)

  runInImmediateTransaction(database, () => {
    seedInitialAiSettings(database)
  })
  assert.equal(readSeededMaxOutputTokens(database), EXISTING_PROFILE_MAX_OUTPUT_TOKENS)
  assert.equal(
    (database.prepare('SELECT COUNT(*) AS count FROM ai_model_profiles').get() as { count: number }).count,
    1,
  )
})

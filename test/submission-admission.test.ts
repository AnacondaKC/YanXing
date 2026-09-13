import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { AiQueueFullError } from '../lib/ai/queue-policy'
import { PromptBudgetError } from '../lib/ai/prompt-budget'
import { MAX_AI_PROMPT_TEXT_LENGTH } from '../lib/ai/prompt-defaults'
import {
  assertSubmissionTaskAdmission,
  freezeSubmissionTask,
  typeSubmissionTaskSnapshot,
} from '../lib/ai/submission-admission'
import { encryptSecret } from '../lib/db/settings-crypto'
import { seedInitialAiSettings } from '../lib/db/initial-ai-settings'
import { installSubmissionTaskSchema } from '../lib/db/submission-task-schema'
import { SubmissionTaskError } from '../modules/reports/submission-task-domain'
import { createReportUploadTestDatabase } from './helpers/report-upload-database'

const TIMESTAMP = '2026-06-08T12:00:00.000Z'
const PROJECT_ID = 'project'
const ACTOR_ID = 'owner'
const REPORT_ID = 'report-1'
const STAGE_ID = 'stage-1'
const API_KEY = 'sk-test-secret-key'

function createDatabase(context: TestContext) {
  if (!process.env.YANXING_SETTINGS_ENCRYPTION_KEY) {
    process.env.YANXING_SETTINGS_ENCRYPTION_KEY = 'yanxing-test-settings-key'
  }
  const database = createReportUploadTestDatabase()
  context.after(() => database.close())
  seedInitialAiSettings(database)
  installSubmissionTaskSchema(database)
  database.prepare('INSERT INTO project_report_state(project_id) VALUES (?)').run(PROJECT_ID)
  database.prepare('UPDATE projects SET title = ?, objective = ?, description = ? WHERE id = ?').run('测试课题', '研究目标与核心问题', '研究背景与说明', PROJECT_ID)
  insertStage(database, { id: STAGE_ID, ordinal: 1, title: '阶段一', description: '完成测试成果', plannedEndAt: '2026-12-31' })
  insertReport(database, { id: REPORT_ID, stageId: STAGE_ID, sequence: 1, stageVersion: 1 })
  const encrypted = encryptSecret(API_KEY)
  database.prepare('UPDATE ai_model_channels SET api_key_encrypted = ?').run(encrypted)
  return { database, encrypted }
}

function insertStage(database: ReturnType<typeof createReportUploadTestDatabase>, input: {
  id: string
  ordinal: number
  title: string
  description: string | null
  plannedEndAt: string | null
  projectId?: string
}) {
  database.prepare(
    'INSERT INTO project_stages (id, project_id, ordinal, title, description, planned_start_at, planned_end_at, lifecycle_status, started_at, completed_at, completion_reason, current_completion_report_id, next_report_version, state_revision, completion_revision) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, 1, 0, 0)',
  ).run(input.id, input.projectId ?? PROJECT_ID, input.ordinal, input.title, input.description, input.plannedEndAt, 'not_started')
}

function insertReport(database: ReturnType<typeof createReportUploadTestDatabase>, input: {
  id: string
  stageId: string
  sequence: number
  stageVersion: number
  projectId?: string
  actorId?: string
}) {
  database.prepare(
    'INSERT INTO report_submissions (id, project_id, stage_id, stage_version, submission_sequence, submitted_as, title, file_name, source_key, file_hash, source_size, paragraph_count, character_count, submitted_by, submitted_at, was_first_stage_submission) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?, ?)',
  ).run(
    input.id,
    input.projectId ?? PROJECT_ID,
    input.stageId,
    input.stageVersion,
    input.sequence,
    'update',
    '报告 ' + input.id,
    input.id + '.docx',
    'source/' + input.id,
    'hash-' + input.id,
    input.actorId ?? ACTOR_ID,
    TIMESTAMP,
    input.stageVersion === 1 ? 1 : 0,
  )
}

function insertTask(database: ReturnType<typeof createReportUploadTestDatabase>, input: {
  id: string
  reportId: string
  operation: 'analysis' | 'insight'
  generation: number
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  actorId?: string
  projectId?: string
}) {
  const status = input.status ?? 'queued'
  const running = status === 'running'
  database.prepare(
    'INSERT INTO submission_tasks (id, report_id, project_id, actor_id, operation, generation, status, frozen_json, available_at, lease_token, lease_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    input.id,
    input.reportId,
    input.projectId ?? PROJECT_ID,
    input.actorId ?? ACTOR_ID,
    input.operation,
    input.generation,
    status,
    '{}',
    TIMESTAMP,
    running ? 'lease' : null,
    running ? '2099-01-01T00:00:00.000Z' : null,
    TIMESTAMP,
    TIMESTAMP,
  )
}

function admit(database: ReturnType<typeof createReportUploadTestDatabase>, overrides: Partial<Parameters<typeof assertSubmissionTaskAdmission>[0]> = {}) {
  assertSubmissionTaskAdmission({
    database,
    actorId: ACTOR_ID,
    projectId: PROJECT_ID,
    operation: 'analysis',
    reportId: REPORT_ID,
    ...overrides,
  })
}

function withEnv(vars: Record<string, string | undefined>, run: () => void) {
  const previous = new Map<string, string | undefined>()
  for (const key of Object.keys(vars)) previous.set(key, process.env[key])
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try { run() } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function isQueueError(error: unknown) {
  return error instanceof AiQueueFullError
}

test('freezeSubmissionTask freezes stage context, configured prompts, encrypted runtime without token accounting', (context) => {
  const { database, encrypted } = createDatabase(context)
  const frozen = freezeSubmissionTask({ database, reportId: REPORT_ID, operation: 'analysis' })
  assert.equal(frozen.evaluationContext.projectId, PROJECT_ID)
  assert.equal(frozen.evaluationContext.projectTitle, '测试课题')
  assert.equal(frozen.evaluationContext.researchObjective, '研究目标与核心问题')
  assert.equal(frozen.evaluationContext.researchBackground, '研究背景与说明')
  assert.equal(frozen.evaluationContext.milestone.id, STAGE_ID)
  assert.equal(frozen.evaluationContext.milestone.title, '阶段一')
  assert.equal(frozen.evaluationContext.milestone.targetDate, '2026-12-31')
  assert.equal(frozen.evaluationContext.milestone.workAndExpectedOutcomes, '完成测试成果')
  assert.deepEqual(frozen.prompts.map((prompt) => prompt.target), ['page_analysis', 'report_insight'])
  assert.equal(frozen.modelRuntime.target, 'page_analysis')
  assert.equal(frozen.modelRuntime.apiKeyEncrypted, encrypted)
  assert.equal('apiKey' in frozen.modelRuntime, false)
  assert.equal(JSON.stringify(frozen).includes(API_KEY), false)
  assert.equal('estimatedTokens' in frozen, false)
  assert.deepEqual(typeSubmissionTaskSnapshot(frozen), frozen)
})

test('freezeSubmissionTask freezes insight prompts without token estimates', (context) => {
  const { database } = createDatabase(context)
  const frozen = freezeSubmissionTask({ database, reportId: REPORT_ID, operation: 'insight' })
  assert.deepEqual(frozen.prompts.map((prompt) => prompt.target), ['report_insight'])
  assert.equal(frozen.modelRuntime.target, 'report_insight')
  assert.equal('estimatedTokens' in frozen, false)
})

test('freezeSubmissionTask rejects missing, deleted, or incomplete stage context', (context) => {
  const { database } = createDatabase(context)
  assert.throws(() => freezeSubmissionTask({ database, reportId: 'missing', operation: 'analysis' }), (error: unknown) => {
    return error instanceof SubmissionTaskError && error.code === 'REPORT_NOT_FOUND' && error.status === 404
  })
  database.prepare('UPDATE report_submissions SET deleted_at = ?, deleted_by = ?, deletion_reason = ? WHERE id = ?').run(TIMESTAMP, ACTOR_ID, '删除', REPORT_ID)
  assert.throws(() => freezeSubmissionTask({ database, reportId: REPORT_ID, operation: 'analysis' }), (error: unknown) => {
    return error instanceof SubmissionTaskError && error.code === 'REPORT_NOT_FOUND'
  })
})

test('freezeSubmissionTask rejects incomplete stage fields', (context) => {
  const { database } = createDatabase(context)
  insertStage(database, { id: 'stage-2', ordinal: 2, title: '阶段二', description: null, plannedEndAt: '2026-11-01' })
  insertReport(database, { id: 'report-empty-stage', stageId: 'stage-2', sequence: 2, stageVersion: 1 })
  assert.throws(() => freezeSubmissionTask({ database, reportId: 'report-empty-stage', operation: 'analysis' }), (error: unknown) => {
    return error instanceof SubmissionTaskError && error.code === 'PROJECT_CONTEXT_INCOMPLETE'
  })
})

test('freezeSubmissionTask rejects oversized prompts and undersized context', (context) => {
  const { database } = createDatabase(context)
  database.prepare("UPDATE ai_prompt_settings SET instruction_prompt = ? WHERE target = 'page_analysis'").run('超'.repeat(MAX_AI_PROMPT_TEXT_LENGTH + 1))
  assert.throws(() => freezeSubmissionTask({ database, reportId: REPORT_ID, operation: 'analysis' }), /任务提示词不能超过/)
  database.prepare("UPDATE ai_prompt_settings SET instruction_prompt = ? WHERE target = 'page_analysis'").run('任务'.repeat(5_000))
  database.prepare('UPDATE ai_model_profiles SET max_context_characters = 8000').run()
  assert.throws(() => freezeSubmissionTask({ database, reportId: REPORT_ID, operation: 'analysis' }), PromptBudgetError)
})

test('typeSubmissionTaskSnapshot drops plaintext apiKey', () => {
  const snapshot = typeSubmissionTaskSnapshot({
    prompts: [{ target: 'page_analysis', systemPrompt: '系统', instructionPrompt: '任务', version: 1, updatedAt: '', updatedBy: '系统默认' }],
    modelRuntime: {
      target: 'page_analysis',
      channelId: 'channel',
      channelName: '渠道',
      channel: 'chat_completions',
      baseUrl: 'https://example.test/v1',
      apiKey: 'sk-plain',
      apiKeyEncrypted: 'cipher',
      modelId: 'model',
      modelName: 'model',
      maxContextCharacters: 20_000,
      maxOutputTokens: 1024,
      reasoningEffort: 'auto',
      settingsRevision: 1,
    },
    evaluationContext: {
      projectId: PROJECT_ID,
      projectTitle: '课题',
      researchObjective: '目标',
      researchBackground: '背景',
      milestone: { id: STAGE_ID, title: '阶段', targetDate: '2026-12-31', workAndExpectedOutcomes: '成果' },
    },
  })
  assert.ok(snapshot)
  assert.equal('apiKey' in snapshot.modelRuntime, false)
  assert.equal(snapshot.modelRuntime.apiKeyEncrypted, 'cipher')
})

test('assertSubmissionTaskAdmission allows a fresh analysis and insight', (context) => {
  const { database } = createDatabase(context)
  withEnv({ YANXING_AI_DAILY_TOKENS: '1', YANXING_AI_SEVEN_DAY_TOKENS: '1' }, () => {
    admit(database)
    admit(database, { operation: 'insight' })
  })
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('ai_budget_settings', 'submission_task_budgets')").get()?.count, 0)
})

test.describe('submission admission queue limits', { concurrency: false }, () => {
  test('rejects analysis when the global queued-and-running limit is full', (context) => {
    const { database } = createDatabase(context)
    insertStage(database, { id: 'stage-2', ordinal: 2, title: '阶段二', description: '后续成果', plannedEndAt: '2026-11-01' })
    insertReport(database, { id: 'report-2', stageId: 'stage-2', sequence: 2, stageVersion: 1 })
    insertTask(database, { id: 'job-1', reportId: REPORT_ID, operation: 'analysis', generation: 1, status: 'queued' })
    withEnv({ YANXING_AI_GLOBAL_QUEUE_LIMIT: '1' }, () => {
      assert.throws(() => admit(database, { reportId: 'report-2' }), isQueueError)
    })
  })

  test('rejects analysis when the per-user queued-and-running limit is full', (context) => {
    const { database } = createDatabase(context)
    insertTask(database, { id: 'job-1', reportId: REPORT_ID, operation: 'analysis', generation: 1, status: 'queued', actorId: ACTOR_ID })
    insertStage(database, { id: 'stage-2', ordinal: 2, title: '阶段二', description: '后续成果', plannedEndAt: '2026-11-01' })
    insertReport(database, { id: 'report-2', stageId: 'stage-2', sequence: 2, stageVersion: 1 })
    withEnv({ YANXING_AI_USER_QUEUE_LIMIT: '1' }, () => {
      assert.throws(() => admit(database, { reportId: 'report-2' }), isQueueError)
      admit(database, { reportId: 'report-2', actorId: 'editor' })
    })
  })

  test('rejects analysis when the project queued-and-running limit is full', (context) => {
    const { database } = createDatabase(context)
    insertTask(database, { id: 'job-1', reportId: REPORT_ID, operation: 'analysis', generation: 1, status: 'queued' })
    insertStage(database, { id: 'stage-2', ordinal: 2, title: '阶段二', description: '后续成果', plannedEndAt: '2026-11-01' })
    insertReport(database, { id: 'report-2', stageId: 'stage-2', sequence: 2, stageVersion: 1 })
    withEnv({ YANXING_AI_PROJECT_QUEUE_LIMIT: '1' }, () => {
      assert.throws(() => admit(database, { reportId: 'report-2' }), isQueueError)
    })
  })

  test('rejects insight when queued insight tasks fill the queue', (context) => {
    const { database } = createDatabase(context)
    insertStage(database, { id: 'stage-2', ordinal: 2, title: '阶段二', description: '后续成果', plannedEndAt: '2026-11-01' })
    insertReport(database, { id: 'report-2', stageId: 'stage-2', sequence: 2, stageVersion: 1 })
    insertTask(database, { id: 'job-queued', reportId: 'report-2', operation: 'insight', generation: 1, status: 'queued' })
    withEnv({ YANXING_AI_INSIGHT_QUEUE_LIMIT: '1' }, () => {
      assert.throws(() => admit(database, { operation: 'insight' }), isQueueError)
      admit(database)
    })
  })

  for (const operation of ['analysis', 'insight'] as const) {
    test(`counts running ${operation} tasks against the queue`, (context) => {
      const { database } = createDatabase(context)
      insertTask(database, { id: 'job-running', reportId: REPORT_ID, operation, generation: 1, status: 'running' })
      withEnv({ YANXING_AI_GLOBAL_QUEUE_LIMIT: '1', YANXING_AI_INSIGHT_QUEUE_LIMIT: '1' }, () => {
        assert.throws(() => admit(database, { operation }), isQueueError)
      })
    })

    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      test(`does not count ${status} ${operation} tasks against the queue`, (context) => {
        const { database } = createDatabase(context)
        insertTask(database, { id: 'job-terminal', reportId: REPORT_ID, operation, generation: 1, status })
        withEnv({ YANXING_AI_GLOBAL_QUEUE_LIMIT: '1', YANXING_AI_USER_QUEUE_LIMIT: '1', YANXING_AI_PROJECT_QUEUE_LIMIT: '1', YANXING_AI_INSIGHT_QUEUE_LIMIT: '1' }, () => {
          admit(database, { operation })
        })
      })
    }
  }

})

test('assertSubmissionTaskAdmission rejects missing actor and report', (context) => {
  const { database } = createDatabase(context)
  assert.throws(() => admit(database, { actorId: '' }), (error: unknown) => error instanceof SubmissionTaskError && error.code === 'UNAUTHENTICATED' && error.status === 401)
  assert.throws(() => admit(database, { reportId: 'missing' }), (error: unknown) => error instanceof SubmissionTaskError && error.code === 'REPORT_NOT_FOUND')
})

test('freezeSubmissionTask fails closed without a configured encryption key and does not decrypt via default storage', (context) => {
  const { database } = createDatabase(context)
  withEnv({ YANXING_SETTINGS_ENCRYPTION_KEY: undefined }, () => {
    assert.throws(
      () => freezeSubmissionTask({ database, reportId: REPORT_ID, operation: 'analysis' }),
      (error: unknown) => error instanceof SubmissionTaskError && error.code === 'SETTINGS_ENCRYPTION_KEY_MISSING' && error.status === 503,
    )
  })
})

test('freezeSubmissionTask fails closed when the configured key cannot decrypt the stored ciphertext', (context) => {
  const { database } = createDatabase(context)
  withEnv({ YANXING_SETTINGS_ENCRYPTION_KEY: 'unrelated-wrong-key' }, () => {
    assert.throws(
      () => freezeSubmissionTask({ database, reportId: REPORT_ID, operation: 'analysis' }),
      /无法解密/,
    )
  })
})

test('freezeSubmissionTask rejects a missing API key ciphertext before enqueue', (context) => {
  const { database } = createDatabase(context)
  database.prepare('UPDATE ai_model_channels SET api_key_encrypted = NULL').run()
  assert.throws(
    () => freezeSubmissionTask({ database, reportId: REPORT_ID, operation: 'analysis' }),
    /尚未配置 API 密钥/,
  )
  database.prepare("UPDATE ai_model_channels SET api_key_encrypted = ''").run()
  assert.throws(
    () => freezeSubmissionTask({ database, reportId: REPORT_ID, operation: 'insight' }),
    /尚未配置 API 密钥/,
  )
})

test('freezeSubmissionTask rejects a missing model assignment', (context) => {
  const { database } = createDatabase(context)
  database.prepare('UPDATE ai_model_assignments SET model_id = NULL').run()
  assert.throws(() => freezeSubmissionTask({ database, reportId: REPORT_ID, operation: 'analysis' }), /分析页尚未选择模型/)
  assert.throws(() => freezeSubmissionTask({ database, reportId: REPORT_ID, operation: 'insight' }), /报告洞察尚未选择模型/)
})


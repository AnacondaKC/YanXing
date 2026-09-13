import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { encryptSecret } from '../../lib/db/settings-crypto'
import { ensureNativeDatabase } from '../../lib/db/native-schema'

export const BACKUP_FIXTURE_KEY = 'yanxing-native-backup-fixture-key-v1'
export const BACKUP_FIXTURE_API_SECRET = 'sk-backup-fixture-not-a-real-key'
export const BACKUP_FIXTURE_TIMESTAMP = '2026-01-02T03:04:05.000Z'

const LIVE_REPORT_BODY = 'live-report-body'
const TOMBSTONE_REPORT_BODY = 'tombstone-report-body'
const KNOWLEDGE_BODY = 'knowledge-item-body'
const BRANDING_BODY = 'brand-logo-bytes'

export async function createNativeBackupFixture() {
  const previousKey = process.env.YANXING_SETTINGS_ENCRYPTION_KEY
  const previousKnowledge = process.env.YANXING_KNOWLEDGE_STORAGE_ROOT
  process.env.YANXING_SETTINGS_ENCRYPTION_KEY = BACKUP_FIXTURE_KEY
  delete process.env.YANXING_KNOWLEDGE_STORAGE_ROOT

  const root = await mkdtemp(join(tmpdir(), 'yanxing-native-backup-'))
  const runtimeRoot = join(root, 'runtime')
  const databasePath = join(runtimeRoot, 'yanxing.sqlite')
  const storageRoot = join(runtimeRoot, 'reports')
  const knowledgeRoot = join(runtimeRoot, 'knowledge')
  const brandingRoot = join(runtimeRoot, 'branding')
  const temporaryRoot = join(runtimeRoot, 'tmp')
  await mkdir(storageRoot, { recursive: true })
  await mkdir(knowledgeRoot, { recursive: true })
  await mkdir(brandingRoot, { recursive: true })
  await mkdir(temporaryRoot, { recursive: true })

  const database = new DatabaseSync(databasePath, { timeout: 5000 })
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000')
  ensureNativeDatabase({ database, storageRoot })
  database.exec('PRAGMA journal_mode = WAL')

  const liveSourceKey = 'live/live.docx'
  const tombstoneSourceKey = 'tombstone/tombstone.docx'
  const knowledgeRelativePath = 'item/item.pdf'
  const livePath = join(storageRoot, liveSourceKey)
  const tombstonePath = join(storageRoot, tombstoneSourceKey)
  const knowledgePath = join(knowledgeRoot, knowledgeRelativePath)
  const brandingPath = join(brandingRoot, 'logo.bin')
  const tmpPath = join(temporaryRoot, 'scratch.bin')
  await mkdir(join(storageRoot, 'live'), { recursive: true })
  await mkdir(join(storageRoot, 'tombstone'), { recursive: true })
  await mkdir(join(knowledgeRoot, 'item'), { recursive: true })
  await writeFile(livePath, LIVE_REPORT_BODY)
  await writeFile(tombstonePath, TOMBSTONE_REPORT_BODY)
  await writeFile(knowledgePath, KNOWLEDGE_BODY)
  await writeFile(brandingPath, BRANDING_BODY)
  await writeFile(tmpPath, 'temporary-should-not-be-archived')

  seedUsersAndProject(database)
  const encryptedApiKey = encryptSecret(BACKUP_FIXTURE_API_SECRET)
  database.prepare('UPDATE ai_model_channels SET api_key_encrypted = ?').run(encryptedApiKey)
  seedReports(database, { liveSourceKey, tombstoneSourceKey })
  seedKnowledge(database, knowledgePath)
  seedQuota(database, { livePath, tombstonePath, knowledgePath })
  seedAuditAndTask(database, encryptedApiKey)
  database.prepare('UPDATE brand_settings SET header_logo = ?, header_logo_mime = ? WHERE id = 1').run(Buffer.from(BRANDING_BODY), 'image/png')

  return {
    root,
    runtimeRoot,
    databasePath,
    storageRoot,
    knowledgeRoot,
    brandingRoot,
    temporaryRoot,
    database,
    encryptedApiKey,
    livePath,
    tombstonePath,
    knowledgePath,
    brandingPath,
    tmpPath,
    liveSourceKey,
    tombstoneSourceKey,
    async dispose() {
      try { database.close() } catch { /* already closed for restore tests */ }
      await rm(root, { recursive: true, force: true })
      restoreEnv('YANXING_SETTINGS_ENCRYPTION_KEY', previousKey)
      restoreEnv('YANXING_KNOWLEDGE_STORAGE_ROOT', previousKnowledge)
    },
  }
}

function seedUsersAndProject(database: DatabaseSync) {
  const at = BACKUP_FIXTURE_TIMESTAMP
  database.prepare('INSERT INTO users(id, username, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('submitter', 'submitter', '提交人', 'hash', 'researcher', at, at)
  database.prepare('INSERT INTO users(id, username, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('owner', 'owner', '课题负责人', 'hash', 'researcher', at, at)
  database.prepare('INSERT INTO projects(id, title, objective, owner_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('project-native', '原生课题', '目标', '课题负责人', at, at)
  database.prepare('INSERT INTO project_members(project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run('project-native', 'owner', 'owner', at)
  database.prepare('INSERT INTO project_members(project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run('project-native', 'submitter', 'editor', at)
  database.prepare('INSERT INTO project_report_state(project_id, plan_revision, workflow_revision, next_submission_sequence) VALUES (?, ?, ?, ?)').run('project-native', 0, 0, 3)
  database.prepare('INSERT INTO project_stages(id, project_id, ordinal, title, lifecycle_status, started_at, next_report_version, state_revision, completion_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('stage-1', 'project-native', 1, '研究阶段', 'in_progress', at, 3, 0, 0)
}

function seedReports(database: DatabaseSync, input: {
  liveSourceKey: string
  tombstoneSourceKey: string
}) {
  insertReport(database, {
    id: 'report-tombstone',
    sourceKey: input.tombstoneSourceKey,
    fileName: 'tombstone.docx',
    title: '墓碑报告',
    body: TOMBSTONE_REPORT_BODY,
    stageVersion: 1,
    sequence: 1,
    first: 1,
    submittedAs: 'update',
    deletedAt: '2026-01-02T04:00:00.000Z',
  })
  insertReport(database, {
    id: 'report-live',
    sourceKey: input.liveSourceKey,
    fileName: 'live.docx',
    title: '正式报告',
    body: LIVE_REPORT_BODY,
    stageVersion: 2,
    sequence: 2,
    first: 0,
    submittedAs: 'update',
    deletedAt: null,
  })
}

function insertReport(database: DatabaseSync, input: {
  id: string
  sourceKey: string
  fileName: string
  title: string
  body: string
  stageVersion: number
  sequence: number
  first: number
  submittedAs: string
  deletedAt: string | null
}) {
  const at = BACKUP_FIXTURE_TIMESTAMP
  database.prepare(`
    INSERT INTO report_submissions(
      id, project_id, stage_id, stage_version, submission_sequence, submitted_as, title, file_name, source_key, file_hash, source_size, paragraph_count, character_count, submitted_by, submitted_at, was_first_stage_submission, deleted_at, deleted_by, deletion_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id, 'project-native', 'stage-1', input.stageVersion, input.sequence, input.submittedAs, input.title, input.fileName, input.sourceKey,
    sha256(input.body), Buffer.byteLength(input.body), 1, input.body.length, 'submitter', at, input.first,
    input.deletedAt, input.deletedAt ? 'owner' : null, input.deletedAt ? '逻辑删除保留文件' : null,
  )
  database.prepare('INSERT INTO report_submission_documents(report_id, text, mime_type) VALUES (?, ?, ?)').run(
    input.id, input.body, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  )
}

function seedKnowledge(database: DatabaseSync, knowledgePath: string) {
  const at = BACKUP_FIXTURE_TIMESTAMP
  database.prepare(`
    INSERT INTO knowledge_items(id, title, file_name, file_size, source_path, file_hash, uploaded_by, uploaded_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('knowledge-1', '知识条目', 'item.pdf', Buffer.byteLength(KNOWLEDGE_BODY), knowledgePath, sha256(KNOWLEDGE_BODY), 'submitter', 'submitter', at, at)
}

function seedQuota(database: DatabaseSync, input: { livePath: string; tombstonePath: string; knowledgePath: string }) {
  const at = BACKUP_FIXTURE_TIMESTAMP
  insertAllocation(database, { ownerType: 'report', ownerId: 'report-live', sourcePath: input.livePath, sizeBytes: Buffer.byteLength(LIVE_REPORT_BODY) })
  insertAllocation(database, { ownerType: 'report', ownerId: 'report-tombstone', sourcePath: input.tombstonePath, sizeBytes: Buffer.byteLength(TOMBSTONE_REPORT_BODY) })
  insertAllocation(database, { ownerType: 'knowledge', ownerId: 'knowledge-1', sourcePath: input.knowledgePath, sizeBytes: Buffer.byteLength(KNOWLEDGE_BODY) })
  const used = Buffer.byteLength(LIVE_REPORT_BODY) + Buffer.byteLength(TOMBSTONE_REPORT_BODY) + Buffer.byteLength(KNOWLEDGE_BODY)
  database.prepare('INSERT INTO storage_usage(scope_type, scope_id, used_bytes, item_count, reserved_bytes, reserved_count, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('global', 'global', used, 3, 0, 0, 1, at)
  database.prepare('INSERT INTO storage_usage(scope_type, scope_id, used_bytes, item_count, reserved_bytes, reserved_count, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('user', 'submitter', used, 3, 0, 0, 1, at)
}

function insertAllocation(database: DatabaseSync, input: { ownerType: string; ownerId: string; sourcePath: string; sizeBytes: number }) {
  const at = BACKUP_FIXTURE_TIMESTAMP
  database.prepare(`
    INSERT INTO storage_allocations(owner_type, owner_id, user_id, project_id, size_bytes, file_hash, source_path, mime_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.ownerType, input.ownerId, 'submitter', 'project-native', input.sizeBytes, 'hash-' + input.ownerId, input.sourcePath, 'application/octet-stream', at, at)
}

function seedAuditAndTask(database: DatabaseSync, encryptedApiKey: string) {
  const at = BACKUP_FIXTURE_TIMESTAMP
  database.prepare('INSERT INTO report_submission_audit(id, project_id, report_id, actor_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'audit-1', 'project-native', 'report-live', 'submitter', 'submitted', '{"ok":true}', at,
  )
  const frozenJson = JSON.stringify({
    prompts: [{ target: 'page_analysis', systemPrompt: 's', instructionPrompt: 'i', version: 1 }],
    modelRuntime: {
      target: 'page_analysis',
      channelId: 'channel',
      channelName: 'test',
      channel: 'chat_completions',
      baseUrl: 'https://example.test/v1',
      modelId: 'model',
      modelName: 'test-model',
      maxContextCharacters: 100000,
      maxOutputTokens: 16000,
      reasoningEffort: 'medium',
      apiKeyEncrypted: encryptedApiKey,
      settingsRevision: 1,
    },
    evaluationContext: { projectId: 'project-native' },
  })
  database.prepare(`
    INSERT INTO submission_tasks(id, report_id, project_id, actor_id, operation, generation, status, stage, frozen_json, attempts, cancel_requested, available_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'analysis', 1, 'queued', 'validating', ?, 0, 0, ?, ?, ?)
  `).run('task-1', 'report-live', 'project-native', 'submitter', frozenJson, at, at, at)
  database.prepare("UPDATE submission_tasks SET status = 'running', stage = 'generating', lease_token = ?, lease_until = ?, attempts = 1, updated_at = ? WHERE id = ?").run('lease-1', '2099-01-01T00:00:00.000Z', at, 'task-1')
  database.prepare("INSERT INTO submission_task_calls(job_id, attempt, provider, model, lease_token, state, started_at) VALUES (?, 1, 'chat_completions', 'test-model', 'lease-1', 'started', ?)").run('task-1', at)
  database.prepare("UPDATE submission_task_calls SET state = 'completed', completed_at = ? WHERE job_id = ?").run(at, 'task-1')
  database.prepare('INSERT INTO submission_task_results(id, job_id, report_id, operation, generation, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'result-1', 'task-1', 'report-live', 'analysis', 1, '{"html":"<p>ok</p>"}', at,
  )
  database.prepare("UPDATE submission_tasks SET status = 'completed', lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ?").run(at, 'task-1')
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

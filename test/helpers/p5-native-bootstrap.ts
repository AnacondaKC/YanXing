import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { ensureNativeDatabase } from '../../lib/db/native-schema'
import { createReportSubmissionRuntime } from '../../lib/reports/submission-runtime'

export interface P5BootstrapConfig {
  databasePath: string
  storageRoot: string
  ownerUsername: string
}

export interface P5NativeIdentity {
  ownerId: string
  projectId: string
  stageId: string
  planRevision: number
  workflowRevision: number
  completionRevision: number
}

const SQLITE_BUSY_TIMEOUT_MS = 10_000

export function bootstrapP5NativeDatabase(config: P5BootstrapConfig): P5NativeIdentity {
  mkdirSync(dirname(config.databasePath), { recursive: true })
  mkdirSync(config.storageRoot, { recursive: true })
  const database = new DatabaseSync(config.databasePath, { timeout: SQLITE_BUSY_TIMEOUT_MS })
  try {
    database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=' + SQLITE_BUSY_TIMEOUT_MS)
    ensureNativeDatabase({ database, storageRoot: config.storageRoot })
    database.exec('PRAGMA journal_mode=WAL')
    const ownerId = randomUUID()
    const createdAt = new Date().toISOString()
    database.prepare(
      'INSERT INTO users(id, username, display_name, password_hash, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(ownerId, config.ownerUsername, 'P5负责人', 'p5-not-a-login-hash', 'researcher', 'active', createdAt, createdAt)
    const runtime = createReportSubmissionRuntime({
      database,
      storageRoot: config.storageRoot,
      resolveActorId: () => ownerId,
    })
    const workflow = runtime.repository.createProject({
      actorId: ownerId,
      project: {
        title: 'P5故障验收课题',
        objective: '验证原生确认、进程死亡与并发不变量',
        description: '研究背景覆盖证据、风险与可执行建议，供冻结评价上下文使用。',
        ownerId,
        stages: [{
          id: randomUUID(),
          title: '研究阶段',
          description: '形成完整研究成果并评估风险与建议',
          plannedEndAt: '2030-12-31',
        }],
      },
    })
    const stage = workflow.stages[0]
    if (!stage) throw new Error('native bootstrap created a project without stages')
    return {
      ownerId,
      projectId: workflow.projectId,
      stageId: stage.id,
      planRevision: workflow.planRevision,
      workflowRevision: workflow.workflowRevision,
      completionRevision: stage.completionRevision,
    }
  } finally {
    database.close()
  }
}

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
}

if (isMainModule()) {
  const config = JSON.parse(process.argv[2] ?? '') as P5BootstrapConfig
  process.stdout.write(JSON.stringify(bootstrapP5NativeDatabase(config)) + String.fromCharCode(10))
}

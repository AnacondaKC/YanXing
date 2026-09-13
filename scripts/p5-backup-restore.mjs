import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const projectRootFromScript = fileURLToPath(new URL('../', import.meta.url))
export const NOT_QUIESCENT_MESSAGE = '存在活动任务、未完成上传或配额预留，拒绝在线备份；请停止 Web/Worker 后再试。'
export const RESTORE_INCOMPLETE_MARKER_PREFIX = '.yanxing-restore-incomplete-'
const BACKUP_CLI_TIMEOUT_MS = 60_000

export function backupLayoutFromIsolated(isolated) {
  const databasePath = isolated.databasePath
  const runtimeRoot = isolated.runtimeRoot ?? path.dirname(databasePath)
  const storageRoot = isolated.storageRoot ?? path.join(runtimeRoot, 'reports')
  return { databasePath, runtimeRoot, storageRoot }
}

export function resolveBackupCli({ artifacts, projectRoot = projectRootFromScript } = {}) {
  const compiled = artifacts?.runtimeRoot ? path.join(artifacts.runtimeRoot, 'scripts/native-backup.mjs') : ''
  if (compiled && existsSync(compiled) && statSync(compiled).isFile()) {
    return {
      kind: 'compiled',
      command: process.execPath,
      argsPrefix: [compiled],
      script: compiled,
      cwd: artifacts.workerCwd ?? path.dirname(artifacts.runtimeRoot),
    }
  }
  const source = path.join(projectRoot, 'scripts/native-backup.ts')
  if (existsSync(source) && statSync(source).isFile()) {
    return {
      kind: 'tsx-source',
      command: process.execPath,
      argsPrefix: ['--import', 'tsx', source],
      script: source,
      cwd: projectRoot,
    }
  }
  const error = new Error('找不到 native-backup CLI。需要 --with-backup-restore 时，候选 .runtime/scripts/native-backup.mjs 或仓库 scripts/native-backup.ts + tsx。')
  error.code = 'BACKUP_CLI_MISSING'
  throw error
}

export function classifyNativeBackupFailure(output) {
  const text = String(output ?? '')
  if (text.includes('NOT_QUIESCENT') || text.includes('存在活动任务、未完成上传或配额预留')) return 'NOT_QUIESCENT'
  if (text.includes('RESTORE_INCOMPLETE') || text.includes('未完成的原生恢复')) return 'RESTORE_INCOMPLETE'
  if (text.includes('KEY_REQUIRED') || text.includes('不会读取隐式')) return 'KEY_REQUIRED'
  return null
}

export function parseBackupCliJson(stdout) {
  const text = String(stdout ?? '').trim()
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

function countSql(database, sql) {
  const row = database.prepare(sql).get()
  const n = Number(row?.n ?? 0)
  return Number.isSafeInteger(n) ? n : 0
}

export function inspectIsolatedQuiescence(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return {
      activeTasks: countSql(database, "SELECT COUNT(*) AS n FROM submission_tasks WHERE status IN ('queued','running')"),
      activeUploads: countSql(database, "SELECT COUNT(*) AS n FROM report_uploads WHERE status IN ('receiving','parsing','ready','reclaiming')"),
      activeReservations: countSql(database, "SELECT COUNT(*) AS n FROM storage_reservations WHERE state = 'active'"),
    }
  } finally {
    database.close()
  }
}

export function readPublishedRestoreProbe(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const identity = database.prepare('SELECT name, checksum, initialized_at FROM native_schema_identity LIMIT 1').get()
    const calls = database.prepare('SELECT job_id, attempt, provider, model, lease_token, state, started_at, completed_at FROM submission_task_calls ORDER BY job_id, attempt').all()
    const tasks = database.prepare('SELECT id, report_id, operation, generation, status, error_code FROM submission_tasks ORDER BY id').all()
    const reports = database.prepare('SELECT id FROM report_submissions ORDER BY id').all()
    return {
      identity: identity
        ? { name: identity.name, checksum: identity.checksum, initializedAt: identity.initialized_at }
        : null,
      calls,
      tasks,
      reportIds: reports.map((row) => row.id),
    }
  } finally {
    database.close()
  }
}

export function summarizeTaskProbe(probe) {
  return {
    taskCount: probe.tasks.length,
    callCount: probe.calls.length,
    incompleteCallCount: probe.calls.filter((row) => row.state === 'started').length,
  }
}

export function assertTaskProbePreserved(before, after) {
  for (const field of ['tasks', 'calls']) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      throw new Error('恢复后任务或模型调用状态不匹配：' + field)
    }
  }
}

export function restoreIncompleteMarkerPath(runtimeRoot) {
  if (typeof runtimeRoot !== 'string' || !runtimeRoot.trim() || !path.isAbsolute(runtimeRoot)) {
    throw new Error('restore marker 需要绝对运行根')
  }
  const absoluteRoot = path.resolve(runtimeRoot)
  const identity = createHash('sha256').update(absoluteRoot).digest('hex')
  return path.join(path.dirname(absoluteRoot), RESTORE_INCOMPLETE_MARKER_PREFIX + identity)
}

export function buildNativeBackupCliArgs(action, layout, archivePath) {
  if (action === 'backup') {
    return ['--database', layout.databasePath, '--storage-root', layout.storageRoot, '--destination', archivePath]
  }
  if (action === 'restore') {
    return ['--archive', archivePath, '--database', layout.databasePath, '--storage-root', layout.storageRoot]
  }
  throw new Error('unknown native-backup action: ' + action)
}

export function assertRestoreCompleted(runtimeRoot) {
  const markerPath = restoreIncompleteMarkerPath(runtimeRoot)
  if (existsSync(markerPath)) {
    const error = new Error('RESTORE_INCOMPLETE：恢复标记仍在 ' + markerPath + '，拒绝启动服务，也不会自动删除该标记。')
    error.code = 'RESTORE_INCOMPLETE'
    throw error
  }
  return markerPath
}

export async function preserveRuntimeRootAside(runtimeRoot) {
  const preserved = runtimeRoot + '-pre-restore'
  if (existsSync(preserved)) throw new Error('预留路径已存在，拒绝覆盖：' + preserved)
  await rename(runtimeRoot, preserved)
  if (existsSync(runtimeRoot)) throw new Error('重命名后原运行根仍存在：' + runtimeRoot)
  return preserved
}

export async function restorePreservedRuntimeRoot(runtimeRoot, preservedRuntimeRoot) {
  if (existsSync(runtimeRoot) || !existsSync(preservedRuntimeRoot)) return false
  await rename(preservedRuntimeRoot, runtimeRoot)
  return true
}

async function waitForPidDead(isPidAlive, pid, delay, { timeoutMs = 8_000, pollMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) throw new Error('进程 ' + pid + ' 仍未退出')
    await delay(pollMs)
  }
}

export async function stopOwnedServices({ web, worker, children, webPort, killTree, isPidAlive, delay, waitForLoopbackPortFree }) {
  const records = [web, worker].filter(Boolean)
  for (const record of records) killTree(record.child, 'SIGTERM')
  for (const record of records) {
    const finished = await Promise.race([record.completion.catch(() => {}), delay(4_000).then(() => 'timeout')])
    const pid = record.pid ?? record.child?.pid
    if (finished === 'timeout' && isPidAlive(pid)) {
      killTree(record.child, 'SIGKILL')
      await record.completion.catch(() => {})
    }
    children.delete(record)
    if (pid) await waitForPidDead(isPidAlive, pid, delay)
  }
  if (webPort) await waitForLoopbackPortFree(webPort)
}

export async function runNativeBackupCommand({ cli, action, args, env, secrets, runForegroundCommand, timeoutMs = BACKUP_CLI_TIMEOUT_MS }) {
  try {
    return await runForegroundCommand({
      command: cli.command,
      args: [...cli.argsPrefix, action, ...args],
      cwd: cli.cwd,
      env,
      secrets,
      timeoutMs,
      label: 'native-backup ' + action,
    })
  } catch (error) {
    const output = error instanceof Error ? error.message : String(error)
    const code = classifyNativeBackupFailure(output)
    if (code === 'NOT_QUIESCENT') {
      const wrapped = new Error('native-backup 拒绝：NOT_QUIESCENT。' + NOT_QUIESCENT_MESSAGE + ' 不会伪造过期。')
      wrapped.code = 'NOT_QUIESCENT'
      throw wrapped
    }
    if (code === 'RESTORE_INCOMPLETE') {
      const wrapped = new Error('native-backup 拒绝：RESTORE_INCOMPLETE。未完成恢复标记由操作者核对后手动清除，本验收不会自动删除。')
      wrapped.code = 'RESTORE_INCOMPLETE'
      throw wrapped
    }
    throw error
  }
}

export async function verifyRestoredPublishedReports({ client, reports }) {
  const verified = []
  for (const report of reports) {
    const detail = await client.readJson('GET', '/api/reports/' + report.id)
    const insightView = await client.readJson('GET', '/api/reports/' + report.id + '/insight')
    const file = await client.readBuffer('GET', '/api/reports/' + report.id + '/file?download=1')
    if (!detail?.snapshot) throw new Error('恢复后报告 ' + report.id + ' 缺少分析快照。')
    const html = insightView?.html ?? detail?.insight?.html
    if (!html) throw new Error('恢复后报告 ' + report.id + ' 缺少洞察 HTML。')
    if (!file?.byteLength) throw new Error('恢复后报告 ' + report.id + ' 文件为空。')
    verified.push({
      id: report.id,
      kind: report.kind,
      hasSnapshot: true,
      hasInsightHtml: true,
      fileBytes: file.byteLength,
      aiScore: detail.snapshot?.overall ?? detail.aiScore ?? report.aiScore ?? null,
    })
  }
  return verified
}

export async function runNativeBackupRestoreDrill({
  artifacts,
  isolated,
  env,
  secrets,
  children,
  web,
  worker,
  client,
  success,
  logs,
  projectRoot = projectRootFromScript,
  timeoutMs = BACKUP_CLI_TIMEOUT_MS,
  deps,
}) {
  if (!success?.reports?.length) throw new Error('没有成功路径的已发布报告，无法做 backup/restore 验收。')
  const cli = resolveBackupCli({ artifacts, projectRoot })
  const layout = backupLayoutFromIsolated(isolated)
  const archivePath = path.join(isolated.root, 'native-backup-archive')
  await stopOwnedServices({
    web,
    worker,
    children,
    webPort: isolated.webPort,
    killTree: deps.killTree,
    isPidAlive: deps.isPidAlive,
    delay: deps.delay,
    waitForLoopbackPortFree: deps.waitForLoopbackPortFree,
  })
  await deps.delay(200)
  const quiescence = inspectIsolatedQuiescence(layout.databasePath)
  const before = readPublishedRestoreProbe(layout.databasePath)
  let backup
  try {
    backup = await runNativeBackupCommand({
      cli,
      action: 'backup',
      args: buildNativeBackupCliArgs('backup', layout, archivePath),
      env,
      secrets,
      runForegroundCommand: deps.runForegroundCommand,
      timeoutMs,
    })
  } catch (error) {
    if (error && error.code === 'NOT_QUIESCENT') {
      const wrapped = new Error(error.message + ' quiescence=' + JSON.stringify(quiescence))
      wrapped.code = 'NOT_QUIESCENT'
      throw wrapped
    }
    throw error
  }
  const backupJson = parseBackupCliJson(backup.stdout)
  const preservedRuntimeRoot = await preserveRuntimeRootAside(layout.runtimeRoot)
  try {
    const restore = await runNativeBackupCommand({
      cli,
      action: 'restore',
      args: buildNativeBackupCliArgs('restore', layout, archivePath),
      env,
      secrets,
      runForegroundCommand: deps.runForegroundCommand,
      timeoutMs,
    })
    const restoreJson = parseBackupCliJson(restore.stdout)
    const incompleteMarkerPath = assertRestoreCompleted(layout.runtimeRoot)
    const after = readPublishedRestoreProbe(layout.databasePath)
    assertTaskProbePreserved(before, after)
    if (before.identity?.checksum !== after.identity?.checksum) {
      throw new Error('恢复后 schema checksum 变化。')
    }
    await rm(isolated.readyPath, { force: true })
    await rm(isolated.heartbeatPath, { force: true })
    const restartedWorker = deps.spawnService({ name: 'worker', artifacts, isolated, env, children, logs, secrets })
    const restartedWeb = deps.spawnService({ name: 'web', artifacts, isolated, env, children, logs, secrets })
    await deps.waitForWebHealth('http://127.0.0.1:' + isolated.webPort, { child: restartedWeb.child })
    await deps.waitForWorkerReady({ readyPath: isolated.readyPath, instanceToken: isolated.instanceToken, child: restartedWorker.child })
    await deps.waitForWorkerHeartbeat(isolated.heartbeatPath, { child: restartedWorker.child })
    await client.login({ username: isolated.username, password: isolated.adminPassword })
    const verified = await verifyRestoredPublishedReports({ client, reports: success.reports })
    return {
      ok: true,
      cli: { kind: cli.kind, script: cli.script },
      servicesStopped: true,
      servicesRestarted: true,
      archivePath,
      preservedRuntimeRoot,
      restoredDatabasePath: layout.databasePath,
      restoredStorageRoot: layout.storageRoot,
      incompleteMarkerPath,
      incompleteMarkerPresent: false,
      quiescence,
      backup: {
        action: backupJson?.action ?? 'backup',
        identity: backupJson?.identity ?? after.identity,
        counts: backupJson?.counts ?? null,
        hasEncryptedSecrets: backupJson?.hasEncryptedSecrets ?? null,
        authenticationMode: backupJson?.authenticationMode ?? null,
      },
      restore: {
        action: restoreJson?.action ?? 'restore',
        identity: restoreJson?.identity ?? after.identity,
        counts: restoreJson?.counts ?? null,
      },
      taskState: {
        before: summarizeTaskProbe(before),
        after: summarizeTaskProbe(after),
        preserved: true,
      },
      reports: verified,
      workerPid: restartedWorker.pid,
      webPid: restartedWeb.pid,
    }
  } catch (error) {
    const originalRestored = await restorePreservedRuntimeRoot(layout.runtimeRoot, preservedRuntimeRoot)
    if (!originalRestored && existsSync(preservedRuntimeRoot)) {
      throw new Error(
        (error instanceof Error ? error.message : '备份恢复演练失败。')
          + ' 原运行根保留在：' + preservedRuntimeRoot,
        { cause: error },
      )
    }
    throw error
  }
}


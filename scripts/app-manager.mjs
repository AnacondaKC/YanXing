import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmdirSync, statSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadYanXingEnv, resolveStartupMode } from '../lib/config/load-env.mjs'

const projectRoot = process.cwd()
const managerScriptPath = fileURLToPath(import.meta.url)
const storageDirectory = path.join(projectRoot, 'storage')
const statePath = path.join(storageDirectory, '.yanxing-app.json')
const lockPath = path.join(storageDirectory, '.yanxing-app.lock')
const logDirectory = path.join(storageDirectory, 'logs')
const webLogPath = path.join(logDirectory, 'web.log')
const workerLogPath = path.join(logDirectory, 'worker.log')
const defaultMode = 'development'
const supportedCommands = new Set(['start', 'stop', 'restart', 'status'])

let webPort = '3000'
let logMaxBytes = 10 * 1024 * 1024
let logArchiveRetentionDays = 14
let tempRetentionDays = 7
let startTimeoutMs = 30_000
let stopTimeoutMs = 8_000
const rotateLockPath = path.join(storageDirectory, '.yanxing-log-rotate.lock')

function runLogWatchdog() {
  const checkIntervalMs = parsePositiveInteger(process.env.YANXING_LOG_WATCH_INTERVAL_MS, 30 * 60 * 1000)
  const instanceToken = process.env.YANXING_INSTANCE_TOKEN
  const tick = () => {
    try {
      const state = readState()
      if (instanceToken && state?.instanceToken && state.instanceToken !== instanceToken) {
        clearInterval(timer)
        return
      }
      const alive = state ? getManagedProcesses(state) : []
      if (!alive.length && !findProjectProcesses().length) {
        clearInterval(timer)
        return
      }
      withRotateLock(() => {
        rotateRunningLogIfNeeded(webLogPath)
        rotateRunningLogIfNeeded(workerLogPath)
      })
      purgeExpiredLogArchives()
    } catch {
      // Watchdog is best effort; a failing pass retries on the next tick.
    }
  }
  // 定时器必须保持 ref：unref 后该进程没有其它 handle，会立刻退出，运行期日志永不轮转。
  const timer = setInterval(tick, checkIntervalMs)
  tick()
}

/** copytruncate 变体：服务进程持有打开的日志 fd，不能 rename，只能复制后截断。 */
function rotateRunningLogIfNeeded(logPath) {
  try {
    if (!existsSync(logPath) || statSync(logPath).size < logMaxBytes) return
    const archivePath = createArchivePath(logPath)
    copyFileSync(logPath, archivePath)
    truncateSync(logPath)
  } catch (error) {
    console.warn(`[yanxing] 无法轮转日志 ${path.basename(logPath)}：${error instanceof Error ? error.message : String(error)}`)
  }
}

function createInstanceToken() {
  return Date.now().toString(16) + Math.random().toString(16).slice(2)
}

function workerReadyPath(instanceToken) {
  return path.join(storageDirectory, '.yanxing-worker-ready-' + instanceToken)
}

function startApp(mode) {
  const existingState = readState()
  const instanceToken = existingState?.instanceToken ?? createInstanceToken()
  const health = inspectServiceHealth(existingState, instanceToken)
  if (health.web.healthy && health.worker.healthy) {
    printProcessSummary('应用已经在运行', [health.web.process, health.worker.process].filter(Boolean))
    return
  }

  if (!health.web.healthy && !health.worker.healthy) runDatabaseMigration(mode)
  applyStartupRetention()
  stopWatchdog(existingState)

  const startedThisTime = []
  const state = {
    mode,
    startedAt: existingState?.startedAt ?? new Date().toISOString(),
    instanceToken,
    processes: { ...(existingState?.processes ?? {}) },
  }
  if (health.web.healthy && health.web.process) state.processes.web = snapshotProcess(health.web.process, webLogPath)
  if (health.worker.healthy && health.worker.process) state.processes.worker = snapshotProcess(health.worker.process, workerLogPath)

  try {
    if (!health.web.healthy) {
      if (health.web.process) terminateProcess(health.web.process)
      const web = spawnService('web', mode, webLogPath, instanceToken)
      state.processes.web = snapshotProcess(web.process, webLogPath)
      startedThisTime.push(web)
    }
    if (!health.worker.healthy) {
      if (health.worker.process) terminateProcess(health.worker.process)
      const worker = spawnService('worker', mode, workerLogPath, instanceToken)
      state.processes.worker = snapshotProcess(worker.process, workerLogPath)
      startedThisTime.push(worker)
    }
    waitForStartedServices(startedThisTime, instanceToken)
  } catch (error) {
    for (const started of startedThisTime) terminateProcess(started.process)
    throw error
  }

  writeState(state)
  spawnWatchdog(state)
  console.log('[yanxing] 已启动 ' + (mode === 'production' ? '生产' : '开发') + '环境。')
  console.log('[yanxing] Web: http://localhost:' + webPort)
  console.log('[yanxing] 日志: ' + webLogPath + ', ' + workerLogPath)
}

function inspectServiceHealth(state, instanceToken) {
  const managed = state ? getManagedProcesses(state) : []
  const discovered = findProjectProcesses()
  const web = selectServiceProcess('web', managed, discovered)
  const worker = selectServiceProcess('worker', managed, discovered)
  return {
    web: { process: web, healthy: Boolean(web && isWebListening(web.pid, webPort)) },
    worker: { process: worker, healthy: Boolean(worker && isWorkerReady(worker.pid, instanceToken)) },
  }
}

function selectServiceProcess(service, managed, discovered) {
  return managed.find((processInfo) => processInfo.service === service)
    ?? discovered.find((processInfo) => processInfo.service === service)
}

function snapshotProcess(processInfo, logPath) {
  return {
    pid: processInfo.pid,
    logPath,
    startTime: processInfo.startTime,
    command: processInfo.command,
    cwd: processInfo.cwd ?? projectRoot,
  }
}

function waitForStartedServices(startedThisTime, instanceToken) {
  const deadline = Date.now() + startTimeoutMs
  while (Date.now() < deadline) {
    const failed = startedThisTime.find((started) => started.exitError || !isProcessAlive(started.process.pid))
    if (failed) throw new Error(failed.service === 'web' ? 'Web 启动失败，请查看 storage/logs/ 下的日志。' : 'Worker 启动失败，请查看 storage/logs/ 下的日志。')
    const ready = startedThisTime.every((started) => started.service === 'web'
      ? isWebListening(started.process.pid, webPort)
      : isWorkerReady(started.process.pid, instanceToken))
    if (ready) {
      for (const started of startedThisTime) started.child.unref()
      return
    }
    sleep(100)
  }
  throw new Error('应用启动超时，请查看 storage/logs/ 下的日志。')
}

function spawnWatchdog(state) {
  stopWatchdog(state)
  try {
    const child = spawn(process.execPath, [managerScriptPath, '--watch-logs'], {
      cwd: projectRoot,
      detached: true,
      env: { ...process.env, YANXING_INSTANCE_TOKEN: state.instanceToken },
      stdio: 'ignore',
    })
    child.unref()
    if (!child.pid) return
    const identity = readProcessIdentity(child.pid)
    state.processes.watchdog = {
      pid: child.pid,
      startTime: identity?.startTime,
      command: identity?.command,
      cwd: identity?.cwd ?? projectRoot,
      token: state.instanceToken,
    }
    writeState(state)
  } catch {
    // 看护进程启动失败只影响运行期日志轮转，不阻断应用启动。
  }
}

function stopWatchdog(state) {
  const recorded = state?.processes?.watchdog
  const processes = [
    ...(recorded?.pid ? [{ pid: recorded.pid, service: 'watchdog', startTime: recorded.startTime, command: recorded.command, cwd: recorded.cwd, pgid: recorded.pgid }] : []),
    ...findProjectProcesses().filter((processInfo) => processInfo.service === 'watchdog'),
  ]
  for (const processInfo of deduplicateProcesses(processes)) {
    if (!identitiesMatch(processInfo, readProcessIdentity(processInfo.pid)) && processInfo.startTime) continue
    terminateProcess(processInfo)
  }
}

function stopApp() {
  const state = readState()
  const processes = deduplicateProcesses([
    ...(state ? getManagedProcesses(state) : []),
    ...findProjectProcesses(),
  ])
  if (!processes.length) {
    removeState()
    console.log('[yanxing] 当前没有运行中的项目进程。')
    return
  }

  const failures = []
  for (const processInfo of processes) {
    try {
      terminateProcess(processInfo)
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  const remaining = deduplicateProcesses([
    ...(readState() ? getManagedProcesses(readState()) : []),
    ...findProjectProcesses(),
  ]).filter((processInfo) => isProcessAlive(processInfo.pid))
  if (remaining.length || failures.length) {
    process.exitCode = 1
    throw new Error(failures[0] || ('仍有 ' + remaining.length + ' 个项目进程未能停止。'))
  }
  removeState()
  console.log('[yanxing] 已停止 ' + processes.length + ' 个项目进程。')
}

function restartApp(mode) {
  const existingState = readState()
  const restartMode = mode ?? existingState?.mode ?? defaultMode
  stopApp()
  startApp(restartMode)
}

function printStatus() {
  const state = readState()
  const processes = deduplicateProcesses([
    ...(state ? getManagedProcesses(state) : []),
    ...findProjectProcesses(),
  ])
  if (!processes.length) {
    console.log('[yanxing] 已停止。')
    return
  }

  console.log(`[yanxing] 状态：运行中${state?.mode ? `（${state.mode === 'production' ? '生产' : '开发'}）` : ''}`)
  printProcessSummary('', processes)
}

function applyStartupRetention() {
  purgeExpiredLogArchives()
  rotateLogIfNeeded(webLogPath)
  rotateLogIfNeeded(workerLogPath)
  purgeExpiredTempEntries()
}

function rotateLogIfNeeded(logPath) {
  try {
    if (!existsSync(logPath) || statSync(logPath).size < logMaxBytes) return
    const archivePath = createArchivePath(logPath)
    renameSync(logPath, archivePath)
    const now = new Date()
    utimesSync(archivePath, now, now)
  } catch (error) {
    console.warn(`[yanxing] 无法轮转日志 ${path.basename(logPath)}：${error instanceof Error ? error.message : String(error)}`)
  }
}

function createArchivePath(logPath) {
  const timestamp = new Date().toISOString().replaceAll(/[-:.]/g, '')
  let archivePath = `${logPath}.${timestamp}`
  let suffix = 1
  while (existsSync(archivePath)) archivePath = `${logPath}.${timestamp}-${suffix++}`
  return archivePath
}

function purgeExpiredLogArchives() {
  const cutoff = Date.now() - logArchiveRetentionDays * 24 * 60 * 60 * 1000
  for (const entry of readdirSync(logDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !isManagedLogArchive(entry.name)) continue
    const archivePath = path.join(logDirectory, entry.name)
    try {
      if (statSync(archivePath).mtimeMs < cutoff) unlinkSync(archivePath)
    } catch {
      // A log archive may disappear or become inaccessible during cleanup.
    }
  }
}

function isManagedLogArchive(name) {
  return /^(?:web|worker)\.log\.\d{8}T\d{9}Z(?:-\d+)?$/.test(name)
}

function purgeExpiredTempEntries() {
  const tempDirectory = path.join(storageDirectory, 'tmp')
  if (!existsSync(tempDirectory)) return
  const cutoff = Date.now() - tempRetentionDays * 24 * 60 * 60 * 1000
  purgeExpiredEntries(tempDirectory, cutoff)
}

function purgeExpiredEntries(directory, cutoff) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    try {
      const stats = lstatSync(entryPath)
      if (stats.isDirectory()) {
        purgeExpiredEntries(entryPath, cutoff)
        if (stats.mtimeMs < cutoff && readdirSync(entryPath).length === 0) rmdirSync(entryPath)
      } else if (stats.mtimeMs < cutoff) {
        unlinkSync(entryPath)
      }
    } catch {
      // Cleanup is best effort; preserve entries that cannot be inspected safely.
    }
  }
}

function parsePositiveInteger(value, defaultValue) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return defaultValue
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : defaultValue
}

function runDatabaseMigration(mode) {
  const entryPoint = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const migrationScript = path.join(projectRoot, 'scripts', 'migrate.ts')
  if (!existsSync(entryPoint) || !existsSync(migrationScript)) {
    throw new Error('找不到数据库迁移脚本，请先执行 pnpm install。')
  }
  const result = spawnSync(process.execPath, [entryPoint, migrationScript], {
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: mode },
    stdio: 'inherit',
  })
  if (result.error) throw new Error(`数据库迁移进程启动失败：${result.error.message}`)
  if (result.status !== 0) throw new Error(`数据库迁移失败（退出码 ${result.status ?? 'unknown'}）。`)
}

function spawnService(service, mode, logPath, instanceToken) {
  const entryPoint = service === 'web'
    ? path.join(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next')
    : path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  if (!existsSync(entryPoint)) throw new Error('找不到 ' + service + ' 启动文件，请先执行 pnpm install。')

  const logFile = openSync(logPath, 'a')
  const args = service === 'web'
    ? mode === 'production' ? [entryPoint, 'start'] : [entryPoint, 'dev', '--webpack']
    : [entryPoint, 'worker/index.ts']
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: mode,
      YANXING_INSTANCE_TOKEN: instanceToken,
      YANXING_NEXT_DIST_DIR: mode === 'production' ? '.next' : '.next-dev',
      ...(service === 'web' ? { PORT: webPort } : { YANXING_WORKER_READY_PATH: workerReadyPath(instanceToken) }),
    },
    stdio: ['ignore', logFile, logFile],
  })
  closeSync(logFile)
  if (!child.pid) throw new Error(service + ' 进程启动失败。')
  const started = {
    service,
    child,
    process: { pid: child.pid, service, ...readProcessIdentity(child.pid) },
    exitError: undefined,
  }
  child.once('error', (error) => { started.exitError = error })
  child.once('exit', (code, signal) => { started.exitError = new Error(service + ' 进程已退出（' + (signal || code) + '）。') })
  return started
}

function terminateProcess(processInfo) {
  const pid = typeof processInfo === 'number' ? processInfo : processInfo.pid
  const identity = typeof processInfo === 'number' ? { pid } : processInfo
  if (!isProcessAlive(pid)) return
  sendSignal(identity, 'SIGTERM')
  const deadline = Date.now() + stopTimeoutMs
  while (Date.now() < deadline && isProcessAlive(pid)) sleep(100)
  if (isProcessAlive(pid)) sendSignal(identity, 'SIGKILL')
}

function sendSignal(processInfo, signal) {
  const pid = typeof processInfo === 'number' ? processInfo : processInfo.pid
  const current = readProcessIdentity(pid)
  if (typeof processInfo === 'object' && processInfo.startTime && current && !identitiesMatch(processInfo, current)) {
    return
  }
  if (!isProcessAlive(pid)) return
  if (process.platform === 'win32') {
    process.kill(pid, signal)
    return
  }
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (isErrno(error, 'EPERM')) throw new Error('无法停止进程 ' + pid + '：权限不足。')
    if (isErrno(error, 'ESRCH') && isProcessAlive(pid)) {
      try {
        process.kill(pid, signal)
      } catch (fallbackError) {
        if (isErrno(fallbackError, 'EPERM')) throw new Error('无法停止进程 ' + pid + '：权限不足。')
        if (!isErrno(fallbackError, 'ESRCH')) throw fallbackError
      }
      return
    }
    if (isErrno(error, 'ESRCH')) return
    throw error
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (isErrno(error, 'EPERM')) return true
    return false
  }
  if (process.platform !== 'linux') return true
  try {
    const stat = readFileSync('/proc/' + pid + '/stat', 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
    return state !== 'Z'
  } catch {
    return false
  }
}

function readProcessIdentity(pid) {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return undefined
  try {
    const cwd = readlinkSync('/proc/' + pid + '/cwd')
    const command = readFileSync('/proc/' + pid + '/cmdline', 'utf8').replaceAll('\0', ' ')
    const stat = readFileSync('/proc/' + pid + '/stat', 'utf8')
    const closeParen = stat.lastIndexOf(')')
    const rest = stat.slice(closeParen + 2).split(' ')
    return {
      pid,
      cwd,
      command,
      pgid: Number(rest[2]),
      startTime: rest[19],
    }
  } catch {
    return undefined
  }
}

function identitiesMatch(expected, actual) {
  if (!expected || !actual) return false
  if (expected.pid !== actual.pid) return false
  if (expected.startTime && actual.startTime && expected.startTime !== actual.startTime) return false
  if (expected.cwd && actual.cwd && expected.cwd !== actual.cwd) return false
  if (expected.command && actual.command && expected.command !== actual.command) return false
  return true
}

function findProjectProcesses() {
  if (process.platform !== 'linux') return []
  const processes = []
  for (const entry of readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    const pid = Number(entry.name)
    try {
      const identity = readProcessIdentity(pid)
      if (!identity || identity.cwd !== projectRoot) continue
      const executable = readlinkSync('/proc/' + pid + '/exe')
      if (!executable.endsWith(path.sep + 'node') && !executable.endsWith(path.sep + 'nodejs')) continue
      const service = isWebCommand(identity.command) ? 'web'
        : isWorkerCommand(identity.command) ? 'worker'
        : isWatchdogCommand(identity.command) ? 'watchdog'
        : undefined
      if (!service) continue
      processes.push({ ...identity, service })
    } catch {
      // The process may exit while /proc is being inspected.
    }
  }
  return processes
}

function isWebCommand(command) {
  return command.includes(`${path.sep}next${path.sep}dist${path.sep}bin${path.sep}next`) || command.includes('next-server')
}

function isWorkerCommand(command) {
  return command.includes('worker/index.ts')
}

function isWatchdogCommand(command) {
  return command.includes('app-manager.mjs') && command.includes('--watch-logs')
}

function isWebListening(rootPid, port) {
  const inodes = listeningSocketInodes(Number(port))
  if (!inodes.size) return false
  for (const pid of collectDescendantPids(rootPid)) {
    if (processHasSocketInode(pid, inodes)) return true
  }
  return false
}

function isWorkerReady(pid, instanceToken) {
  if (!instanceToken || !isProcessAlive(pid)) return false
  try {
    return readFileSync(workerReadyPath(instanceToken), 'utf8').trim() === instanceToken
  } catch {
    return false
  }
}

function collectDescendantPids(rootPid) {
  const pids = new Set([rootPid])
  if (process.platform !== 'linux') return pids
  let changed = true
  while (changed) {
    changed = false
    for (const entry of readdirSync('/proc', { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
      const pid = Number(entry.name)
      if (pids.has(pid)) continue
      try {
        const stat = readFileSync('/proc/' + pid + '/stat', 'utf8')
        const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        if (pids.has(Number(rest[1]))) {
          pids.add(pid)
          changed = true
        }
      } catch {
        // The process may exit while /proc is being inspected.
      }
    }
  }
  return pids
}

function listeningSocketInodes(port) {
  const inodes = new Set()
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    if (!existsSync(table)) continue
    for (const line of readFileSync(table, 'utf8').trim().split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 10 || cols[3] !== '0A') continue
      const localPort = Number.parseInt(cols[1].slice(cols[1].lastIndexOf(':') + 1), 16)
      if (localPort === port) inodes.add(cols[9])
    }
  }
  return inodes
}

function processHasSocketInode(pid, inodes) {
  const fdDir = '/proc/' + pid + '/fd'
  try {
    for (const entry of readdirSync(fdDir)) {
      try {
        const target = readlinkSync(path.join(fdDir, entry))
        const match = /^socket:\[(\d+)\]$/.exec(target)
        if (match && inodes.has(match[1])) return true
      } catch {
        // Descriptor may disappear while we inspect the process.
      }
    }
  } catch {
    return false
  }
  return false
}

function readState() {
  if (!existsSync(statePath)) return undefined
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    removeState()
    return undefined
  }
}

function writeState(state) {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

function removeState() {
  try { unlinkSync(statePath) } catch { /* state already removed */ }
}

function getManagedProcesses(state) {
  return Object.entries(state.processes ?? {}).flatMap(([service, value]) => {
    if (service !== 'web' && service !== 'worker' && service !== 'watchdog') return []
    const pid = typeof value?.pid === 'number' ? value.pid : Number(value?.pid)
    if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) return []
    const identity = readProcessIdentity(pid)
    const recorded = { pid, service, startTime: value?.startTime, command: value?.command, cwd: value?.cwd }
    if (recorded.startTime && identity && !identitiesMatch(recorded, identity)) return []
    return [{ ...recorded, command: recorded.command ?? identity?.command, cwd: recorded.cwd ?? identity?.cwd, pgid: identity?.pgid, startTime: recorded.startTime ?? identity?.startTime }]
  })
}

function deduplicateProcesses(processes) {
  const unique = new Map()
  for (const processInfo of processes) {
    if (!unique.has(processInfo.pid)) unique.set(processInfo.pid, processInfo)
  }
  return [...unique.values()]
}

function printProcessSummary(prefix, processes) {
  if (prefix) console.log(`[yanxing] ${prefix}：`)
  for (const processInfo of processes) {
    console.log(`  ${processInfo.service}: pid=${processInfo.pid} ${isProcessAlive(processInfo.pid) ? 'running' : 'stopped'}`)
  }
}

function withRotateLock(callback) {
  const token = process.pid + ':rotate:' + Date.now() + ':' + Math.random().toString(16).slice(2)
  let lockFile
  try {
    lockFile = openSync(rotateLockPath, 'wx')
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) return
    if (!reclaimStalePath(rotateLockPath)) return
    try {
      lockFile = openSync(rotateLockPath, 'wx')
    } catch {
      return
    }
  }
  try {
    writeFileSync(lockFile, token + '\n')
    callback()
  } finally {
    closeSync(lockFile)
    try {
      if (readFileSync(rotateLockPath, 'utf8').trim() === token) unlinkSync(rotateLockPath)
    } catch {
      // Another rotator may have replaced the lock after we released it.
    }
  }
}

function reclaimStalePath(targetPath) {
  const first = readPathLockIdentity(targetPath)
  if (first.status !== 'dead') return false
  const second = readPathLockIdentity(targetPath)
  if (second.status !== 'dead' || second.token !== first.token) return false
  try {
    unlinkSync(targetPath)
    return true
  } catch (error) {
    return isErrno(error, 'ENOENT')
  }
}

function readPathLockIdentity(targetPath) {
  try {
    const token = readFileSync(targetPath, 'utf8').trim()
    if (!token) return { status: 'empty', token: '' }
    const pid = Number(token.split(':')[0])
    if (!Number.isInteger(pid) || pid <= 0) return { status: 'unknown', token }
    if (isProcessAlive(pid)) return { status: 'live', token, pid }
    return { status: 'dead', token, pid }
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { status: 'missing' }
    return { status: 'unreadable' }
  }
}

function withLock(callback) {
  const lockFile = acquireLock()
  const lockToken = process.pid + ':' + Date.now() + ':' + Math.random().toString(16).slice(2)
  try {
    writeFileSync(lockFile, lockToken + '\n')
    callback()
  } finally {
    closeSync(lockFile)
    removeLockIfOwner(lockToken)
  }
}

function removeLockIfOwner(token) {
  try {
    if (readFileSync(lockPath, 'utf8').trim() === token) unlinkSync(lockPath)
  } catch {
    // 锁已消失或内容不可读时不必删除：删除他人新锁才是要避免的错误。
  }
}

function isErrno(error, code) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code)
}

function acquireLock() {
  try {
    return openSync(lockPath, 'wx')
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw new Error('无法创建启动管理锁：' + (error instanceof Error ? error.message : String(error)))
    if (!reclaimStaleLock()) throw new Error('已有另一个启动管理命令正在执行，请稍后重试。')
    try {
      return openSync(lockPath, 'wx')
    } catch (retryError) {
      if (isErrno(retryError, 'EEXIST')) throw new Error('已有另一个启动管理命令正在执行，请稍后重试。')
      throw new Error('无法创建启动管理锁：' + (retryError instanceof Error ? retryError.message : String(retryError)))
    }
  }
}

function readLockIdentity() {
  return readPathLockIdentity(lockPath)
}

function reclaimStaleLock() {
  return reclaimStalePath(lockPath)
}

function getMode(args) {
  if (args.includes('--production') || args.includes('--mode=production')) return 'production'
  if (args.includes('--development') || args.includes('--mode=development')) return 'development'
  const modeIndex = args.indexOf('--mode')
  if (modeIndex >= 0 && ['development', 'production'].includes(args[modeIndex + 1])) return args[modeIndex + 1]
  return undefined
}

function sleep(milliseconds) {
  // Synchronous waiting is intentional: stop must finish before the command exits.
  // Atomics.wait 阻塞线程而不自旋，避免忙等占满单核。
  const buffer = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds)
}

function applyRuntimeSettings() {
  webPort = process.env.YANXING_PORT ?? '3000'
  logMaxBytes = parsePositiveInteger(process.env.YANXING_LOG_MAX_BYTES, 10 * 1024 * 1024)
  logArchiveRetentionDays = parsePositiveInteger(process.env.YANXING_LOG_ARCHIVE_RETENTION_DAYS, 14)
  tempRetentionDays = parsePositiveInteger(process.env.YANXING_TEMP_RETENTION_DAYS, 7)
  startTimeoutMs = parsePositiveInteger(process.env.YANXING_START_TIMEOUT_MS, 30_000)
  stopTimeoutMs = parsePositiveInteger(process.env.YANXING_STOP_TIMEOUT_MS, 8_000)
}

function isMainModule() {
  if (!process.argv[1]) return false
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
}

function main() {
  mkdirSync(storageDirectory, { recursive: true })
  mkdirSync(logDirectory, { recursive: true })
  const args = process.argv.slice(2)
  const mode = resolveStartupMode({ args, cwd: projectRoot })
  loadYanXingEnv({ dir: projectRoot, mode })
  applyRuntimeSettings()
  if (args[0] === '--watch-logs') {
    runLogWatchdog()
    return
  }
  const command = supportedCommands.has(args[0]) ? args[0] : 'status'
  const appMode = mode === 'production' ? 'production' : 'development'
  try {
    withLock(() => {
      if (command === 'start') startApp(appMode)
      else if (command === 'stop') stopApp()
      else if (command === 'restart') restartApp(getMode(args) ?? appMode)
      else printStatus()
    })
  } catch (error) {
    console.error('[yanxing] ' + (error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  }
}

if (isMainModule()) {
  main()
}

export {
  deduplicateProcesses,
  identitiesMatch,
  readProcessIdentity,
  sendSignal,
}

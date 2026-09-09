import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

export const defaultShutdownGraceMs = 80_000
export const defaultWorkerHeartbeatPath = '/tmp/yanxing-worker-heartbeat.json'
export const defaultWebHostname = '0.0.0.0'
export const defaultMigrateScript = '.runtime/scripts/migrate.mjs'
export const defaultWebScript = 'server.js'
export const defaultWorkerScript = '.runtime/worker/index.mjs'
export const productionModeArg = '--mode=production'

const processPollMs = 25
const shutdownSettleMs = 75
const postKillWaitMs = 1_000
const logPrefix = '[yanxing-supervisor]'

export function resolveDockerSupervisorPlan(options = {}) {
  const cwd = options.cwd ?? process.cwd()
  const nodePath = options.nodePath ?? process.execPath
  const baseEnv = options.env ?? process.env
  const shutdownGraceMs = resolveShutdownGraceMs(options.shutdownGraceMs)
  const heartbeatPath = options.heartbeatPath
    ?? nonemptyString(baseEnv.YANXING_WORKER_HEARTBEAT_PATH)
    ?? defaultWorkerHeartbeatPath
  return {
    cwd,
    nodePath,
    shutdownGraceMs,
    heartbeatPath,
    stdio: options.stdio ?? 'inherit',
    migrate: resolveCommand(options.migrate, {
      command: nodePath,
      args: [path.resolve(cwd, defaultMigrateScript), productionModeArg],
      env: { ...baseEnv },
    }),
    web: resolveCommand(options.web, {
      command: nodePath,
      args: [path.resolve(cwd, defaultWebScript)],
      env: { ...baseEnv, HOSTNAME: defaultWebHostname },
    }),
    worker: resolveCommand(options.worker, {
      command: nodePath,
      args: [path.resolve(cwd, defaultWorkerScript), productionModeArg],
      env: { ...baseEnv, YANXING_WORKER_HEARTBEAT_PATH: heartbeatPath },
    }),
  }
}

export async function runDockerSupervisor(options = {}) {
  const plan = resolveDockerSupervisorPlan(options)
  const log = createLogger(options.log)
  const signalGate = createSignalGate(options.signalEmitter ?? process)
  const started = []
  let stopTask
  const stopStarted = () => {
    if (!stopTask) stopTask = stopManagedProcesses(started, plan.shutdownGraceMs, log).catch((error) => {
      log(error instanceof Error ? error.message : String(error))
      for (const service of started) releaseManaged(service)
      return { forceKilled: true }
    })
    return stopTask
  }
  clearHeartbeat(plan.heartbeatPath, log)
  try {
    const migrateResult = await runMigrate({ plan, signalGate, log, started })
    if (signalGate.signal) {
      log(`received ${signalGate.signal} during migrate; not starting services`)
      await stopStarted()
      return 1
    }
    if (migrateResult !== 0) {
      log(`migrate failed (code=${migrateResult})`)
      await stopStarted()
      return migrateResult
    }
    const services = startServices({ plan, log, started })
    if (signalGate.signal) {
      await stopStarted()
      log(`received ${signalGate.signal} before services were supervised; not keeping them running`)
      return 1
    }
    return await superviseServices({ services, signalGate, stopStarted, log })
  } catch (error) {
    log(error instanceof Error ? error.message : String(error))
    await stopStarted()
    return 1
  } finally {
    signalGate.dispose()
    await stopStarted()
    clearHeartbeat(plan.heartbeatPath, log)
  }
}

function resolveCommand(override, defaults) {
  if (!override) return defaults
  return {
    command: override.command ?? defaults.command,
    args: override.args ?? defaults.args,
    env: { ...defaults.env, ...override.env },
  }
}

function resolveShutdownGraceMs(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : defaultShutdownGraceMs
}

function createLogger(log) {
  return (message) => {
    const line = `${logPrefix} ${message}`
    try {
      if (log) log(line)
      else console.error(line)
    } catch {
      try { console.error(line) } catch { /* logging must never fail the supervisor */ }
    }
  }
}

function createSignalGate(signalEmitter) {
  let resolveWait
  const wait = new Promise((resolve) => {
    resolveWait = resolve
  })
  const gate = { signal: undefined, wait, dispose }
  const onTerm = () => receive('SIGTERM')
  const onInt = () => receive('SIGINT')
  signalEmitter.on('SIGTERM', onTerm)
  signalEmitter.on('SIGINT', onInt)
  return gate

  function receive(signal) {
    if (gate.signal) return
    gate.signal = signal
    resolveWait()
  }

  function dispose() {
    signalEmitter.off('SIGTERM', onTerm)
    signalEmitter.off('SIGINT', onInt)
  }
}

async function runMigrate({ plan, signalGate, log, started }) {
  const managed = spawnManaged({ name: 'migrate', command: plan.migrate, plan, started })
  if (managed.pid) log(`started migrate pid=${managed.pid}`)
  const outcome = await Promise.race([
    managed.ended.then(() => 'exit'),
    signalGate.wait.then(() => 'signal'),
  ])
  if (outcome === 'signal' || signalGate.signal) return 1
  if (managed.spawnError) {
    log(`migrate spawn failed: ${describeSpawnError(managed.spawnError)}`)
    return 1
  }
  if (managed.exit?.signal) return 1
  return managed.exit?.code ?? 1
}

function startServices({ plan, log, started }) {
  const web = spawnManaged({ name: 'web', command: plan.web, plan, started })
  const worker = spawnManaged({ name: 'worker', command: plan.worker, plan, started })
  if (web.pid) log(`started web pid=${web.pid}`)
  else log(`web spawn failed: ${describeSpawnError(web.spawnError)}`)
  if (worker.pid) log(`started worker pid=${worker.pid}`)
  else log(`worker spawn failed: ${describeSpawnError(worker.spawnError)}`)
  return [web, worker]
}

async function superviseServices({ services, signalGate, stopStarted, log }) {
  await Promise.race([...services.map((service) => service.ended), signalGate.wait])
  const receivedSignal = signalGate.signal
  const crashed = services.some((service) => service.spawnError || service.exit)
  if (crashed) {
    const ended = services.find((service) => service.spawnError || service.exit)
    log(describeManagedEnd(ended))
  } else if (receivedSignal) {
    log(`received ${receivedSignal}`)
  }
  const stopResult = await stopStarted()
  if (stopResult.forceKilled || crashed || !receivedSignal) return 1
  return 0
}

function spawnManaged({ name, command, plan, started }) {
  const managed = {
    name,
    child: undefined,
    pid: undefined,
    spawnError: undefined,
    exit: undefined,
    ended: undefined,
  }
  let settle
  managed.ended = new Promise((resolve) => {
    settle = () => resolve(managed)
  })
  managed.settle = settle
  started.push(managed)
  let child
  try {
    child = spawn(command.command, command.args, {
      cwd: plan.cwd,
      env: command.env,
      detached: true,
      stdio: plan.stdio,
    })
  } catch (error) {
    managed.spawnError = error
    settle()
    return managed
  }
  managed.child = child
  managed.pid = child.pid
  child.once('error', (error) => {
    managed.spawnError = error
    settle()
  })
  child.once('exit', (code, signal) => {
    managed.exit = { code, signal }
    settle()
  })
  if (managed.pid === undefined && !managed.spawnError) {
    managed.spawnError = new Error('spawn returned no pid')
    settle()
  }
  return managed
}

async function stopManagedProcesses(services, shutdownGraceMs, log) {
  const trackedPids = new Set(services.map((service) => service.pid).filter(isSafePid))
  const trackedPgids = new Set()
  if (trackedPids.size === 0) {
    await waitForEnded(services, postKillWaitMs)
    for (const service of services) releaseManaged(service)
    return { forceKilled: false }
  }
  const tracked = { pids: trackedPids, pgids: trackedPgids }
  const notified = { pids: new Set(), pgids: new Set() }
  let forceKilled = false
  try {
    const timedOut = await drainManagedProcesses({ tracked, timeoutMs: shutdownGraceMs, signal: 'SIGTERM', notified })
    if (timedOut) {
      log('shutdown timed out; sending SIGKILL')
      await drainManagedProcesses({ tracked, timeoutMs: postKillWaitMs, signal: 'SIGKILL' })
      forceKilled = true
    }
  } catch (error) {
    log(error instanceof Error ? error.message : String(error))
    forceKilled = true
    try {
      await drainManagedProcesses({ tracked, timeoutMs: postKillWaitMs, signal: 'SIGKILL' })
    } catch { /* release handles below so the CLI can exit */ }
  }
  await waitForEnded(services, postKillWaitMs)
  if (liveTrackedPids(tracked.pids, tracked.pgids).length > 0) forceKilled = true
  for (const service of services) releaseManaged(service)
  return { forceKilled }
}

async function waitForEnded(services, timeoutMs) {
  await Promise.race([
    Promise.all(services.map((service) => service.ended)),
    delay(timeoutMs),
  ])
}

function releaseManaged(managed) {
  const child = managed.child
  if (child) {
    try { child.unref() } catch {}
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      try { stream?.destroy() } catch {}
    }
  }
  if (!managed.exit && !managed.spawnError) managed.exit = { code: null, signal: 'SIGKILL' }
  try { managed.settle?.() } catch {}
}

async function drainManagedProcesses({ tracked, timeoutMs, signal, notified }) {
  const deadline = Date.now() + timeoutMs
  let emptySince
  while (true) {
    let collected
    try {
      collected = collectManagedProcesses(tracked.pids, tracked.pgids)
      rememberManaged(tracked.pids, tracked.pgids, collected)
    } catch {
      collected = {
        processes: [...tracked.pids].map((pid) => ({ pid, ppid: 0, pgid: pid, state: '?' })),
        pgids: new Set(tracked.pgids),
      }
    }
    if (signal === 'SIGKILL' || !notified) {
      signalCollected(collected, 'SIGKILL')
      for (const pid of liveTrackedPids(tracked.pids, tracked.pgids)) sendSignal(pid, 'SIGKILL')
    } else {
      signalUnnotifiedTerm(collected, notified)
    }
    const alive = liveTrackedPids(tracked.pids, tracked.pgids)
    if (alive.length === 0) {
      if (emptySince === undefined) emptySince = Date.now()
      if (Date.now() - emptySince >= shutdownSettleMs || Date.now() >= deadline) return false
    } else {
      emptySince = undefined
    }
    if (Date.now() >= deadline) return alive.length > 0
    await delay(processPollMs)
  }
}

function signalUnnotifiedTerm(collected, notified) {
  const groupsSignaledNow = new Set()
  for (const pgid of collected.pgids) {
    if (notified.pgids.has(pgid)) continue
    sendGroupSignal(pgid, 'SIGTERM')
    notified.pgids.add(pgid)
    groupsSignaledNow.add(pgid)
  }
  for (const proc of collected.processes) {
    if (!isSafePid(proc.pid) || notified.pids.has(proc.pid)) continue
    notified.pids.add(proc.pid)
    if (!isProcessAlive(proc.pid)) continue
    if (groupsSignaledNow.has(proc.pgid)) continue
    sendSignal(proc.pid, 'SIGTERM')
  }
}

function collectManagedProcesses(rootPids, knownPgids) {
  const snapshot = listLinuxProcesses()
  const byPid = new Map(snapshot.map((proc) => [proc.pid, proc]))
  const byParent = new Map()
  for (const proc of snapshot) {
    const children = byParent.get(proc.ppid)
    if (children) children.push(proc)
    else byParent.set(proc.ppid, [proc])
  }
  const processes = new Map()
  const stack = [...rootPids]
  while (stack.length > 0) {
    const pid = stack.pop()
    if (processes.has(pid)) continue
    processes.set(pid, byPid.get(pid) ?? { pid, ppid: 0, pgid: pid, state: '?' })
    for (const child of byParent.get(pid) ?? []) stack.push(child.pid)
  }
  const pgids = new Set()
  for (const pgid of knownPgids) {
    if (isSafeGroup(pgid)) pgids.add(pgid)
  }
  for (const proc of processes.values()) {
    if (isSafeGroup(proc.pgid)) pgids.add(proc.pgid)
  }
  for (const proc of snapshot) {
    if (!pgids.has(proc.pgid)) continue
    processes.set(proc.pid, proc)
    if (isSafeGroup(proc.pgid)) pgids.add(proc.pgid)
  }
  return { processes: [...processes.values()], pgids }
}

function rememberManaged(trackedPids, trackedPgids, collected) {
  for (const proc of collected.processes) {
    if (isSafePid(proc.pid)) trackedPids.add(proc.pid)
    if (isSafeGroup(proc.pgid)) trackedPgids.add(proc.pgid)
  }
  for (const pgid of collected.pgids) {
    if (isSafeGroup(pgid)) trackedPgids.add(pgid)
  }
}

function liveTrackedPids(trackedPids, trackedPgids) {
  const collected = collectManagedProcesses(trackedPids, trackedPgids)
  rememberManaged(trackedPids, trackedPgids, collected)
  const alive = new Set()
  for (const proc of collected.processes) {
    if (isProcessAlive(proc.pid)) alive.add(proc.pid)
  }
  for (const pid of trackedPids) {
    if (isProcessAlive(pid)) alive.add(pid)
  }
  return [...alive]
}

function signalCollected(collected, signal) {
  for (const pgid of collected.pgids) sendGroupSignal(pgid, signal)
  for (const proc of collected.processes) {
    if (!isProcessAlive(proc.pid)) continue
    if (isSafeGroup(proc.pgid) && collected.pgids.has(proc.pgid)) continue
    sendSignal(proc.pid, signal)
  }
}

function sendGroupSignal(pgid, signal) {
  if (!isSafeGroup(pgid)) return
  try {
    process.kill(-pgid, signal)
  } catch (error) {
    if (isErrno(error, 'ESRCH')) {
      sendSignal(pgid, signal)
      return
    }
    if (!isErrno(error, 'EPERM')) return
    sendSignal(pgid, signal)
  }
}

function sendSignal(pid, signal) {
  if (!isSafePid(pid) || pid === process.pid) return
  try {
    process.kill(pid, signal)
  } catch (error) {
    if (isErrno(error, 'ESRCH') || isErrno(error, 'EPERM')) return
    throw error
  }
}

function listLinuxProcesses() {
  if (process.platform !== 'linux') return []
  let entries
  try {
    entries = readdirSync('/proc')
  } catch {
    return []
  }
  const processes = []
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue
    const pid = Number(entry)
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const closeParen = stat.lastIndexOf(')')
      const rest = stat.slice(closeParen + 2).split(' ')
      processes.push({
        pid,
        state: rest[0],
        ppid: Number(rest[1]),
        pgid: Number(rest[2]),
      })
    } catch {
      // The process exited while we were scanning /proc.
    }
  }
  return processes
}

function isProcessAlive(pid) {
  if (!isSafePid(pid)) return false
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (isErrno(error, 'EPERM')) return true
    return false
  }
  if (process.platform !== 'linux') return true
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
    return state !== 'Z'
  } catch {
    return false
  }
}

function clearHeartbeat(heartbeatPath, log) {
  let removed = false
  for (const target of [heartbeatPath, `${heartbeatPath}.tmp`]) {
    try {
      unlinkSync(target)
      removed = true
    } catch (error) {
      if (isNotFound(error)) continue
      log(`heartbeat cleanup failed: ${describeSpawnError(error)}`)
    }
  }
  if (removed) log('cleared stale worker heartbeat')
}

function describeManagedEnd(managed) {
  if (managed.spawnError) return `${managed.name} spawn failed: ${describeSpawnError(managed.spawnError)}`
  if (managed.exit?.signal) return `${managed.name} exited (${managed.exit.signal})`
  if (managed.exit) return `${managed.name} exited (code=${managed.exit.code ?? 'unknown'})`
  return `${managed.name} ended`
}

function describeSpawnError(error) {
  if (error && typeof error === 'object' && 'code' in error && error.code) return String(error.code)
  return error instanceof Error ? error.message : String(error)
}

function nonemptyString(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function isSafePid(pid) {
  return Number.isInteger(pid) && pid > 1
}

function isSafeGroup(pgid) {
  return isSafePid(pgid) && pgid !== process.pid
}

function isErrno(error, code) {
  return Boolean(error) && typeof error === 'object' && 'code' in error && error.code === code
}

function isNotFound(error) {
  return isErrno(error, 'ENOENT')
}

function isMainModule() {
  if (!process.argv[1]) return false
  return pathToFileURL(process.argv[1]).href === import.meta.url
}

if (isMainModule()) {
  try {
    if (process.argv.length > 2) {
      console.error(`${logPrefix} this command does not accept arguments`)
      process.exit(1)
    } else {
      process.exit(await runDockerSupervisor())
    }
  } catch (error) {
    console.error(logPrefix, error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

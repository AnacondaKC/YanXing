import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { deduplicateProcesses, sendSignal } from '../scripts/app-manager.mjs'

const managerPath = fileURLToPath(new URL('../scripts/app-manager.mjs', import.meta.url))

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
    server.on('error', reject)
  })
}

function writeFakeApp(cwd) {
  mkdirSync(path.join(cwd, 'scripts'), { recursive: true })
  mkdirSync(path.join(cwd, 'storage', 'logs'), { recursive: true })
  mkdirSync(path.join(cwd, 'node_modules', 'next', 'dist', 'bin'), { recursive: true })
  mkdirSync(path.join(cwd, 'node_modules', 'tsx', 'dist'), { recursive: true })
  mkdirSync(path.join(cwd, 'worker'), { recursive: true })
  writeFileSync(path.join(cwd, 'scripts', 'migrate.ts'), 'process.exit(0)\n')
  writeFileSync(path.join(cwd, 'node_modules', 'tsx', 'dist', 'cli.mjs'), [
    "import { readFileSync } from 'node:fs'",
    "import path from 'node:path'",
    "const script = process.argv[2]",
    "if (!script) process.exit(1)",
    "if (String(script).includes('migrate')) process.exit(0)",
    "const source = readFileSync(path.resolve(script), 'utf8')",
    "const encoded = Buffer.from(source).toString('base64')",
    "await import('data:text/javascript;base64,' + encoded)",
    "",
  ].join('\n'))
  writeFileSync(path.join(cwd, 'node_modules', 'next', 'dist', 'bin', 'next'), [
    "const http = require('node:http')",
    "const delayMs = Number(process.env.YANXING_FAKE_WEB_DELAY_MS || 0)",
    "const exitMs = process.env.YANXING_FAKE_WEB_EXIT_MS",
    "const port = Number(process.env.PORT || 3000)",
    "if (exitMs) {",
    "  setTimeout(() => process.exit(1), Number(exitMs))",
    "} else {",
    "  setTimeout(() => {",
    "    http.createServer((_req, res) => res.end('ok')).listen(port, '127.0.0.1')",
    "  }, delayMs)",
    "}",
    "",
  ].join('\n'))
  writeFileSync(path.join(cwd, 'worker', 'index.ts'), [
    "import { writeFileSync } from 'node:fs'",
    "const delayMs = Number(process.env.YANXING_FAKE_WORKER_DELAY_MS || 0)",
    "if (process.env.YANXING_FAKE_WORKER_FAIL) {",
    "  setTimeout(() => process.exit(1), 50)",
    "} else {",
    "  setTimeout(() => {",
    "    writeFileSync(process.env.YANXING_WORKER_READY_PATH, process.env.YANXING_INSTANCE_TOKEN)",
    "  }, delayMs)",
    "  setInterval(() => {}, 60_000)",
    "}",
    "",
  ].join('\n'))
}

function runManager(cwd, args, extraEnv = {}) {
  return spawnSync(process.execPath, [managerPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      YANXING_START_TIMEOUT_MS: extraEnv.YANXING_START_TIMEOUT_MS ?? '4000',
      YANXING_STOP_TIMEOUT_MS: extraEnv.YANXING_STOP_TIMEOUT_MS ?? '500',
      YANXING_LOG_WATCH_INTERVAL_MS: extraEnv.YANXING_LOG_WATCH_INTERVAL_MS ?? '150',
      ...extraEnv,
    },
  })
}

function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    const stat = readFileSync('/proc/' + pid + '/stat', 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
    return state !== 'Z'
  } catch {
    return false
  }
}

function readState(cwd) {
  const statePath = path.join(cwd, 'storage', '.yanxing-app.json')
  if (!existsSync(statePath)) return undefined
  return JSON.parse(readFileSync(statePath, 'utf8'))
}

function killPid(pid) {
  if (!isAlive(pid)) return
  try { process.kill(-pid, 'SIGKILL') } catch {
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
}

async function withFakeApp(run) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'yanxing-life-'))
  writeFakeApp(cwd)
  const port = String(await freePort())
  const pids = []
  try {
    return await run({ cwd, port, track(pid) { if (pid) pids.push(pid) } })
  } finally {
    runManager(cwd, ['stop'], { YANXING_PORT: port })
    for (const pid of pids) killPid(pid)
    await rm(cwd, { recursive: true, force: true })
  }
}

test('deduplicates managed processes by pid rather than service name', () => {
  const processes = deduplicateProcesses([
    { pid: 11, service: 'worker' },
    { pid: 12, service: 'worker' },
    { pid: 11, service: 'worker' },
  ])
  assert.deepEqual(processes.map((item) => item.pid).sort((a, b) => a - b), [11, 12])
})

test('permission errors fail instead of being swallowed', () => {
  const original = process.kill
  process.kill = (pid, signal) => {
    if (signal === 0) return original.call(process, pid, signal)
    const error = new Error('denied')
    error.code = 'EPERM'
    throw error
  }
  try {
    assert.throws(() => sendSignal({ pid: process.pid }, 'SIGTERM'), /权限不足/)
  } finally {
    process.kill = original
  }
})

test('stop kills two independent workers and a leftover child after parent exit', async () => {
  await withFakeApp(async ({ cwd, port, track }) => {
    const workerPath = path.join(cwd, 'worker', 'index.ts')
    const first = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)', workerPath], { cwd, detached: true, stdio: 'ignore' })
    const second = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)', workerPath], { cwd, detached: true, stdio: 'ignore' })
    first.unref()
    second.unref()
    track(first.pid)
    track(second.pid)
    const leftoverScript = [
      "import { spawn } from 'node:child_process'",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)', " + JSON.stringify(workerPath) + "], { cwd: process.cwd(), detached: true, stdio: 'ignore' })",
      "child.unref()",
      "process.stdout.write(String(child.pid))",
      "process.exit(0)",
      "",
    ].join('\n')
    const leftover = spawnSync(process.execPath, ['--input-type=module', '-e', leftoverScript], { cwd, encoding: 'utf8', env: { ...process.env, YANXING_WORKER_READY_PATH: path.join(cwd, 'ready-3'), YANXING_INSTANCE_TOKEN: 't3' } })
    const leftoverPid = Number(leftover.stdout.trim())
    track(leftoverPid)
    await delay(150)
    assert.equal(isAlive(first.pid), true)
    assert.equal(isAlive(second.pid), true)
    assert.equal(isAlive(leftoverPid), true)
    const stopped = runManager(cwd, ['stop'], { YANXING_PORT: port })
    assert.equal(stopped.status, 0, stopped.stderr)
    assert.equal(isAlive(first.pid), false)
    assert.equal(isAlive(second.pid), false)
    assert.equal(isAlive(leftoverPid), false)
  })
})

test('stop falls back to a single pid when the process is not a group leader', async () => {
  await withFakeApp(async ({ cwd, port, track }) => {
    const workerPath = path.join(cwd, 'worker', 'index.ts')
    const parentScript = [
      "import { spawn } from 'node:child_process'",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)', " + JSON.stringify(workerPath) + "], { stdio: 'ignore' })",
      "process.stdout.write(String(child.pid))",
      "setInterval(() => {}, 60_000)",
      "",
    ].join('\n')
    const parent = spawn(process.execPath, ['--input-type=module', '-e', parentScript], { cwd, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, YANXING_WORKER_READY_PATH: path.join(cwd, 'ready-child'), YANXING_INSTANCE_TOKEN: 'child' } })
    track(parent.pid)
    const childPid = Number(await new Promise((resolve) => {
      let output = ''
      parent.stdout.on('data', (chunk) => {
        output += chunk
        if (/\d+/.test(output)) resolve(output.trim())
      })
    }))
    track(childPid)
    await delay(150)
    assert.equal(isAlive(childPid), true)
    const stopped = runManager(cwd, ['stop'], { YANXING_PORT: port })
    assert.equal(stopped.status, 0, stopped.stderr)
    assert.equal(isAlive(childPid), false)
    killPid(parent.pid)
  })
})

test('start waits for listen and worker ready, then stop/restart replace the watchdog', async () => {
  await withFakeApp(async ({ cwd, port, track }) => {
    const started = runManager(cwd, ['start'], { YANXING_PORT: port })
    assert.equal(started.status, 0, started.stderr + started.stdout)
    const first = readState(cwd)
    assert.ok(first?.instanceToken)
    assert.ok(first.processes.web?.pid)
    assert.ok(first.processes.worker?.pid)
    assert.ok(first.processes.watchdog?.pid)
    track(first.processes.web.pid)
    track(first.processes.worker.pid)
    track(first.processes.watchdog.pid)
    assert.equal(isAlive(first.processes.watchdog.pid), true)
    const restarted = runManager(cwd, ['restart'], { YANXING_PORT: port })
    assert.equal(restarted.status, 0, restarted.stderr + restarted.stdout)
    const second = readState(cwd)
    track(second.processes.web?.pid)
    track(second.processes.worker?.pid)
    track(second.processes.watchdog?.pid)
    assert.notEqual(second.processes.watchdog.pid, first.processes.watchdog.pid)
    assert.equal(isAlive(first.processes.watchdog.pid), false)
  })
})

test('watchdog exits when the instance token no longer matches', async () => {
  await withFakeApp(async ({ cwd, port, track }) => {
    const started = runManager(cwd, ['start'], { YANXING_PORT: port })
    assert.equal(started.status, 0, started.stderr + started.stdout)
    const state = readState(cwd)
    track(state.processes.web?.pid)
    track(state.processes.worker?.pid)
    track(state.processes.watchdog?.pid)
    const watchdogPid = state.processes.watchdog.pid
    writeFileSync(path.join(cwd, 'storage', '.yanxing-app.json'), JSON.stringify({ ...state, instanceToken: 'other-token' }, null, 2))
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && isAlive(watchdogPid)) await delay(50)
    assert.equal(isAlive(watchdogPid), false)
  })
})

test('a live rotate lock is not stolen by the watchdog', async () => {
  await withFakeApp(async ({ cwd, port, track }) => {
    const started = runManager(cwd, ['start'], { YANXING_PORT: port })
    assert.equal(started.status, 0, started.stderr + started.stdout)
    const state = readState(cwd)
    track(state.processes.web?.pid)
    track(state.processes.worker?.pid)
    track(state.processes.watchdog?.pid)
    const rotateLock = path.join(cwd, 'storage', '.yanxing-log-rotate.lock')
    writeFileSync(rotateLock, process.pid + ':rotate-hold\n')
    writeFileSync(path.join(cwd, 'storage', 'logs', 'web.log'), 'x'.repeat(12 * 1024 * 1024))
    await delay(500)
    assert.equal(readFileSync(rotateLock, 'utf8').trim(), process.pid + ':rotate-hold')
    assert.equal(existsSync(path.join(cwd, 'storage', 'logs', 'web.log')), true)
  })
})

test('web that exits before listen is rolled back and does not leave a running service', async () => {
  await withFakeApp(async ({ cwd, port }) => {
    const started = runManager(cwd, ['start'], { YANXING_PORT: port, YANXING_FAKE_WEB_EXIT_MS: '200' })
    assert.notEqual(started.status, 0)
    assert.match(started.stderr + started.stdout, /启动失败|启动超时/)
    assert.equal(readState(cwd), undefined)
  })
})

test('start times out when web is slow to listen and rolls back only the new processes', async () => {
  await withFakeApp(async ({ cwd, port }) => {
    const started = runManager(cwd, ['start'], { YANXING_PORT: port, YANXING_FAKE_WEB_DELAY_MS: '5000', YANXING_START_TIMEOUT_MS: '800' })
    assert.notEqual(started.status, 0)
    assert.match(started.stderr + started.stdout, /启动超时/)
    assert.equal(readState(cwd), undefined)
  })
})

test('an occupied port is not treated as this instance becoming ready', async () => {
  await withFakeApp(async ({ cwd, port }) => {
    const occupant = createServer((_req, res) => res.end('other'))
    await new Promise((resolve) => occupant.listen(Number(port), '127.0.0.1', resolve))
    try {
      const started = runManager(cwd, ['start'], { YANXING_PORT: port, YANXING_START_TIMEOUT_MS: '800' })
      assert.notEqual(started.status, 0)
      assert.equal(readState(cwd), undefined)
    } finally {
      await new Promise((resolve) => occupant.close(resolve))
    }
  })
})

test('half-start only launches the missing worker and keeps a healthy web process', async () => {
  await withFakeApp(async ({ cwd, port, track }) => {
    const started = runManager(cwd, ['start'], { YANXING_PORT: port })
    assert.equal(started.status, 0, started.stderr + started.stdout)
    const state = readState(cwd)
    track(state.processes.web.pid)
    track(state.processes.worker.pid)
    track(state.processes.watchdog.pid)
    const webPid = state.processes.web.pid
    killPid(state.processes.worker.pid)
    killPid(state.processes.watchdog.pid)
    await delay(100)
    const again = runManager(cwd, ['start'], { YANXING_PORT: port })
    assert.equal(again.status, 0, again.stderr + again.stdout)
    const nextState = readState(cwd)
    track(nextState.processes.web.pid)
    track(nextState.processes.worker.pid)
    track(nextState.processes.watchdog.pid)
    assert.equal(nextState.processes.web.pid, webPid)
    assert.notEqual(nextState.processes.worker.pid, state.processes.worker.pid)
    assert.equal(isAlive(webPid), true)
  })
})

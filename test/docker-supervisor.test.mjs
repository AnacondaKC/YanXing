import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  defaultMigrateScript,
  defaultShutdownGraceMs,
  defaultWebHostname,
  defaultWebScript,
  defaultWorkerHeartbeatPath,
  defaultWorkerScript,
  productionModeArg,
  resolveDockerSupervisorPlan,
  runDockerSupervisor,
} from '../scripts/docker-supervisor.mjs'

const supervisorPath = fileURLToPath(new URL('../scripts/docker-supervisor.mjs', import.meta.url))
const supervisorUrl = pathToFileURL(supervisorPath).href
const missingBinary = '/no/such/yanxing-supervisor-bin'
const secretValue = 'super-secret-test-key'
const harnessShutdownTimeoutMs = 2_000
const harnessForceKillTimeoutMs = 1_000

const scripts = {
  "migrate-ok.mjs": "import { writeFileSync } from 'node:fs'\nif (process.env.YANXING_EVENT_FILE) writeFileSync(process.env.YANXING_EVENT_FILE, 'migrate\\n', { flag: 'a' })\n",
  "migrate-fail.mjs": "process.exit(3)\n",
  "migrate-hold.mjs": "import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.YANXING_PID_FILE, String(process.pid))\nif (process.env.YANXING_EVENT_FILE) writeFileSync(process.env.YANXING_EVENT_FILE, 'migrate-start\\n', { flag: 'a' })\nprocess.on('SIGTERM', () => process.exit(0))\nprocess.on('SIGINT', () => process.exit(0))\nsetInterval(() => {}, 1 << 30)\n",
  "hold.mjs": "import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.YANXING_PID_FILE, String(process.pid))\nif (process.env.YANXING_HOST_FILE) writeFileSync(process.env.YANXING_HOST_FILE, process.env.HOSTNAME || '')\nif (process.env.YANXING_HB_FILE) writeFileSync(process.env.YANXING_HB_FILE, process.env.YANXING_WORKER_HEARTBEAT_PATH || '')\nif (process.env.YANXING_EVENT_FILE && process.env.YANXING_EVENT_NAME) {\n  writeFileSync(process.env.YANXING_EVENT_FILE, process.env.YANXING_EVENT_NAME + '\\n', { flag: 'a' })\n}\nconst quit = () => process.exit(0)\nprocess.on('SIGTERM', quit)\nprocess.on('SIGINT', quit)\nsetInterval(() => {}, 1 << 30)\n",
  "exit.mjs": "import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.YANXING_PID_FILE, String(process.pid))\nsetTimeout(() => process.exit(Number(process.env.YANXING_EXIT_CODE || '0')), Number(process.env.YANXING_EXIT_MS || '80'))\n",
  "ignore-term.mjs": "import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.YANXING_PID_FILE, String(process.pid))\nprocess.on('SIGTERM', () => {\n  if (process.env.YANXING_TERM_FILE) writeFileSync(process.env.YANXING_TERM_FILE, 'term')\n})\nprocess.on('SIGINT', () => {})\nif (process.env.YANXING_READY_FILE) writeFileSync(process.env.YANXING_READY_FILE, 'ready')\nsetInterval(() => {}, 1 << 30)\n",
  "tree.mjs": "import { spawn } from 'node:child_process'\nimport { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.YANXING_PID_FILE, String(process.pid))\nconst grouped = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' })\nconst detached = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1 << 30)'], { detached: true, stdio: 'ignore' })\nwriteFileSync(process.env.YANXING_GROUP_CHILD_FILE, String(grouped.pid))\nwriteFileSync(process.env.YANXING_DETACHED_CHILD_FILE, String(detached.pid))\ndetached.unref()\nconst quit = () => process.exit(0)\nprocess.on('SIGTERM', quit)\nprocess.on('SIGINT', quit)\nsetInterval(() => {}, 1 << 30)\n",
  "late-child.mjs": "import { spawn } from 'node:child_process'\nimport { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.YANXING_PID_FILE, String(process.pid))\nprocess.on('SIGTERM', () => {\n  const child = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' })\n  writeFileSync(process.env.YANXING_LATE_CHILD_FILE, String(child.pid))\n  process.exit(0)\n})\nprocess.on('SIGINT', () => process.exit(0))\nsetInterval(() => {}, 1 << 30)\n"
}

test('default supervisor plan uses production migrate, server.js, worker, 80s grace and default heartbeat', () => {
  const plan = resolveDockerSupervisorPlan({
    cwd: '/app',
    nodePath: '/usr/bin/node',
    env: {
      PATH: '/usr/bin',
      YANXING_SHUTDOWN_GRACE_MS: '1',
      YANXING_SUPERVISOR_TIMEOUT_MS: '1',
      YANXING_SETTINGS_ENCRYPTION_KEY: secretValue,
    },
  })
  assert.equal(plan.cwd, '/app')
  assert.equal(plan.shutdownGraceMs, defaultShutdownGraceMs)
  assert.ok(defaultShutdownGraceMs < 100_000)
  assert.equal(plan.heartbeatPath, defaultWorkerHeartbeatPath)
  assert.deepEqual(plan.migrate.args, [path.resolve('/app', defaultMigrateScript), productionModeArg])
  assert.deepEqual(plan.web.args, [path.resolve('/app', defaultWebScript)])
  assert.equal(plan.web.env.HOSTNAME, defaultWebHostname)
  assert.deepEqual(plan.worker.args, [path.resolve('/app', defaultWorkerScript), productionModeArg])
  assert.equal(plan.worker.env.YANXING_WORKER_HEARTBEAT_PATH, defaultWorkerHeartbeatPath)
  assert.equal(plan.web.env.YANXING_SETTINGS_ENCRYPTION_KEY, secretValue)
  assert.equal(plan.migrate.command, '/usr/bin/node')
})

test('heartbeat path prefers options then env then default, and shutdown env backdoors are ignored', () => {
  const fromEnv = resolveDockerSupervisorPlan({
    cwd: '/app',
    env: { YANXING_WORKER_HEARTBEAT_PATH: '/custom/hb.json', YANXING_SHUTDOWN_GRACE_MS: '1' },
  })
  assert.equal(fromEnv.heartbeatPath, '/custom/hb.json')
  assert.equal(fromEnv.shutdownGraceMs, defaultShutdownGraceMs)
  const fromOptions = resolveDockerSupervisorPlan({
    cwd: '/app',
    env: { YANXING_WORKER_HEARTBEAT_PATH: '/custom/hb.json' },
    heartbeatPath: '/opt/hb.json',
    shutdownGraceMs: 250,
  })
  assert.equal(fromOptions.heartbeatPath, '/opt/hb.json')
  assert.equal(fromOptions.shutdownGraceMs, 250)
})

test('migrate runs first and both services start with web hostname and worker heartbeat', async () => {
  await withHarness(async (harness) => {
    const done = harness.start(harness.runningOptions({
      web: harness.hold('web', { YANXING_HOST_FILE: harness.file('web.host'), YANXING_EVENT_NAME: 'web' }),
      worker: harness.hold('worker', { YANXING_HB_FILE: harness.file('worker.hb'), YANXING_EVENT_NAME: 'worker' }),
    }))
    const webPid = await harness.waitPid('web')
    const workerPid = await harness.waitPid('worker')
    assert.notEqual(webPid, workerPid)
    const events = readFileSync(harness.eventFile, 'utf8').trim().split('\n')
    assert.equal(events[0], 'migrate')
    assert.ok(events.includes('web'))
    assert.ok(events.includes('worker'))
    assert.equal(readFileSync(harness.file('web.host'), 'utf8'), defaultWebHostname)
    assert.equal(readFileSync(harness.file('worker.hb'), 'utf8'), harness.heartbeatPath)
    harness.emitter.emit('SIGTERM')
    assert.equal(await done, 0)
    assertDead(webPid, 'web')
    assertDead(workerPid, 'worker')
  })
})

test('migrate failure does not start services and keeps a non-zero exit', async () => {
  await withHarness(async (harness) => {
    const code = await harness.start(harness.runningOptions({
      migrate: { args: [harness.script('migrate-fail.mjs')] },
      web: harness.hold('web'),
      worker: harness.hold('worker'),
    }))
    assert.equal(code, 3)
    assert.equal(existsSync(harness.pidFile('web')), false)
    assert.equal(existsSync(harness.pidFile('worker')), false)
  })
})

test('migrate spawn failure does not start services', async () => {
  await withHarness(async (harness) => {
    const code = await harness.start(harness.runningOptions({
      migrate: { command: missingBinary, args: [] },
      web: harness.hold('web'),
      worker: harness.hold('worker'),
    }))
    assert.equal(code, 1)
    assert.equal(existsSync(harness.pidFile('web')), false)
    assert.equal(existsSync(harness.pidFile('worker')), false)
    assert.ok(harness.logs.some((line) => line.includes('migrate spawn failed')))
  })
})

test('stale heartbeat is cleared on start even when migrate fails', async () => {
  await withHarness(async (harness) => {
    writeFileSync(harness.heartbeatPath, '{"ok":true}')
    writeFileSync(`${harness.heartbeatPath}.tmp`, '{}')
    const code = await harness.start(harness.runningOptions({
      migrate: { args: [harness.script('migrate-fail.mjs')] },
      web: harness.hold('web'),
      worker: harness.hold('worker'),
    }))
    assert.equal(code, 3)
    assert.equal(existsSync(harness.heartbeatPath), false)
    assert.equal(existsSync(`${harness.heartbeatPath}.tmp`), false)
    assert.ok(harness.logs.some((line) => line.includes('cleared stale worker heartbeat')))
  })
})

test('signal during migrate stops migrate and does not start services', async () => {
  await withHarness(async (harness) => {
    const done = harness.start(harness.runningOptions({
      migrate: {
        args: [harness.script('migrate-hold.mjs')],
        env: { YANXING_PID_FILE: harness.pidFile('migrate'), YANXING_EVENT_FILE: harness.eventFile },
      },
      web: harness.hold('web'),
      worker: harness.hold('worker'),
    }))
    const migratePid = await harness.waitPid('migrate')
    harness.emitter.emit('SIGTERM')
    assert.equal(await done, 1)
    assertDead(migratePid, 'migrate')
    assert.equal(existsSync(harness.pidFile('web')), false)
    assert.equal(existsSync(harness.pidFile('worker')), false)
    assert.ok(harness.logs.some((line) => line.includes('during migrate')))
  })
})

test('web exiting 0 stops worker and fails the supervisor', async () => {
  await withHarness(async (harness) => {
    const done = harness.start(harness.runningOptions({
      web: {
        args: [harness.script('exit.mjs')],
        env: { YANXING_PID_FILE: harness.pidFile('web'), YANXING_EXIT_CODE: '0', YANXING_EXIT_MS: '40' },
      },
      worker: harness.hold('worker'),
    }))
    const workerPid = await harness.waitPid('worker')
    assert.equal(await done, 1)
    assertDead(workerPid, 'worker')
    assert.ok(harness.logs.some((line) => /web exited \(code=0\)/.test(line)))
  })
})

test('worker abnormal exit stops web and fails the supervisor', async () => {
  await withHarness(async (harness) => {
    const done = harness.start(harness.runningOptions({
      web: harness.hold('web'),
      worker: {
        args: [harness.script('exit.mjs')],
        env: { YANXING_PID_FILE: harness.pidFile('worker'), YANXING_EXIT_CODE: '2', YANXING_EXIT_MS: '40' },
      },
    }))
    const webPid = await harness.waitPid('web')
    assert.equal(await done, 1)
    assertDead(webPid, 'web')
    assert.ok(harness.logs.some((line) => /worker exited \(code=2\)/.test(line)))
  })
})

test('web spawn failure stops worker', async () => {
  await withHarness(async (harness) => {
    const code = await harness.start(harness.runningOptions({
      web: { command: missingBinary, args: [] },
      worker: harness.hold('worker'),
    }))
    assert.equal(code, 1)
    assert.ok(harness.logs.some((line) => line.includes('web spawn failed') || /web exited/.test(line)))
    const workerPid = pidFromLogs(harness.logs, 'worker')
    if (workerPid) {
      harness.track(workerPid)
      assertDead(workerPid, 'worker')
    }
  })
})

test('worker spawn failure stops web', async () => {
  await withHarness(async (harness) => {
    const code = await harness.start(harness.runningOptions({
      web: harness.hold('web'),
      worker: { command: missingBinary, args: [] },
    }))
    assert.equal(code, 1)
    assert.ok(harness.logs.some((line) => line.includes('worker spawn failed') || /worker exited/.test(line)))
    const webPid = pidFromLogs(harness.logs, 'web')
    if (webPid) {
      harness.track(webPid)
      assertDead(webPid, 'web')
    }
  })
})

test('SIGTERM gracefully stops both services with exit 0', async () => {
  await withHarness(async (harness) => {
    const done = harness.start(harness.runningOptions({
      web: harness.hold('web'),
      worker: harness.hold('worker'),
    }))
    const webPid = await harness.waitPid('web')
    const workerPid = await harness.waitPid('worker')
    harness.emitter.emit('SIGTERM')
    assert.equal(await done, 0)
    assertDead(webPid, 'web')
    assertDead(workerPid, 'worker')
    assert.ok(harness.logs.some((line) => line.includes('received SIGTERM')))
    assert.equal(harness.logs.some((line) => line.includes('SIGKILL')), false)
  })
})

test('SIGINT gracefully stops both services with exit 0', async () => {
  await withHarness(async (harness) => {
    const done = harness.start(harness.runningOptions({
      web: harness.hold('web'),
      worker: harness.hold('worker'),
    }))
    const webPid = await harness.waitPid('web')
    const workerPid = await harness.waitPid('worker')
    harness.emitter.emit('SIGINT')
    assert.equal(await done, 0)
    assertDead(webPid, 'web')
    assertDead(workerPid, 'worker')
    assert.ok(harness.logs.some((line) => line.includes('received SIGINT')))
  })
})

test('process.once SIGTERM delayed cleanup finishes without a second TERM', async () => {
  await withHarness(async (harness) => {
    const script = harness.file('once-term.mjs')
    await writeFile(script, [
      "import { writeFileSync } from 'node:fs'",
      "import { setTimeout as delay } from 'node:timers/promises'",
      "writeFileSync(process.env.YANXING_PID_FILE, String(process.pid))",
      "process.once('SIGTERM', async () => {",
      "  await delay(Number(process.env.YANXING_CLEANUP_MS || '80'))",
      "  writeFileSync(process.env.YANXING_MARKER_FILE, 'done')",
      "  process.exit(0)",
      "})",
      "setInterval(() => {}, 1 << 30)",
      '',
    ].join('\n'))
    const service = (name) => ({
      args: [script],
      env: {
        YANXING_PID_FILE: harness.pidFile(name),
        YANXING_MARKER_FILE: harness.file(name + '.marker'),
        YANXING_CLEANUP_MS: '80',
      },
    })
    const done = harness.start(harness.runningOptions({
      shutdownGraceMs: 400,
      web: service('web'),
      worker: service('worker'),
    }))
    const webPid = await harness.waitPid('web')
    const workerPid = await harness.waitPid('worker')
    harness.emitter.emit('SIGTERM')
    assert.equal(await done, 0)
    assert.equal(readFileSync(harness.file('web.marker'), 'utf8'), 'done')
    assert.equal(readFileSync(harness.file('worker.marker'), 'utf8'), 'done')
    assertDead(webPid, 'web')
    assertDead(workerPid, 'worker')
    assert.equal(harness.logs.some((line) => line.includes('SIGKILL')), false)
  })
})

test('real SIGTERM to a supervisor process stops fixture services', async () => {
  await withHarness(async (harness) => {
    const { child, done } = await startFixtureRunner(harness)
    const webPid = await harness.waitPid('web')
    const workerPid = await harness.waitPid('worker')
    child.kill('SIGTERM')
    const status = await done
    assert.equal(status.code, 0)
    assertDead(webPid, 'web')
    assertDead(workerPid, 'worker')
    assertDead(child.pid, 'supervisor')
  })
})

test('timeout force-kills TERM-ignoring services and returns non-zero', async () => {
  await withHarness(async (harness) => {
    const done = harness.start(harness.runningOptions({
      shutdownGraceMs: 120,
      web: {
        args: [harness.script('ignore-term.mjs')],
        env: {
          YANXING_PID_FILE: harness.pidFile('web'),
          YANXING_TERM_FILE: harness.file('web.term'),
          YANXING_READY_FILE: harness.file('web.ready'),
        },
      },
      worker: {
        args: [harness.script('ignore-term.mjs')],
        env: {
          YANXING_PID_FILE: harness.pidFile('worker'),
          YANXING_TERM_FILE: harness.file('worker.term'),
          YANXING_READY_FILE: harness.file('worker.ready'),
        },
      },
    }))
    const webPid = await harness.waitPid('web')
    const workerPid = await harness.waitPid('worker')
    await waitForFile(harness.file('web.ready'))
    await waitForFile(harness.file('worker.ready'))
    const startedAt = Date.now()
    harness.emitter.emit('SIGTERM')
    assert.equal(await done, 1)
    assert.ok(Date.now() - startedAt < 3_500)
    assertDead(webPid, 'web')
    assertDead(workerPid, 'worker')
    assert.equal(readFileSync(harness.file('web.term'), 'utf8'), 'term')
    assert.ok(harness.logs.some((line) => line.includes('sending SIGKILL')))
  })
})

test('grouped and detached descendants are cleaned without leftovers', async () => {
  await withHarness(async (harness) => {
    await writeFile(harness.file('tree.mjs'), [
      "import { spawn } from 'node:child_process'",
      "import { writeFileSync } from 'node:fs'",
      "writeFileSync(process.env.YANXING_PID_FILE, String(process.pid))",
      "const childEnv = (pidFile) => ({ ...process.env, YANXING_PID_FILE: pidFile, YANXING_TERM_FILE: pidFile + '.term', YANXING_READY_FILE: pidFile + '.ready' })",
      "const grouped = spawn(process.execPath, [process.env.YANXING_IGNORE_SCRIPT], { stdio: 'ignore', env: childEnv(process.env.YANXING_GROUP_CHILD_FILE) })",
      "const detached = spawn(process.execPath, [process.env.YANXING_IGNORE_SCRIPT], { detached: true, stdio: 'ignore', env: childEnv(process.env.YANXING_DETACHED_CHILD_FILE) })",
      "detached.unref()",
      "process.on('SIGTERM', () => process.exit(0))",
      "process.on('SIGINT', () => process.exit(0))",
      "setInterval(() => {}, 1 << 30)",
      '',
    ].join('\n'))
    const done = harness.start(harness.runningOptions({
      shutdownGraceMs: 150,
      web: harness.hold('web'),
      worker: {
        args: [harness.file('tree.mjs')],
        env: {
          YANXING_PID_FILE: harness.pidFile('worker'),
          YANXING_IGNORE_SCRIPT: harness.script('ignore-term.mjs'),
          YANXING_GROUP_CHILD_FILE: harness.file('group.pid'),
          YANXING_DETACHED_CHILD_FILE: harness.file('detached.pid'),
        },
      },
    }))
    const webPid = await harness.waitPid('web')
    const workerPid = await harness.waitPid('worker')
    const groupedPid = Number(await waitForFile(harness.file('group.pid')))
    const detachedPid = Number(await waitForFile(harness.file('detached.pid')))
    await waitForFile(harness.file('group.pid.ready'))
    await waitForFile(harness.file('detached.pid.ready'))
    harness.track(groupedPid)
    harness.track(detachedPid)
    harness.emitter.emit('SIGTERM')
    const code = await done
    assertDead(webPid, 'web')
    assertDead(workerPid, 'worker')
    assertDead(groupedPid, 'grouped child')
    assertDead(detachedPid, 'detached child')
    assert.equal(code, 1)
  })
})

test('TERM handler children in the same process group are reaped', async () => {
  await withHarness(async (harness) => {
    const done = harness.start(harness.runningOptions({
      shutdownGraceMs: 200,
      web: harness.hold('web'),
      worker: {
        args: [harness.script('late-child.mjs')],
        env: {
          YANXING_PID_FILE: harness.pidFile('worker'),
          YANXING_LATE_CHILD_FILE: harness.file('late.pid'),
        },
      },
    }))
    const webPid = await harness.waitPid('web')
    const workerPid = await harness.waitPid('worker')
    harness.emitter.emit('SIGTERM')
    const latePid = Number(await waitForFile(harness.file('late.pid')))
    harness.track(latePid)
    const exitCode = await done
    // A newly forked child may receive TERM before installing its ignore handler.
    const forceKilled = harness.logs.some((line) => line.includes('sending SIGKILL'))
    assert.equal(exitCode, forceKilled ? 1 : 0)
    assertDead(webPid, 'web')
    assertDead(workerPid, 'worker')
    assertDead(latePid, 'late child')
  })
})

test('a service crash is not masked by SIGTERM during cleanup', async () => {
  await withHarness(async (harness) => {
    const done = harness.start(harness.runningOptions({
      web: harness.hold('web'),
      worker: harness.hold('worker'),
    }))
    const webPid = await harness.waitPid('web')
    const workerPid = await harness.waitPid('worker')
    process.kill(webPid, 'SIGKILL')
    await waitUntil(() => harness.logs.some((line) => line.includes('web exited')))
    harness.emitter.emit('SIGTERM')
    assert.equal(await done, 1)
    assertDead(webPid, 'web')
    assertDead(workerPid, 'worker')
  })
})

test('throwing logger does not leak started services', async () => {
  await withHarness(async (harness) => {
    const done = harness.start(harness.runningOptions({
      log: () => { throw new Error('log boom') },
      web: harness.hold('web'),
      worker: harness.hold('worker'),
    }))
    const webPid = await harness.waitPid('web')
    const workerPid = await harness.waitPid('worker')
    harness.emitter.emit('SIGTERM')
    assert.equal(await done, 0)
    assertDead(webPid, 'web')
    assertDead(workerPid, 'worker')
  })
})

test('supervisor logs do not leak secrets', async () => {
  await withHarness(async (harness) => {
    const done = harness.start(harness.runningOptions({
      web: harness.hold('web'),
      worker: harness.hold('worker'),
    }))
    await harness.waitPid('web')
    await harness.waitPid('worker')
    harness.emitter.emit('SIGTERM')
    assert.equal(await done, 0)
    const text = harness.logs.join('\n')
    assert.equal(text.includes(secretValue), false)
    assert.equal(text.includes('YANXING_SETTINGS_ENCRYPTION_KEY'), false)
  })
})

test('harness gracefully cleans services when a callback fails before manual PID tracking', async () => {
  const failure = new Error('injected assertion failure')
  let context
  let done
  const pids = []
  await assert.rejects(withHarness(async (harness) => {
    context = harness
    done = harness.start(harness.runningOptions({ web: harness.hold('web'), worker: harness.hold('worker') }))
    pids.push(Number(await waitForFile(harness.pidFile('web'))))
    pids.push(Number(await waitForFile(harness.pidFile('worker'))))
    harness.pids.clear()
    harness.logs.length = 0
    throw failure
  }), (error) => error === failure)
  assert.equal(await done, 0, 'cleanup should request graceful shutdown before force killing')
  assert.ok(context.runs.every((execution) => execution.settled))
  assert.equal(context.emitter.listenerCount('SIGTERM'), 0)
  assert.equal(existsSync(context.cwd), false)
  for (const pid of pids) assertDead(pid, 'callback failure leftover')
})

test('harness cleans migration when a callback fails before any readiness file exists', async () => {
  const failure = new Error('failed before migration readiness')
  let context
  let done
  await assert.rejects(withHarness(async (harness) => {
    context = harness
    done = harness.start(harness.runningOptions({
      migrate: { args: [harness.script('migrate-hold.mjs')], env: { YANXING_PID_FILE: harness.pidFile('migrate') } },
      web: harness.hold('web'),
      worker: harness.hold('worker'),
    }))
    throw failure
  }), (error) => error === failure)
  assert.equal(await done, 1)
  assert.ok(context.runs.every((execution) => execution.settled))
  assert.doesNotMatch(context.logs.join('\n'), /started (web|worker) pid=/)
  assert.equal(context.emitter.listenerCount('SIGTERM'), 0)
  assert.equal(existsSync(context.cwd), false)
  for (const pid of context.pids) assertDead(pid, 'migration failure leftover')
})

test('harness stops and reaps a nested supervisor runner after a callback throws', async () => {
  const failure = new Error('nested runner assertion failed')
  let context
  let execution
  const pids = []
  await assert.rejects(withHarness(async (harness) => {
    context = harness
    execution = await startFixtureRunner(harness)
    pids.push(execution.child.pid)
    pids.push(Number(await waitForFile(harness.pidFile('web'))))
    pids.push(Number(await waitForFile(harness.pidFile('worker'))))
    throw failure
  }), (error) => error === failure)
  assert.equal((await execution.done).code, 0)
  assert.ok(context.runs.every((run) => run.settled))
  assert.equal(existsSync(context.cwd), false)
  for (const pid of pids) assertDead(pid, 'nested runner leftover')
})

test('harness force kills a TERM ignoring runner within its cleanup deadline', async () => {
  const failure = new Error('TERM ignoring runner assertion failed')
  let context
  let execution
  let stoppedAt
  await assert.rejects(withHarness(async (harness) => {
    context = harness
    const script = harness.file('stubborn-runner.mjs')
    await writeFile(script, [
      "import { writeFileSync } from 'node:fs'",
      "process.on('SIGTERM', () => {})",
      'writeFileSync(' + JSON.stringify(harness.file('runner.ready')) + ', "ready")',
      'setInterval(() => {}, 1000)',
    ].join('\n'))
    execution = harness.spawnRunner(script)
    await waitForFile(harness.file('runner.ready'))
    stoppedAt = Date.now()
    throw failure
  }), (error) => error === failure)
  assert.equal((await execution.done).signal, 'SIGKILL')
  assert.ok(Date.now() - stoppedAt < harnessShutdownTimeoutMs + 2 * harnessForceKillTimeoutMs)
  assert.ok(context.runs.every((run) => run.settled))
  assertDead(execution.child.pid, 'TERM ignoring runner leftover')
  assert.equal(existsSync(context.cwd), false)
})

async function startFixtureRunner(harness) {
  const runner = harness.file('runner.mjs')
  const options = harness.runningOptions({ web: harness.hold('web'), worker: harness.hold('worker') })
  delete options.signalEmitter
  delete options.log
  await writeFile(runner, [
    'import { runDockerSupervisor } from ' + JSON.stringify(supervisorUrl),
    'process.exit(await runDockerSupervisor(' + JSON.stringify(options) + '))',
    '',
  ].join('\n'))
  return harness.spawnRunner(runner)
}

async function withHarness(run) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'yanxing-supervisor-'))
  const harness = createHarness(cwd)
  const failures = []
  try {
    for (const [name, body] of Object.entries(scripts)) {
      await writeFile(path.join(cwd, name), body)
    }
    await run(harness)
  } catch (error) {
    failures.push(error)
  } finally {
    try {
      await cleanupHarness(harness)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Test and harness cleanup both failed')
}

function createHarness(cwd) {
  const pids = new Set()
  const harness = {
    cwd,
    logs: [],
    runs: [],
    start(options) {
      const signalEmitter = options.signalEmitter ?? harness.emitter
      const done = runDockerSupervisor({
        ...options,
        signalEmitter,
        log(line) {
          const match = line.match(/started \w+ pid=(\d+)/)
          if (match) harness.track(Number(match[1]))
          if (options.log) options.log(line)
          else harness.logs.push(line)
        },
      })
      return registerRun(harness, { done, stop: () => signalEmitter.emit('SIGTERM') })
    },
    spawnRunner(script) {
      const child = spawn(process.execPath, [script], { cwd, detached: true, stdio: 'ignore' })
      harness.track(child.pid)
      const done = registerRun(harness, { child, done: waitForChild(child), stop: () => child.kill('SIGTERM') })
      return { child, done }
    },
    pids,
    emitter: new EventEmitter(),
    heartbeatPath: path.join(cwd, 'heartbeat.json'),
    eventFile: path.join(cwd, 'events.log'),
    file: (name) => path.join(cwd, name),
    script: (name) => path.join(cwd, name),
    pidFile: (name) => path.join(cwd, `${name}.pid`),
    track(pid) {
      if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) pids.add(pid)
    },
    async waitPid(name) {
      const pid = Number(await waitForFile(path.join(cwd, `${name}.pid`)))
      harness.track(pid)
      return pid
    },
    hold(name, extraEnv = {}) {
      return {
        args: [path.join(cwd, 'hold.mjs')],
        env: {
          YANXING_PID_FILE: path.join(cwd, `${name}.pid`),
          YANXING_EVENT_FILE: path.join(cwd, 'events.log'),
          ...extraEnv,
        },
      }
    },
    runningOptions(overrides) {
      return {
        cwd,
        stdio: 'ignore',
        log: (line) => harness.logs.push(line),
        signalEmitter: harness.emitter,
        shutdownGraceMs: 400,
        heartbeatPath: harness.heartbeatPath,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: cwd,
          YANXING_EVENT_FILE: harness.eventFile,
          YANXING_SETTINGS_ENCRYPTION_KEY: secretValue,
          YANXING_SHUTDOWN_GRACE_MS: '1',
          YANXING_SUPERVISOR_TIMEOUT_MS: '1',
        },
        migrate: { args: [path.join(cwd, 'migrate-ok.mjs')] },
        ...overrides,
      }
    },
  }
  return harness
}

function registerRun(harness, execution) {
  const record = { ...execution, settled: false }
  harness.runs.push(record)
  void record.done.then(
    () => { record.settled = true },
    () => { record.settled = true },
  )
  return record.done
}

async function cleanupHarness(harness) {
  try {
    collectHarnessPids(harness)
    for (const execution of harness.runs) {
      try { execution.stop() } catch { /* Force-kill remains the fallback. */ }
    }
    await waitForRuns(harness.runs, harnessShutdownTimeoutMs)
    collectHarnessPids(harness)
    for (const pid of harness.pids) emergencyKill(pid)
    await waitForRuns(harness.runs, harnessForceKillTimeoutMs)
    await waitUntil(
      () => harness.runs.every((execution) => execution.settled) && [...harness.pids].every((pid) => !isAlive(pid)),
      harnessForceKillTimeoutMs,
    )
  } finally {
    for (const { child } of harness.runs) {
      child?.unref()
      for (const stream of [child?.stdin, child?.stdout, child?.stderr]) stream?.destroy()
    }
    await rm(harness.cwd, { recursive: true, force: true })
  }
}

function collectHarnessPids(harness) {
  for (const match of harness.logs.join('\n').matchAll(/started \w+ pid=(\d+)/g)) harness.track(Number(match[1]))
  let names = []
  try { names = readdirSync(harness.cwd) } catch { /* Cleanup must still stop registered processes. */ }
  for (const name of names) {
    if (!name.endsWith('.pid')) continue
    try { harness.track(Number(readFileSync(harness.file(name), 'utf8').trim())) } catch { /* PID files are best-effort fallback only. */ }
  }
  for (const pid of collectDescendantPids(harness.pids)) harness.track(pid)
}

async function waitForRuns(runs, timeoutMs) {
  let timer
  try {
    await Promise.race([
      Promise.allSettled(runs.map((execution) => execution.done)),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function pidFromLogs(logs, name) {
  const match = logs.join('\n').match(new RegExp(`started ${name} pid=(\\d+)`))
  return match ? Number(match[1]) : undefined
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}

async function waitForFile(file, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const content = readFileSync(file, 'utf8').trim()
      if (content) return content
    }
    await delay(20)
  }
  throw new Error(`timed out waiting for ${file}`)
}

async function waitUntil(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(20)
  }
  throw new Error('timed out waiting for condition')
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
  } catch (error) {
    return Boolean(error) && error.code === 'EPERM'
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
  } catch {
    return false
  }
}

function assertDead(pid, label) {
  assert.equal(isAlive(pid), false, `${label} pid ${pid} still alive`)
}

function emergencyKill(pid) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return
  const owned = collectDescendantPids(new Set([pid]))
  // Snapshot descendants before killing parents so reparenting cannot hide them.
  for (const child of [...owned].reverse()) {
    try { process.kill(-child, 'SIGKILL') } catch {}
    try { process.kill(child, 'SIGKILL') } catch {}
  }
}

function collectDescendantPids(roots) {
  const owned = new Set(roots)
  const processes = []
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^[0-9]+$/.test(entry)) continue
      const pid = Number(entry)
      if (pid <= 1 || pid === process.pid) continue
      try {
        const stat = readFileSync('/proc/' + pid + '/stat', 'utf8')
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        processes.push({ pid, ppid: Number(fields[1]), pgid: Number(fields[2]) })
      } catch {}
    }
  } catch {}
  let previousSize
  do {
    previousSize = owned.size
    for (const { pid, ppid, pgid } of processes) {
      if (owned.has(ppid) || owned.has(pgid)) owned.add(pid)
    }
  } while (owned.size !== previousSize)
  return owned
}

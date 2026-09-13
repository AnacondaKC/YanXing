import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  SUPERVISOR_ARGV,
  WEB_ARGV,
  WORKER_ARGV,
  isSupervisor,
  isWeb,
  isWorker,
  listProcRoles,
  readProcArgv,
  readProcPpid,
} from '../scripts/proc-role-scan.mjs'

const NODE_IMAGE = 'node:24.20.0-bookworm-slim'
const APP_IMAGE = process.env.YANXING_TEST_IMAGE ?? 'yanxing:p5-qa-isolated'
const RECOVERY_WAIT_MS = 180_000
const runContainerTests = process.env.YANXING_PROC_ROLE_DOCKER_TESTS === '1'
const helperSource = await readFile(new URL('../scripts/proc-role-scan.mjs', import.meta.url), 'utf8')
const shellSource = await readFile(new URL('../scripts/test-docker.sh', import.meta.url), 'utf8')
const p5Source = await readFile(new URL('../scripts/p5-package-container.mjs', import.meta.url), 'utf8')
const assembleSource = await readFile(new URL('../scripts/assemble-docker-runtime.mjs', import.meta.url), 'utf8')
const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8')
const shellScript = helperSource + '\n' + extractBlock(shellSource, 'const role = process.env.YANXING_SMOKE_PROC_ROLE', '\nEOF\n')
const p5Script = helperSource + extractP5Glue(p5Source)

test('role matchers keep argv path and next-server title rules', () => {
  assert.equal(isSupervisor([process.execPath, SUPERVISOR_ARGV]), true)
  assert.equal(isSupervisor([process.execPath, WEB_ARGV]), false)
  assert.equal(isWeb([process.execPath, WEB_ARGV]), true)
  assert.equal(isWeb(['next-server (v16.3.2)']), true)
  assert.equal(isWeb([' next-server (v9.0.0) ']), true)
  assert.equal(isWeb(['next-server']), false)
  assert.equal(isWeb([process.execPath, WORKER_ARGV]), false)
  assert.equal(isWorker([process.execPath, WORKER_ARGV]), true)
  assert.equal(isWorker([process.execPath, WEB_ARGV]), false)
})

test('host /proc reads ppid, skips pid 1 and self, and classifies a child web', { skip: process.platform !== 'linux' }, async () => {
  assert.equal(readProcPpid(process.pid), process.ppid)
  assert.ok(readProcArgv(process.pid).length > 0)
  const listed = listProcRoles()
  assert.equal(listed.some((proc) => proc.pid <= 1), false)
  assert.equal(listed.some((proc) => proc.pid === process.pid), false)
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', WEB_ARGV], { stdio: 'ignore' })
  try {
    const found = await waitFor(() => listProcRoles().find((proc) => proc.pid === child.pid))
    assert.equal(found.web, true)
    assert.equal(found.worker, false)
    assert.equal(found.supervisor, false)
    assert.equal(found.ppid, process.pid)
  } finally {
    child.kill('SIGKILL')
  }
})

test('helper stays off the runtime whitelist and is only host-injected', () => {
  assert.doesNotMatch(assembleSource, /proc-role-scan/)
  assert.match(dockerfile, /COPY --from=build --chown=root:root \/app\/\.docker-runtime \.\//)
  assert.match(shellSource, /cat "\$root\/scripts\/proc-role-scan\.mjs"/)
  assert.match(shellSource, /node --input-type=module -e "\$PROC_SCAN_JS"/)
  assert.match(shellSource, /YANXING_SMOKE_PROC_ROLE/)
  assert.match(shellSource, /YANXING_SMOKE_PROC_ACTION/)
  assert.match(shellSource, /process\.kill\(pid, "SIGKILL"\)/)
  assert.match(shellSource, /supervisorPids\.size === 0/)
  assert.doesNotMatch(shellSource, /\bsed\b/)
  assert.match(p5Source, /proc-role-scan\.mjs/)
  assert.match(p5Source, /'node', '--input-type=module', '-e', script/)
  const p5Fn = p5Source.slice(p5Source.indexOf('async function listRolePids'), p5Source.indexOf('function assertFreshBoot'))
  assert.match(p5Fn, /listProcRoles\(\)/)
  assert.match(p5Fn, /JSON\.stringify\(out\)/)
  assert.doesNotMatch(p5Fn, /isUnderSupervisor|supervisorPids/)
})

test('isolated container scan keeps shell ancestor/kill protocol and p5 three-class JSON', { timeout: 25_000, skip: !runContainerTests }, async () => {
  await withContainer(['sleep', '180'], async (name) => {
    const tree = await startSupervisorTree(name)
    const outsider = await startHold(name, '/tmp/m08-outsider.json', WEB_ARGV)
    const titled = await startTitledWeb(name)
    const p5 = parseP5(inject(name, p5Script))
    assert.deepEqual(p5.supervisor, [tree.supervisor])
    assert.deepEqual(new Set(p5.web), new Set([tree.web, outsider.pid, titled.pid]))
    assert.deepEqual(p5.worker, [tree.worker])
    assert.deepEqual(pidLines(inject(name, shellScript, { YANXING_SMOKE_PROC_ROLE: 'web', YANXING_SMOKE_PROC_ACTION: 'list' })), [tree.web])
    assert.deepEqual(pidLines(inject(name, shellScript, { YANXING_SMOKE_PROC_ROLE: 'worker', YANXING_SMOKE_PROC_ACTION: 'list' })), [tree.worker])

    const selfScan = inject(name, helperSource + '\n' + [
      'const listed = listProcRoles()',
      'process.stdout.write(JSON.stringify({',
      '  self: process.pid,',
      '  pids: listed.map((proc) => proc.pid),',
      '  workers: listed.filter((proc) => proc.worker).map((proc) => proc.pid),',
      '}))',
    ].join('\n'), {}, [WORKER_ARGV])
    assert.equal(selfScan.status, 0, selfScan.stderr)
    const selfResult = JSON.parse(selfScan.stdout)
    assert.equal(selfResult.pids.includes(selfResult.self), false)
    assert.equal(selfResult.workers.includes(selfResult.self), false)
    assert.ok(selfResult.workers.includes(tree.worker))

    const race = inject(name, helperSource + '\n' + [
      "import { spawn } from 'node:child_process'",
      'for (let i = 0; i < 25; i++) {',
      '  spawn(process.execPath, [\'-e\', \'process.exit(0)\', ' + JSON.stringify(WORKER_ARGV) + '], { stdio: \'ignore\' })',
      '}',
      'process.stdout.write(JSON.stringify(listProcRoles().map((proc) => proc.pid)))',
    ].join('\n'))
    assert.equal(race.status, 0, race.stderr)
    JSON.parse(race.stdout)

    const killed = inject(name, shellScript, { YANXING_SMOKE_PROC_ROLE: 'worker', YANXING_SMOKE_PROC_ACTION: 'kill' })
    assert.equal(killed.status, 0, killed.stderr)
    assert.deepEqual(pidLines(killed), [tree.worker])
    assert.equal(alive(name, tree.worker), false)
    const emptyKill = inject(name, shellScript, { YANXING_SMOKE_PROC_ROLE: 'worker', YANXING_SMOKE_PROC_ACTION: 'kill' })
    assert.equal(emptyKill.status, 1)
    assert.match(emptyKill.stderr, /no process matching worker/)
    assert.equal(emptyKill.stdout, '')
  })
})

test('shell lists unmatched roles when no supervisor exists, and skips pid 1', { timeout: 25_000, skip: !runContainerTests }, async () => {
  await withContainer(['sleep', '180'], async (name) => {
    const web = await startHold(name, '/tmp/m08-nosup-web.json', WEB_ARGV)
    assert.deepEqual(pidLines(inject(name, shellScript, { YANXING_SMOKE_PROC_ROLE: 'web', YANXING_SMOKE_PROC_ACTION: 'list' })), [web.pid])
    assert.deepEqual(parseP5(inject(name, p5Script)).web, [web.pid])
  })
  await withContainer(['node', '--input-type=module', '-e', 'setInterval(() => {}, 1e6)', WEB_ARGV], async (name) => {
    const p5 = parseP5(inject(name, p5Script))
    assert.deepEqual(p5.web, [])
    assert.equal(p5.web.includes(1), false)
    const web = await startHold(name, '/tmp/m08-pid1-web.json', WEB_ARGV)
    const listed = parseP5(inject(name, p5Script)).web
    assert.deepEqual(listed, [web.pid])
    assert.equal(listed.includes(1), false)
  })
})

test('isolated app image recovers healthy after helper kills worker then web', { timeout: 400_000, skip: !runContainerTests }, async () => {
  await withAppContainer(async (name) => {
    const boot = await waitHealthy(name)
    const worker = await recoverFromKilledService(name, 'worker')
    const web = await recoverFromKilledService(name, 'web')
    const evidence = { container: name, image: APP_IMAGE, boot, worker, web }
    console.log('M08_RECOVERY_EVIDENCE ' + JSON.stringify(evidence))
    assert.ok(worker.after.restartCount > boot.restartCount || worker.after.startedAt !== boot.startedAt)
    assert.ok(web.after.restartCount > worker.after.restartCount || web.after.startedAt !== worker.after.startedAt)
    assert.equal(boot.health, 'healthy')
    assert.equal(worker.after.health, 'healthy')
    assert.equal(web.after.health, 'healthy')
  })
})

function extractBlock(source, startToken, endToken) {
  const start = source.indexOf(startToken)
  const end = source.indexOf(endToken, start)
  assert.ok(start >= 0 && end > start, 'missing block ' + startToken)
  return source.slice(start, end)
}

function extractP5Glue(source) {
  const token = 'const script = helper + `'
  const start = source.indexOf(token)
  assert.ok(start >= 0, 'p5 helper glue missing')
  const bodyStart = start + token.length
  const end = source.indexOf('`', bodyStart)
  assert.ok(end > bodyStart, 'p5 helper glue unterminated')
  return source.slice(bodyStart, end)
}

async function withContainer(args, fn) {
  const inspect = spawnSync('docker', ['image', 'inspect', NODE_IMAGE], { encoding: 'utf8', timeout: 8000 })
  if (inspect.status !== 0) {
    throw new Error('M08 real-container gate needs local ' + NODE_IMAGE + ' (no pull): ' + (inspect.stderr || inspect.stdout))
  }
  const name = 'yanxing-m08-proc-' + process.pid + '-' + Date.now() + '-' + randomBytes(4).toString('hex')
  const run = spawnSync('docker', [
    'run', '-d',
    '--pull=never',
    '--name', name,
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=32m',
    '--entrypoint', args[0],
    NODE_IMAGE,
    ...args.slice(1),
  ], { encoding: 'utf8', timeout: 20000 })
  if (run.status !== 0) {
    spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', timeout: 10000 })
    throw new Error('docker run failed: ' + (run.stderr || run.stdout))
  }
  try {
    await waitFor(() => spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', name], { encoding: 'utf8', timeout: 5000 }).stdout.trim() === 'true')
    return await fn(name)
  } finally {
    spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', timeout: 15000 })
  }
}

async function startSupervisorTree(name) {
  const start = inject(name, [
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    'function hold(arg) {',
    "  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', arg], { stdio: 'ignore' })",
    '}',
    'const web = hold(' + JSON.stringify(WEB_ARGV) + ')',
    'const worker = hold(' + JSON.stringify(WORKER_ARGV) + ')',
    "writeFileSync('/tmp/m08-tree.json', JSON.stringify({ supervisor: process.pid, web: web.pid, worker: worker.pid }))",
    'setInterval(() => {}, 1e6)',
  ].join('\n'), {}, [SUPERVISOR_ARGV], true)
  assert.equal(start.status, 0, start.stderr)
  return readJson(name, '/tmp/m08-tree.json')
}

async function startHold(name, file, extraArg) {
  const start = inject(name, [
    "import { writeFileSync } from 'node:fs'",
    'writeFileSync(' + JSON.stringify(file) + ', JSON.stringify({ pid: process.pid }))',
    'setInterval(() => {}, 1e6)',
  ].join('\n'), {}, [extraArg], true)
  assert.equal(start.status, 0, start.stderr)
  return readJson(name, file)
}

async function startTitledWeb(name) {
  const start = inject(name, [
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], {",
    "  argv0: 'next-server (v16.3.2)',",
    "  stdio: 'ignore',",
    '})',
    "writeFileSync('/tmp/m08-titled.json', JSON.stringify({ pid: child.pid }))",
    'setInterval(() => {}, 1e6)',
  ].join('\n'), {}, [], true)
  assert.equal(start.status, 0, start.stderr)
  return readJson(name, '/tmp/m08-titled.json')
}

function inject(name, script, env = {}, extraArgs = [], detached = false) {
  const args = ['exec']
  if (detached) args.push('-d')
  for (const [key, value] of Object.entries(env)) args.push('-e', key + '=' + value)
  args.push(name, 'node', '--input-type=module', '-e', script, ...extraArgs)
  return spawnSync('docker', args, { encoding: 'utf8', timeout: 12000 })
}

async function readJson(name, file) {
  return waitFor(() => {
    const result = inject(name, [
      "import { readFileSync } from 'node:fs'",
      'process.stdout.write(readFileSync(' + JSON.stringify(file) + ", 'utf8'))",
    ].join('\n'))
    if (result.status !== 0) return null
    return JSON.parse(result.stdout)
  })
}

function parseP5(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const parsed = JSON.parse(result.stdout)
  assert.deepEqual(Object.keys(parsed).sort(), ['supervisor', 'web', 'worker'])
  return parsed
}

function pidLines(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.split('\n').filter(Boolean).map(Number)
}

function alive(name, pid) {
  const result = inject(name, [
    'try { process.kill(' + Number(pid) + ', 0); process.stdout.write(\'1\') }',
    "catch { process.stdout.write('0') }",
  ].join('\n'))
  assert.equal(result.status, 0, result.stderr)
  return result.stdout === '1'
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await predicate()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw lastError ?? new Error('timed out')
}

async function withAppContainer(fn) {
  const inspect = spawnSync('docker', ['image', 'inspect', APP_IMAGE], { encoding: 'utf8', timeout: 8000 })
  if (inspect.status !== 0) {
    throw new Error('M08 recovery gate needs local ' + APP_IMAGE + ' (no pull/build): ' + (inspect.stderr || inspect.stdout))
  }
  const name = 'yanxing-m08-recover-' + process.pid + '-' + Date.now() + '-' + randomBytes(4).toString('hex')
  const key = randomBytes(32).toString('hex')
  const run = spawnSync('docker', [
    'run', '-d',
    '--pull=never',
    '--name', name,
    '--restart=unless-stopped',
    '--init',
    '--read-only',
    '--network', 'none',
    '--user', '1000:1000',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
    '--tmpfs', '/app/storage:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=1777',
    '--tmpfs', '/app/.next/cache:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=1777',
    '--tmpfs', '/app/.next-p5-qa/cache:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=1777',
    '-e', 'NODE_ENV=production',
    '-e', 'REPORT_MAX_UPLOAD_BYTES=26214400',
    '-e', 'YANXING_WORKER_CONCURRENCY=1',
    '-e', 'YANXING_WORKER_MAX_ATTEMPTS=1',
    '-e', 'YANXING_SETTINGS_ENCRYPTION_KEY=' + key,
    APP_IMAGE,
  ], { encoding: 'utf8', timeout: 20000 })
  if (run.status !== 0) {
    spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', timeout: 15000 })
    throw new Error('docker run failed: ' + (run.stderr || run.stdout))
  }
  try {
    return await fn(name)
  } finally {
    spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', timeout: 20000 })
  }
}

async function recoverFromKilledService(name, role) {
  const before = inspectApp(name)
  const pidsBefore = pidLines(inject(name, shellScript, {
    YANXING_SMOKE_PROC_ROLE: role,
    YANXING_SMOKE_PROC_ACTION: 'list',
  }))
  assert.ok(pidsBefore.length > 0, role + ' was not running before kill')
  const p5Before = parseP5(inject(name, p5Script))
  inject(name, shellScript, {
    YANXING_SMOKE_PROC_ROLE: role,
    YANXING_SMOKE_PROC_ACTION: 'kill',
  })
  await waitRestart(name, before.restartCount, before.startedAt)
  const after = await waitHealthy(name)
  const pidsAfter = pidLines(inject(name, shellScript, {
    YANXING_SMOKE_PROC_ROLE: role,
    YANXING_SMOKE_PROC_ACTION: 'list',
  }))
  assert.ok(pidsAfter.length > 0, role + ' was not running after recovery')
  assert.ok(
    after.restartCount > before.restartCount || after.startedAt !== before.startedAt,
    role + ' kill did not restart the container: ' + JSON.stringify({ before, after, pidsBefore, pidsAfter }),
  )
  const p5After = parseP5(inject(name, p5Script))
  assert.ok(p5After.supervisor.length > 0, 'supervisor missing after ' + role + ' recovery')
  assert.ok(p5After.web.length > 0, 'web missing after ' + role + ' recovery')
  assert.ok(p5After.worker.length > 0, 'worker missing after ' + role + ' recovery')
  return {
    role,
    before,
    after,
    pidsBefore,
    pidsAfter,
    p5Before,
    p5After,
  }
}

function inspectApp(name) {
  const result = spawnSync('docker', [
    'inspect',
    '--format',
    '{{.RestartCount}}|{{.State.StartedAt}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}',
    name,
  ], { encoding: 'utf8', timeout: 8000 })
  if (result.status !== 0) throw new Error('inspect failed: ' + (result.stderr || result.stdout))
  const [restartCount, startedAt, status, health = ''] = result.stdout.trim().split('|')
  return { restartCount: Number(restartCount), startedAt, status, health }
}

async function waitHealthy(name) {
  const deadline = Date.now() + RECOVERY_WAIT_MS
  let last
  while (Date.now() < deadline) {
    try {
      last = inspectApp(name)
      if (last.health === 'healthy') return last
    } catch (error) {
      last = { error: error instanceof Error ? error.message : String(error) }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  const logs = spawnSync('docker', ['logs', '--tail', '40', name], { encoding: 'utf8', timeout: 8000 })
  throw new Error('timed out waiting for healthy ' + name + ' last=' + JSON.stringify(last) + '\n' + (logs.stdout || '') + (logs.stderr || ''))
}

async function waitRestart(name, previousCount, previousStarted) {
  const deadline = Date.now() + RECOVERY_WAIT_MS
  let last
  while (Date.now() < deadline) {
    try {
      last = inspectApp(name)
      if (Number.isFinite(last.restartCount) && last.restartCount > previousCount) return last
      if (last.startedAt && last.startedAt !== previousStarted) return last
    } catch (error) {
      last = { error: error instanceof Error ? error.message : String(error) }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  const logs = spawnSync('docker', ['logs', '--tail', '40', name], { encoding: 'utf8', timeout: 8000 })
  throw new Error('container did not restart after kill ' + name + ' last=' + JSON.stringify(last) + '\n' + (logs.stdout || '') + (logs.stderr || ''))
}

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Local production smoke only; Docker permissions/dependency pruning still need test-docker.sh.
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const workspace = await mkdtemp(path.join(tmpdir(), 'yanxing-production-'))
const modulesRoot = process.env.YANXING_SMOKE_NODE_MODULES ?? path.join(projectRoot, 'node_modules')
const password = randomBytes(24).toString('hex')
const children = new Set()
const logs = []
let stopping = false

function start(args, extraEnv = {}) {
  if (stopping) throw new Error('Production smoke was interrupted')
  const child = spawn(process.execPath, args, {
    cwd: workspace,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      TSX_TSCONFIG_PATH: path.join(workspace, 'tsconfig.json'),
      YANXING_DATABASE_PATH: path.join(workspace, 'storage/yanxing.sqlite'),
      YANXING_KNOWLEDGE_STORAGE_ROOT: path.join(workspace, 'storage/knowledge'),
      YANXING_SETTINGS_ENCRYPTION_KEY: 'isolated-production-smoke-' + password,
      YANXING_WORKER_HEARTBEAT_PATH: path.join(workspace, 'worker-heartbeat.json'),
      YANXING_WORKER_MAX_ATTEMPTS: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  for (const output of [child.stdout, child.stderr]) {
    output.on('data', (chunk) => {
      logs.push(chunk.toString())
      if (logs.length > 500) logs.shift()
    })
  }
  child.completion = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      children.delete(child)
      if (code === 0 || stopping) resolve()
      else reject(new Error('Child exited: ' + args.join(' ') + ' (' + (signal ?? code) + ')'))
    })
  })
  // Long-running services may fail before we await their completion during cleanup.
  child.completion.catch(() => {})
  return child
}

async function run(args, extraEnv) {
  await start(args, extraEnv).completion
}

async function reservePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function waitForWeb(url, web) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (web.exitCode !== null || web.signalCode !== null) throw new Error('Web exited during startup')
    try {
      const response = await fetch(url + '/api/health', { signal: AbortSignal.timeout(1_000) })
      if (response.status === 200 && (await response.json()).status === 'ok') return
    } catch { /* Startup may still be in progress. */ }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Web readiness timed out')
}

async function stopChildren() {
  stopping = true
  const active = [...children]
  for (const child of active) child.kill('SIGTERM')
  const force = setTimeout(() => {
    for (const child of active) if (children.has(child)) child.kill('SIGKILL')
  }, 15_000)
  try {
    await Promise.allSettled(active.map((child) => child.completion))
  } finally {
    clearTimeout(force)
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void stopChildren().finally(() => { process.exitCode = 1 }) })
}

try {
  for (const item of ['.next', 'public', 'lib', 'modules', 'worker', 'scripts', 'package.json', 'next.config.mjs', 'tsconfig.json', 'tsconfig.source.json']) {
    await cp(path.join(projectRoot, item), path.join(workspace, item), { recursive: true })
  }
  await symlink(modulesRoot, path.join(workspace, 'node_modules'), 'dir')
  await run(['--import', 'tsx', 'scripts/migrate.ts', '--mode=production'])
  await run(['--import', 'tsx', 'scripts/create-user.ts', '--mode=production'], { YANXING_ADMIN_PASSWORD: password })
  const port = await reservePort()
  const baseUrl = 'http://127.0.0.1:' + port
  const web = start([path.join(workspace, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)])
  start(['--import', 'tsx', 'worker/index.ts', '--mode=production'])
  await waitForWeb(baseUrl, web)
  const smokeEnv = { YANXING_SMOKE_ALLOW_MUTATIONS: 'true', YANXING_SMOKE_PASSWORD: password, YANXING_SMOKE_BASE_URL: baseUrl }
  await run(['scripts/deployment-smoke.mjs'], smokeEnv)
  await run(['scripts/deployment-smoke.mjs', '--verify'], smokeEnv)
  await run(['scripts/docker-healthcheck.mjs', 'worker'])
  console.log('Local production smoke passed: HTTP upload/parsing, worker consumption, stored report verification and heartbeat.')
} catch (error) {
  console.error(logs.join(''))
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  await stopChildren()
  await rm(workspace, { recursive: true, force: true })
}

import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { defaultP5CandidateRoot, P5_ISOLATED_IMAGE, P5_NEXT_DIST_DIR } from './p5-package.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
export const P5_ISOLATED_CONTAINER_PREFIX = 'yanxing-p5-qa-isolated'
export const P5_OWNER_LABEL = 'yanxing.p5.owner'
export const P5_SECRET_ENV_NAMES = [
  'YANXING_SETTINGS_ENCRYPTION_KEY',
  'YANXING_CHAT_COMPLETIONS_API_KEY',
  'YANXING_ADMIN_PASSWORD',
]
export const DOCKER_TIMEOUT_MS = {
  build: 480_000,
  run: 120_000,
  exec: 30_000,
  stop: 130_000,
  rm: 30_000,
  inspect: 15_000,
  logs: 15_000,
  image: 15_000,
  ps: 15_000,
}
const defaultUploadLimit = String(25 * 1024 * 1024)
const supervisorArgv = '/app/scripts/docker-supervisor.mjs'
const webArgv = '/app/server.js'
const workerArgv = '/app/.runtime/worker/index.mjs'
const legacyRefusalPattern = /数据库迁移失败|当前数据库属于旧版报告结构|LEGACY_DATABASE/
const rememberedSecrets = new Set()
export const P5_CONTAINER_HELP = "Usage: node scripts/p5-package-container.mjs [options]\n\nBuild and verify an isolated P5 container from an assembled candidate.\nDoes not use latest, existing volumes, or live containers.\n\n  --candidate-root <path>  Assembled candidate directory\n  --image-tag <tag>        Isolated image tag (must not be latest)\n  --report-path <path>     Acceptance JSON output path\n  --help, -h               Show this help\n"

export function rememberSecret(value) {
  if (typeof value === 'string' && value.length >= 8) rememberedSecrets.add(value)
}

export function resetRememberedSecrets() {
  rememberedSecrets.clear()
}

export function redactDockerText(text) {
  let redacted = String(text ?? '')
  for (const name of P5_SECRET_ENV_NAMES) {
    redacted = redacted.replaceAll(new RegExp('(' + name + '=)\\S+', 'g'), '$1[redacted]')
  }
  for (const secret of rememberedSecrets) {
    redacted = redacted.split(secret).join('[redacted]')
  }
  return redacted
}

export function formatDockerCommand(args) {
  return args.map((arg, index) => {
    if (index > 0 && args[index - 1] === '-e') {
      const separator = arg.indexOf('=')
      if (separator > 0 && P5_SECRET_ENV_NAMES.includes(arg.slice(0, separator))) {
        return arg.slice(0, separator + 1) + '[redacted]'
      }
    }
    return redactDockerText(arg)
  }).join(' ')
}

export function formatDockerFailure({ args, status, stdout, stderr, timedOut }) {
  const command = formatDockerCommand(args)
  const detail = redactDockerText(stderr || stdout || '')
  if (timedOut) return 'docker ' + command + ' timed out: ' + detail
  return 'docker ' + command + ' failed (' + status + '): ' + detail
}

export function timeoutForDockerArgs(args) {
  const verb = args[0]
  if (verb === 'build') return DOCKER_TIMEOUT_MS.build
  if (verb === 'run') return DOCKER_TIMEOUT_MS.run
  if (verb === 'exec') return DOCKER_TIMEOUT_MS.exec
  if (verb === 'stop') return DOCKER_TIMEOUT_MS.stop
  if (verb === 'rm') return DOCKER_TIMEOUT_MS.rm
  if (verb === 'logs') return DOCKER_TIMEOUT_MS.logs
  if (verb === 'inspect' || verb === 'image') return DOCKER_TIMEOUT_MS.inspect
  if (verb === 'ps') return DOCKER_TIMEOUT_MS.ps
  return DOCKER_TIMEOUT_MS.inspect
}

export function parseP5ContainerArguments(argv) {
  const options = { help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--candidate-root' || arg === '--image-tag' || arg === '--report-path') {
      const value = argv[index + 1]
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
        throw new Error(arg + ' requires a value')
      }
      index += 1
      if (arg === '--candidate-root') options.candidateRoot = value
      if (arg === '--image-tag') options.imageTag = value
      if (arg === '--report-path') options.reportPath = value
      continue
    }
    throw new Error('Unknown argument: ' + arg)
  }
  if (options.help) return options
  if (options.imageTag) assertIsolatedImageTag(options.imageTag)
  return options
}

export function assertIsolatedImageTag(imageTag) {
  if (typeof imageTag !== 'string' || imageTag.trim() === '') {
    throw new Error('Isolated P5 image tag is required')
  }
  if (imageTag === 'latest' || imageTag.endsWith(':latest')) {
    throw new Error('Isolated P5 image tag must not be latest')
  }
  return imageTag
}

export function createP5OwnerId() {
  return 'p5-' + process.pid + '-' + Date.now() + '-' + randomBytes(4).toString('hex')
}

export function registerOwnedContainer(createdContainers, containerName) {
  if (!createdContainers.includes(containerName)) createdContainers.push(containerName)
  return containerName
}

export async function hashDatabaseArtifact(databasePath) {
  const hash = createHash('sha256')
  for (const filePath of [databasePath, databasePath + '-wal', databasePath + '-shm']) {
    if (!existsSync(filePath)) continue
    hash.update(path.basename(filePath))
    hash.update(await readFile(filePath))
  }
  return hash.digest('hex')
}

export async function verifyP5IsolatedContainer({
  candidateRoot = defaultP5CandidateRoot(projectRoot),
  imageTag = P5_ISOLATED_IMAGE,
  nodeImage = 'node:24.20.0-bookworm-slim',
} = {}) {
  assertIsolatedImageTag(imageTag)
  const ownerId = createP5OwnerId()
  const stamp = Date.now() + '-' + process.pid
  const bootName = P5_ISOLATED_CONTAINER_PREFIX + '-boot-' + stamp
  const legacyName = P5_ISOLATED_CONTAINER_PREFIX + '-legacy-' + stamp
  const createdContainers = []
  const disposableRoots = []
  const result = {
    candidateRoot,
    imageTag,
    imageId: null,
    nodeImage,
    ownerId,
    boot: null,
    legacy: null,
    limitations: [],
  }
  try {
    await docker(['image', 'inspect', nodeImage])
    const build = await docker([
      'build',
      '-t', imageTag,
      '-f', path.join(candidateRoot, 'Dockerfile'),
      candidateRoot,
    ])
    result.buildLogTail = tail(redactDockerText(build.stdout), 20)
    const inspect = await docker(['image', 'inspect', imageTag, '--format', '{{.Id}} {{.RepoTags}}'])
    result.imageId = inspect.stdout.trim().split(/\s+/)[0]
    result.boot = await runFreshBoot({ imageTag, containerName: bootName, createdContainers, ownerId })
    assertFreshBoot(result.boot)
    result.legacy = await runLegacyRefusal({ imageTag, containerName: legacyName, createdContainers, disposableRoots, ownerId })
    return result
  } finally {
    await removeOwnedContainers({ createdContainers, ownerId })
    for (const dir of disposableRoots) {
      await rm(dir, { recursive: true, force: true })
    }
    resetRememberedSecrets()
  }
}

async function runFreshBoot({ imageTag, containerName, createdContainers, ownerId }) {
  const key = randomBytes(32).toString('hex')
  rememberSecret(key)
  const args = isolatedRunArgs({
    imageTag,
    containerName,
    ownerId,
    role: 'boot',
    extraEnv: ['YANXING_SETTINGS_ENCRYPTION_KEY=' + key],
  })
  registerOwnedContainer(createdContainers, containerName)
  const run = await docker(args)
  const containerId = run.stdout.trim()
  const healthy = await waitForHealth(containerName, 180_000)
  const identity = await docker(['exec', containerName, 'id'])
  const inspect = await docker(['inspect', containerName, '--format', '{{.State.Status}} {{.HostConfig.ReadonlyRootfs}} {{.Config.User}} {{.HostConfig.Binds}} {{json .HostConfig.Tmpfs}}'])
  const healthcheck = await docker(['exec', containerName, 'node', '/app/scripts/docker-healthcheck.mjs'])
  const heartbeat = await docker(['exec', containerName, 'node', '-e', "process.stdout.write(require('node:fs').readFileSync('/tmp/yanxing-worker-heartbeat.json','utf8'))"])
  const processes = await listRolePids(containerName)
  const codeWrite = await docker(['exec', containerName, 'node', '-e', "require('node:fs').writeFileSync('/app/server.js','tamper')"], { allowFailure: true })
  const tmpWrite = await docker(['exec', containerName, 'node', '-e', "require('node:fs').writeFileSync('/tmp/p5-write-ok','ok')"])
  await docker(['stop', '-t', '100', containerName])
  const exitInspect = await docker(['inspect', containerName, '--format', '{{.State.Status}} {{.State.ExitCode}}'])
  const parts = splitInspect(inspect.stdout)
  const readonlyRootfs = parts[1]
  const user = parts[2]
  const binds = parts[3]
  const tmpfs = parts[4]
  const exitParts = exitInspect.stdout.trim().split(/\s+/)
  const exitStatus = exitParts[0]
  const exitCode = exitParts[1]
  if (binds && binds !== '<no value>' && binds.includes('yanxing_data')) {
    throw new Error('Isolated container unexpectedly used yanxing_data')
  }
  return {
    containerId,
    containerName,
    healthy,
    identity: identity.stdout.trim(),
    user,
    readonlyRootfs: readonlyRootfs === 'true',
    tmpfs,
    healthcheckExit: healthcheck.status,
    heartbeat: heartbeat.stdout.trim(),
    processes,
    codeWriteDenied: codeWrite.status !== 0,
    tmpWriteOk: tmpWrite.status === 0,
    gracefulStop: exitStatus === 'exited' && exitCode === '0',
    exitCode,
  }
}

async function runLegacyRefusal({ imageTag, containerName, createdContainers, disposableRoots, ownerId }) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'yanxing-p5-legacy-'))
  disposableRoots.push(workspace)
  const storage = path.join(workspace, 'storage')
  await mkdir(storage, { recursive: true })
  const databasePath = path.join(storage, 'yanxing.sqlite')
  const database = new DatabaseSync(databasePath)
  database.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);')
  database.close()
  await chmod(storage, 0o777)
  await chmod(databasePath, 0o666)
  const hashBefore = await hashDatabaseArtifact(databasePath)
  const key = randomBytes(32).toString('hex')
  rememberSecret(key)
  const args = isolatedRunArgs({
    imageTag,
    containerName,
    ownerId,
    role: 'legacy',
    extraEnv: ['YANXING_SETTINGS_ENCRYPTION_KEY=' + key],
    extraArgs: ['--mount', 'type=bind,src=' + storage + ',dst=/app/storage'],
    includeStorageTmpfs: false,
  })
  registerOwnedContainer(createdContainers, containerName)
  const run = await docker(args)
  const containerId = run.stdout.trim()
  await sleep(8000)
  const inspect = await docker(['inspect', containerName, '--format', '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}} {{.State.ExitCode}}'])
  const logs = await docker(['logs', containerName], { allowFailure: true })
  const inspectParts = inspect.stdout.trim().split(/\s+/)
  const status = inspectParts[0]
  const health = inspectParts[1] || ''
  const exitCode = inspectParts[2]
  const combinedLogs = redactDockerText(logs.stdout + '\n' + logs.stderr)
  const refused = legacyRefusalPattern.test(combinedLogs)
  let processes = { supervisor: [], web: [], worker: [] }
  if (status === 'running') {
    processes = await listRolePids(containerName)
  }
  const hashAfter = await hashDatabaseArtifact(databasePath)
  if (health === 'healthy') throw new Error('Legacy database container became healthy')
  if (!refused) throw new Error('Legacy database was not refused\n' + combinedLogs)
  if (processes.web.length > 0 || processes.worker.length > 0) {
    throw new Error('Web or worker started despite legacy database refusal')
  }
  if (/started web|started worker/.test(combinedLogs)) {
    throw new Error('Supervisor logged web or worker start despite legacy database refusal')
  }
  if (hashBefore !== hashAfter) throw new Error('Legacy database hash changed during refusal')
  return {
    containerId,
    containerName,
    status,
    health,
    exitCode,
    refused,
    processes,
    databaseHashBefore: hashBefore,
    databaseHashAfter: hashAfter,
    databaseUnchanged: hashBefore === hashAfter,
    logTail: tail(combinedLogs, 40),
  }
}

function isolatedRunArgs({ imageTag, containerName, ownerId, role, extraEnv = [], extraArgs = [], includeStorageTmpfs = true }) {
  const args = [
    'run', '-d', '--name', containerName,
    '--label', 'yanxing.p5.isolated=1',
    '--label', P5_OWNER_LABEL + '=' + ownerId,
    '--label', 'yanxing.p5.role=' + role,
    '--read-only', '--init', '--restart=no',
    '--user', '1000:1000',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
    '--tmpfs', '/app/' + P5_NEXT_DIST_DIR + '/cache:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=1777',
    '-p', '127.0.0.1:0:3000',
    '-e', 'NODE_ENV=production',
    '-e', 'REPORT_MAX_UPLOAD_BYTES=' + defaultUploadLimit,
    '-e', 'YANXING_WORKER_CONCURRENCY=1',
    '-e', 'YANXING_WORKER_MAX_ATTEMPTS=1',
  ]
  if (includeStorageTmpfs) {
    args.push('--tmpfs', '/app/storage:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=1777')
  }
  for (const env of extraEnv) args.push('-e', env)
  args.push(...extraArgs, imageTag)
  return args
}

async function waitForHealth(containerName, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const inspect = await docker(['inspect', containerName, '--format', '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}'], { allowFailure: true })
    last = inspect.stdout.trim()
    const status = last.split(/\s+/)[0]
    const health = last.split(/\s+/)[1]
    if (health === 'healthy') return { status, health }
    if (status === 'exited') {
      const logs = await docker(['logs', containerName], { allowFailure: true })
      throw new Error('Isolated container exited before healthy: ' + last + '\n' + redactDockerText(logs.stdout + '\n' + logs.stderr))
    }
    await sleep(2000)
  }
  throw new Error('Timed out waiting for isolated container health: ' + last)
}

async function listRolePids(containerName) {
  const script = [
    "import { readdirSync, readFileSync } from 'node:fs'",
    'const out = { supervisor: [], web: [], worker: [] }',
    'for (const entry of readdirSync("/proc")) {',
    '  if (!/^\\d+$/.test(entry)) continue',
    '  const pid = Number(entry)',
    '  if (pid <= 1) continue',
    '  let argv',
    '  try { argv = readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\\0").filter(Boolean) } catch { continue }',
    '  if (argv.includes(' + JSON.stringify(supervisorArgv) + ')) out.supervisor.push(pid)',
    '  if (argv.includes(' + JSON.stringify(webArgv) + ') || /^next-server \\(v[0-9]/.test((argv[0] ?? "").trim())) out.web.push(pid)',
    '  if (argv.includes(' + JSON.stringify(workerArgv) + ')) out.worker.push(pid)',
    '}',
    'process.stdout.write(JSON.stringify(out))',
  ].join('\n')
  const listed = await docker(['exec', containerName, 'node', '--input-type=module', '-e', script])
  return JSON.parse(listed.stdout)
}

function assertFreshBoot(boot) {
  if (boot.healthy?.health !== 'healthy') throw new Error('Isolated container was not healthy')
  if (!boot.readonlyRootfs) throw new Error('Isolated container was not read-only')
  if (!String(boot.identity).includes('uid=1000')) throw new Error('Isolated container was not nonroot')
  if (!boot.codeWriteDenied) throw new Error('Isolated container allowed writes to immutable code')
  if (!boot.tmpWriteOk) throw new Error('Isolated container tmpfs was not writable')
  if (!boot.processes?.supervisor?.length) throw new Error('Supervisor was not running')
  if (!boot.processes?.worker?.length) throw new Error('Default worker was not running')
  if (!boot.processes?.web?.length) throw new Error('Web was not running')
  if (boot.healthcheckExit !== 0) throw new Error('Healthcheck failed inside the container')
  if (!boot.heartbeat.includes('ok')) throw new Error('Worker heartbeat was not ok')
  if (!boot.gracefulStop) throw new Error('Isolated container did not stop gracefully')
}

async function removeOwnedContainers({ createdContainers, ownerId }) {
  const targets = new Set(createdContainers)
  const listed = await docker(['ps', '-aq', '--filter', 'label=' + P5_OWNER_LABEL + '=' + ownerId], { allowFailure: true })
  for (const id of listed.stdout.split(/\n/).map((line) => line.trim()).filter(Boolean)) targets.add(id)
  for (const target of targets) {
    await docker(['rm', '-f', target], { allowFailure: true })
  }
}

function splitInspect(stdout) {
  const text = stdout.trim()
  const parts = text.split(/\s+/)
  return [parts[0], parts[1], parts[2], parts[3], parts.slice(4).join(' ')]
}

function tail(text, lines) {
  return String(text).split(/\n/).slice(-lines).join('\n')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function docker(args, { allowFailure = false, timeoutMs = timeoutForDockerArgs(args) } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args)
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error(formatDockerFailure({ args, status: null, stdout, stderr, timedOut: true })))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      finish(new Error(redactDockerText(error.message)))
    })
    child.on('close', (status) => {
      const result = { status, stdout, stderr, timedOut: false }
      if (status !== 0 && !allowFailure) {
        finish(new Error(formatDockerFailure({ args, status, stdout, stderr, timedOut: false })))
        return
      }
      finish(undefined, result)
    })
    function finish(error, result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(result)
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseP5ContainerArguments(process.argv.slice(2))
    if (options.help) {
      process.stdout.write(P5_CONTAINER_HELP)
      process.exit(0)
    }
    const reportPath = path.resolve(options.reportPath ?? path.join(projectRoot, 'out', 'p5-qa-acceptance.json'))
    await mkdir(path.dirname(reportPath), { recursive: true })
    try {
      const result = await verifyP5IsolatedContainer({
        ...(options.candidateRoot ? { candidateRoot: path.resolve(options.candidateRoot) } : {}),
        ...(options.imageTag ? { imageTag: options.imageTag } : {}),
      })
      await writeFile(reportPath, JSON.stringify(result, null, 2) + '\n')
      console.log('P5 isolated image: ' + result.imageTag + ' ' + result.imageId)
      console.log('P5 isolated acceptance: ' + reportPath)
    } catch (error) {
      const failure = { ok: false, error: redactDockerText(error instanceof Error ? error.message : String(error)) }
      await writeFile(reportPath, JSON.stringify(failure, null, 2) + '\n')
      console.error(failure.error)
      process.exitCode = 1
    }
  } catch (error) {
    console.error(redactDockerText(error instanceof Error ? error.message : String(error)))
    process.exit(1)
  }
}

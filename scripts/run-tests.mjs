import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const testRoot = path.join(projectRoot, 'test')
const tsconfigPath = path.join(projectRoot, 'tsconfig.source.json')
const tsxCliPath = fileURLToPath(import.meta.resolve('tsx/cli'))
const forwardedSignals = ['SIGHUP', 'SIGINT', 'SIGTERM']
const testFilePattern = /\.test\.(?:mjs|ts)$/

const systemDependencies = {
  createWorkspace: async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'yanxing-tests-'))
    await Promise.all([
      mkdir(path.join(workspaceRoot, 'storage', 'knowledge'), { recursive: true }),
      mkdir(path.join(workspaceRoot, 'tmp'), { recursive: true }),
    ])
    return workspaceRoot
  },
  removeWorkspace: (workspaceRoot) => rm(workspaceRoot, { recursive: true, force: true }),
  spawnProcess: spawn,
  signalSource: process,
}

export async function createTestInvocation({ workspaceRoot, arguments_: extraArguments = [], environment = process.env }) {
  const { nodeArguments, selectedTestFiles } = await resolveTestArguments(extraArguments)
  const testFiles = selectedTestFiles.length > 0 ? selectedTestFiles : await defaultTestFiles()
  const storageRoot = path.join(workspaceRoot, 'storage')
  const temporaryRoot = path.join(workspaceRoot, 'tmp')
  const childEnvironment = {
    ...environment,
    NODE_ENV: 'test',
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    TMPDIR: temporaryRoot,
    TSX_TSCONFIG_PATH: tsconfigPath,
    YANXING_DATABASE_PATH: path.join(storageRoot, 'yanxing.sqlite'),
    YANXING_KNOWLEDGE_STORAGE_ROOT: path.join(storageRoot, 'knowledge'),
    YANXING_TEST_WORKSPACE_ROOT: workspaceRoot,
  }
  // A runner self-test can invoke this command from inside node:test. The nested
  // child must bootstrap as a fresh test runner instead of inheriting its parent role.
  delete childEnvironment.NODE_TEST_CONTEXT

  return {
    command: process.execPath,
    arguments: [tsxCliPath, '--tsconfig', tsconfigPath, '--test', ...nodeArguments, ...testFiles],
    options: {
      cwd: workspaceRoot,
      env: childEnvironment,
      shell: false,
      stdio: 'inherit',
    },
  }
}

export async function runTestCommand({ arguments_: extraArguments = process.argv.slice(2), environment = process.env, dependencies: dependencyOverrides = {} } = {}) {
  const dependencies = { ...systemDependencies, ...dependencyOverrides }
  const workspaceRoot = await dependencies.createWorkspace()
  let signalForwarding

  try {
    const invocation = await createTestInvocation({ workspaceRoot, arguments_: extraArguments, environment })
    const child = dependencies.spawnProcess(invocation.command, invocation.arguments, invocation.options)
    signalForwarding = forwardSignals(child, dependencies.signalSource)
    const outcome = await waitForChild(child)
    return { code: outcome.code, signal: outcome.signal ?? signalForwarding.signal }
  } finally {
    signalForwarding?.dispose()
    await dependencies.removeWorkspace(workspaceRoot)
  }
}

export function applyTestOutcome(outcome, runtime = process) {
  if (outcome.signal) {
    runtime.kill(runtime.pid, outcome.signal)
    return
  }
  runtime.exitCode = outcome.code ?? 1
}

async function defaultTestFiles() {
  const entries = await readdir(testRoot, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && testFilePattern.test(entry.name))
    .map((entry) => path.join(testRoot, entry.name))
    .sort()
}

async function resolveTestArguments(extraArguments) {
  const nodeArguments = []
  const selectedTestFiles = []

  for (const argument of extraArguments) {
    if (argument === '--tsconfig' || argument.startsWith('--tsconfig=')) {
      throw new Error('测试 tsconfig 由隔离启动器固定，不能覆盖。')
    }
    const testFile = resolveTestFileArgument(argument)
    if (testFile) selectedTestFiles.push(testFile)
    else nodeArguments.push(argument)
  }

  return { nodeArguments, selectedTestFiles: [...new Set(selectedTestFiles)].sort() }
}

function resolveTestFileArgument(argument) {
  if (!testFilePattern.test(argument)) return undefined
  const candidate = path.isAbsolute(argument)
    ? path.resolve(argument)
    : path.resolve(argument.includes(path.sep) ? projectRoot : testRoot, argument)
  if (!isPathWithin(testRoot, candidate) || !existsSync(candidate)) {
    throw new Error(`测试源码不存在或不在 test 目录内：${argument}`)
  }
  return candidate
}

function isPathWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

function forwardSignals(child, signalSource) {
  let signal
  const handlers = new Map()

  for (const signalName of forwardedSignals) {
    const handler = () => {
      if (signal) return
      signal = signalName
      child.kill(signalName)
    }
    handlers.set(signalName, handler)
    signalSource.on(signalName, handler)
  }

  return {
    get signal() {
      return signal
    },
    dispose() {
      for (const [signalName, handler] of handlers) signalSource.off(signalName, handler)
    },
  }
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (operation) => {
      if (settled) return
      settled = true
      child.off('error', onError)
      child.off('close', onClose)
      operation()
    }
    const onError = (error) => settle(() => reject(error))
    const onClose = (code, signal) => settle(() => resolve({ code, signal }))
    child.once('error', onError)
    child.once('close', onClose)
  })
}

function isMainModule() {
  if (!process.argv[1]) return false
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
}

if (isMainModule()) {
  try {
    applyTestOutcome(await runTestCommand())
  } catch (error) {
    console.error('[test-runner]', error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

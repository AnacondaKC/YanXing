import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { applyTestOutcome, defaultTestFiles, runTestCommand } from '../scripts/run-tests.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const runnerPath = fileURLToPath(new URL('../scripts/run-tests.mjs', import.meta.url))
const probePath = fileURLToPath(new URL('./fixtures/run-tests-probe.test.ts', import.meta.url))
const testRoot = path.join(projectRoot, 'test')

class FakeChild extends EventEmitter {
  killedWith = []

  kill(signal) {
    this.killedWith.push(signal)
    return true
  }
}

function spawnRunner(args, env = {}, timeout = 30_000) {
  return spawnSync(process.execPath, [runnerPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout,
  })
}

test('test runner isolates real child paths and preserves repository storage sentinels', async () => {
  const outerDirectory = await mkdtemp(path.join(tmpdir(), 'yanxing-runner-test-'))
  const probeOutputPath = path.join(outerDirectory, 'probe.json')
  const protectedRoot = path.join(outerDirectory, `protected-host-data-${randomUUID()}`)
  const sentinelPath = path.join(protectedRoot, 'keep.txt')
  const inheritedDatabasePath = path.join(protectedRoot, 'host.sqlite')
  const inheritedKnowledgeRoot = path.join(protectedRoot, 'knowledge')
  const inheritedKnowledgeSentinel = path.join(inheritedKnowledgeRoot, 'keep.txt')

  await mkdir(protectedRoot)
  await mkdir(inheritedKnowledgeRoot)
  await writeFile(sentinelPath, 'repository-sentinel', { flag: 'wx' })
  await writeFile(inheritedDatabasePath, 'host-database-sentinel', { flag: 'wx' })
  await writeFile(inheritedKnowledgeSentinel, 'host-knowledge-sentinel', { flag: 'wx' })

  try {
    const result = spawnRunner([
      '--test-name-pattern=isolated runner probe',
      '--test-concurrency=1',
      probePath,
    ], {
      YANXING_DATABASE_PATH: inheritedDatabasePath,
      YANXING_KNOWLEDGE_STORAGE_ROOT: inheritedKnowledgeRoot,
      YANXING_TEST_PROBE_OUTPUT: probeOutputPath,
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const probe = JSON.parse(await readFile(probeOutputPath, 'utf8'))
    assert.notEqual(probe.cwd, projectRoot)
    assert.equal(path.isAbsolute(probe.cwd), true)
    assert.equal(probe.workspaceRoot, probe.cwd)
    assert.equal(probe.databasePath, path.join(probe.cwd, 'storage', 'yanxing.sqlite'))
    assert.equal(probe.knowledgeRoot, path.join(probe.cwd, 'storage', 'knowledge'))
    assert.equal(probe.reportRoot, path.join(probe.cwd, 'storage', 'reports'))
    assert.notEqual(probe.databasePath, inheritedDatabasePath)
    assert.notEqual(probe.knowledgeRoot, inheritedKnowledgeRoot)
    assert.equal(probe.tsconfigPath, path.join(projectRoot, 'tsconfig.source.json'))
    assert.equal(path.isAbsolute(probe.testSourcePath), true)
    assert.equal(probe.testSourcePath, probePath)
    await assert.rejects(access(probe.cwd), { code: 'ENOENT' })
    assert.equal(await readFile(sentinelPath, 'utf8'), 'repository-sentinel')
    assert.equal(await readFile(inheritedDatabasePath, 'utf8'), 'host-database-sentinel')
    assert.equal(await readFile(inheritedKnowledgeSentinel, 'utf8'), 'host-knowledge-sentinel')
  } finally {
    await rm(outerDirectory, { recursive: true, force: true })
  }
})

test('test runner waits for child exit before cleanup and preserves its exit code', async () => {
  const events = []
  const signalSource = new EventEmitter()
  const runPromise = runTestCommand({
    arguments_: ['--test-name-pattern=never-matches'],
    dependencies: {
      createWorkspace: async () => {
        events.push('workspace')
        return '/tmp/yanxing-tests-fake-code'
      },
      removeWorkspace: async () => {
        events.push('cleanup')
      },
      spawnProcess: () => {
        events.push('spawn')
        const spawned = new FakeChild()
        queueMicrotask(() => {
          events.push('close')
          spawned.emit('close', 23, null)
        })
        return spawned
      },
      signalSource,
    },
  })

  const outcome = await runPromise
  assert.deepEqual(outcome, { code: 23, signal: undefined })
  assert.deepEqual(events, ['workspace', 'spawn', 'close', 'cleanup'])
  const runtime = { pid: 42, exitCode: undefined, kill: () => assert.fail('exit code must not send a signal') }
  applyTestOutcome(outcome, runtime)
  assert.equal(runtime.exitCode, 23)
})

test('test runner forwards a signal and reapplies it only after cleanup', async () => {
  const events = []
  const child = new FakeChild()
  const signalSource = new EventEmitter()
  const outcomePromise = runTestCommand({
    dependencies: {
      createWorkspace: async () => '/tmp/yanxing-tests-fake-signal',
      removeWorkspace: async () => {
        events.push('cleanup')
      },
      spawnProcess: () => {
        queueMicrotask(() => {
          signalSource.emit('SIGTERM')
          events.push('close')
          child.emit('close', null, 'SIGTERM')
        })
        return child
      },
      signalSource,
    },
  })

  const outcome = await outcomePromise
  assert.deepEqual(child.killedWith, ['SIGTERM'])
  assert.deepEqual(outcome, { code: null, signal: 'SIGTERM' })
  assert.deepEqual(events, ['close', 'cleanup'])
  const runtime = {
    pid: 42,
    exitCode: undefined,
    kill(pid, signal) {
      events.push(`signal:${pid}:${signal}`)
    },
  }
  applyTestOutcome(outcome, runtime)
  assert.deepEqual(events, ['close', 'cleanup', 'signal:42:SIGTERM'])
})

test('test runner fails closed on an empty discovery set without spawning a child', async () => {
  const events = []
  const outcome = await runTestCommand({
    arguments_: [],
    dependencies: {
      createWorkspace: async () => {
        events.push('workspace')
        return '/tmp/yanxing-tests-fake-empty'
      },
      removeWorkspace: async () => {
        events.push('cleanup')
      },
      spawnProcess: () => assert.fail('an empty test set must not spawn a child'),
      signalSource: new EventEmitter(),
      defaultTestFiles: async () => [],
    },
  })

  assert.deepEqual(outcome, { code: 1, signal: undefined })
  assert.deepEqual(events, ['workspace', 'cleanup'])
  const runtime = { pid: 1, exitCode: undefined, kill: () => assert.fail('an empty test set must not signal') }
  applyTestOutcome(outcome, runtime)
  assert.equal(runtime.exitCode, 1)
})

test('test runner default discovery stays top-level and excludes fixtures', async () => {
  const files = await defaultTestFiles()
  assert.ok(files.length > 0)
  for (const file of files) {
    assert.equal(path.dirname(file), testRoot)
    assert.match(file, /\.test\.(?:mjs|ts)$/)
    assert.equal(file.includes(`${path.sep}fixtures${path.sep}`), false)
    assert.equal(file.includes(`${path.sep}helpers${path.sep}`), false)
  }
  assert.equal(files.includes(probePath), false)
  assert.ok(files.includes(path.join(testRoot, 'run-tests.test.mjs')))
})

test('test runner forwards node arguments and deduplicates selected files', async () => {
  const events = []
  let invocation
  const signalSource = new EventEmitter()
  const absoluteTestFile = fileURLToPath(new URL('./run-tests.test.mjs', import.meta.url))
  const preloadPath = './test/fixtures/run-tests-native-preload.mjs'
  const outcome = await runTestCommand({
    arguments_: ['--test-name-pattern=forwarded', '--import', preloadPath, 'run-tests.test.mjs', absoluteTestFile],
    environment: { ...process.env, NODE_TEST_CONTEXT: 'child-v1' },
    dependencies: {
      createWorkspace: async () => '/tmp/yanxing-tests-fake-forward',
      removeWorkspace: async () => {
        events.push('cleanup')
      },
      spawnProcess: (command, args, options) => {
        invocation = { command, args, options }
        const spawned = new FakeChild()
        queueMicrotask(() => spawned.emit('close', 0, null))
        return spawned
      },
      signalSource,
    },
  })

  assert.deepEqual(outcome, { code: 0, signal: undefined })
  assert.deepEqual(events, ['cleanup'])
  const expectedFile = path.join(projectRoot, 'test', 'run-tests.test.mjs')
  const tsxLoader = import.meta.resolve('tsx')
  assert.equal(invocation.command, process.execPath)
  assert.deepEqual(invocation.args.slice(0, 3), ['--import', tsxLoader, '--test'])
  assert.equal(invocation.args.includes(fileURLToPath(import.meta.resolve('tsx/cli'))), false)
  assert.equal(invocation.args.includes('--test-force-exit'), false)
  const filesStart = invocation.args.indexOf(expectedFile)
  assert.deepEqual(
    invocation.args.slice(3, filesStart),
    ['--test-timeout=60000', '--test-name-pattern=forwarded', '--import', preloadPath],
  )
  assert.equal(invocation.args.at(-1), expectedFile)
  assert.equal(invocation.args.filter((argument) => argument === expectedFile).length, 1)
  assert.equal(invocation.options.cwd, '/tmp/yanxing-tests-fake-forward')
  assert.equal(invocation.options.env.NODE_ENV, 'test')
  assert.equal(invocation.options.env.TSX_TSCONFIG_PATH, path.join(projectRoot, 'tsconfig.source.json'))
  assert.equal(invocation.options.env.YANXING_DATABASE_PATH, path.join(invocation.options.cwd, 'storage', 'yanxing.sqlite'))
  assert.equal(invocation.options.env.YANXING_TEST_WORKSPACE_ROOT, invocation.options.cwd)
  assert.equal(invocation.options.env.TMPDIR, path.join(invocation.options.cwd, 'tmp'))
  assert.equal(Object.hasOwn(invocation.options.env, 'NODE_TEST_CONTEXT'), false)
  assert.equal(invocation.options.shell, false)
  assert.equal(invocation.options.stdio, 'inherit')
  assert.equal(signalSource.listenerCount('SIGTERM'), 0)
})

test('test runner forwards an explicit test timeout instead of the default', async () => {
  let invocation
  const outcome = await runTestCommand({
    arguments_: ['--test-timeout=120000', 'run-tests.test.mjs'],
    dependencies: {
      createWorkspace: async () => '/tmp/yanxing-tests-fake-timeout',
      removeWorkspace: async () => {},
      spawnProcess: (command, args) => {
        invocation = { command, args }
        const spawned = new FakeChild()
        queueMicrotask(() => spawned.emit('close', 0, null))
        return spawned
      },
      signalSource: new EventEmitter(),
    },
  })

  assert.deepEqual(outcome, { code: 0, signal: undefined })
  assert.deepEqual(
    invocation.args.filter((argument) => argument === '--test-timeout' || argument.startsWith('--test-timeout=')),
    ['--test-timeout=120000'],
  )
})

test('test runner rejects tsconfig overrides and still cleans the workspace', async () => {
  const events = []
  await assert.rejects(
    runTestCommand({
      arguments_: ['--tsconfig', '/tmp/yanxing-evil-tsconfig.json'],
      dependencies: {
        createWorkspace: async () => {
          events.push('workspace')
          return '/tmp/yanxing-tests-fake-tsconfig'
        },
        removeWorkspace: async () => {
          events.push('cleanup')
        },
        spawnProcess: () => assert.fail('rejected arguments must not spawn a child'),
        signalSource: new EventEmitter(),
      },
    }),
    /测试 tsconfig 由隔离启动器固定/,
  )
  assert.deepEqual(events, ['workspace', 'cleanup'])
})

test('test runner cleans up and releases listeners when the child fails to start', async () => {
  const events = []
  const signalSource = new EventEmitter()
  await assert.rejects(
    runTestCommand({
      arguments_: ['run-tests.test.mjs'],
      dependencies: {
        createWorkspace: async () => {
          events.push('workspace')
          return '/tmp/yanxing-tests-fake-spawn-error'
        },
        removeWorkspace: async () => {
          events.push('cleanup')
        },
        spawnProcess: () => {
          events.push('spawn')
          const spawned = new FakeChild()
          queueMicrotask(() => spawned.emit('error', new Error('spawn failed')))
          return spawned
        },
        signalSource,
      },
    }),
    /spawn failed/,
  )
  assert.deepEqual(events, ['workspace', 'spawn', 'cleanup'])
  assert.equal(signalSource.listenerCount('SIGHUP'), 0)
  assert.equal(signalSource.listenerCount('SIGINT'), 0)
  assert.equal(signalSource.listenerCount('SIGTERM'), 0)
})

test('test runner nested isolation works with a long TMPDIR', async () => {
  const longRoot = await mkdtemp(path.join(tmpdir(), `${'y'.repeat(80)}-`))
  const probeOutputPath = path.join(longRoot, 'probe.json')
  try {
    const result = spawnRunner([
      '--test-name-pattern=isolated runner probe',
      '--test-concurrency=1',
      probePath,
    ], {
      TMPDIR: longRoot,
      TEMP: longRoot,
      TMP: longRoot,
      YANXING_TEST_PROBE_OUTPUT: probeOutputPath,
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.doesNotMatch(result.stderr, /listen EINVAL/)
    const probe = JSON.parse(await readFile(probeOutputPath, 'utf8'))
    assert.equal(probe.tsconfigPath, path.join(projectRoot, 'tsconfig.source.json'))
    assert.equal(probe.testSourcePath, probePath)
    assert.equal(probe.cwd.startsWith(longRoot), true)
    await assert.rejects(access(probe.cwd), { code: 'ENOENT' })
  } finally {
    await rm(longRoot, { recursive: true, force: true })
  }
})

test('test runner keeps Node empty name-filter semantics without inventing a reporter', async () => {
  const outerDirectory = await mkdtemp(path.join(tmpdir(), 'yanxing-runner-filter-'))
  try {
    const result = spawnRunner([
      '--test-name-pattern=__audit_no_test_should_match__',
      '--test-concurrency=1',
      probePath,
    ], {
      YANXING_TEST_PROBE_OUTPUT: path.join(outerDirectory, 'unused-probe.json'),
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /tests 1/)
    assert.match(result.stdout, /pass 1/)
    assert.match(result.stdout, /fail 0/)
  } finally {
    await rm(outerDirectory, { recursive: true, force: true })
  }
})

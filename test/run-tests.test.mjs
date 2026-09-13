import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { applyTestOutcome, runTestCommand } from '../scripts/run-tests.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const runnerPath = fileURLToPath(new URL('../scripts/run-tests.mjs', import.meta.url))
const probePath = fileURLToPath(new URL('./fixtures/run-tests-probe.test.ts', import.meta.url))

class FakeChild extends EventEmitter {
  killedWith = []

  kill(signal) {
    this.killedWith.push(signal)
    return true
  }
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
    const result = spawnSync(process.execPath, [
      runnerPath,
      '--test-name-pattern=isolated runner probe',
      '--test-concurrency=1',
      probePath,
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        YANXING_DATABASE_PATH: inheritedDatabasePath,
        YANXING_KNOWLEDGE_STORAGE_ROOT: inheritedKnowledgeRoot,
        YANXING_TEST_PROBE_OUTPUT: probeOutputPath,
      },
      timeout: 30_000,
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

test('test runner keeps an empty test set green without spawning a child', async () => {
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

  assert.deepEqual(outcome, { code: 0, signal: undefined })
  assert.deepEqual(events, ['workspace', 'cleanup'])
  const runtime = { pid: 1, exitCode: undefined, kill: () => assert.fail('an empty test set must not signal') }
  applyTestOutcome(outcome, runtime)
  assert.equal(runtime.exitCode, 0)
})

test('test runner forwards node arguments and deduplicates selected files', async () => {
  const events = []
  let invocation
  const signalSource = new EventEmitter()
  const absoluteTestFile = fileURLToPath(new URL('./run-tests.test.mjs', import.meta.url))
  const preloadPath = './test/fixtures/run-tests-native-preload.mjs'
  const outcome = await runTestCommand({
    arguments_: ['--test-name-pattern=forwarded', '--import', preloadPath, 'run-tests.test.mjs', absoluteTestFile],
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
  assert.equal(invocation.command, process.execPath)
  assert.equal(invocation.args[0], fileURLToPath(import.meta.resolve('tsx/cli')))
  assert.deepEqual(invocation.args.slice(1, 3), ['--tsconfig', path.join(projectRoot, 'tsconfig.source.json')])
  assert.ok(invocation.args.includes('--test'))
  const nodeArgumentsStart = invocation.args.indexOf('--test') + 1
  const filesStart = invocation.args.indexOf(expectedFile)
  assert.deepEqual(
    invocation.args.slice(nodeArgumentsStart, filesStart),
    ['--test-name-pattern=forwarded', '--import', preloadPath],
  )
  assert.equal(invocation.args.at(-1), expectedFile)
  assert.equal(invocation.args.filter((argument) => argument === expectedFile).length, 1)
  assert.equal(invocation.options.cwd, '/tmp/yanxing-tests-fake-forward')
  assert.equal(invocation.options.env.NODE_ENV, 'test')
  assert.equal(invocation.options.env.YANXING_DATABASE_PATH, path.join(invocation.options.cwd, 'storage', 'yanxing.sqlite'))
  assert.equal(invocation.options.env.YANXING_TEST_WORKSPACE_ROOT, invocation.options.cwd)
  assert.equal(invocation.options.env.TMPDIR, path.join(invocation.options.cwd, 'tmp'))
  assert.equal(invocation.options.shell, false)
  assert.equal(invocation.options.stdio, 'inherit')
  assert.equal(signalSource.listenerCount('SIGTERM'), 0)
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

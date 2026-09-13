import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test, { type TestContext } from 'node:test'
import { waitForIpcMessage, waitForSpawnExit } from './helpers/p5-native-harness'

function childFixture(context: TestContext, source: string) {
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  })
  return child
}

function assertWaitListenersRemoved(child: ReturnType<typeof childFixture>) {
  for (const event of ['message', 'error', 'exit']) {
    assert.equal(child.listenerCount(event), 0, 'leaked child listener: ' + event)
  }
}

test('IPC wait ignores unrelated messages and removes listeners after success', { timeout: 3_000 }, async (context) => {
  const child = childFixture(context, 'process.on("message", () => { process.send({ ignored: true }); process.send({ value: 42 }); })')
  const received = waitForIpcMessage<{ value?: number }>(child, (message) => message.value === 42, 2_000)
  child.send('go')
  assert.deepEqual(await received, { value: 42 })
  assertWaitListenersRemoved(child)
})

test('IPC wait rejects a live silent child on deadline without leaking listeners', { timeout: 3_000 }, async (context) => {
  const child = childFixture(context, 'setInterval(() => {}, 1000)')
  await assert.rejects(waitForIpcMessage(child, () => true, 30), /Timed out waiting for child IPC result/)
  assertWaitListenersRemoved(child)
})

test('IPC wait rejects an exited child immediately and removes pending listeners', { timeout: 3_000 }, async (context) => {
  const child = childFixture(context, 'process.exit(7)')
  await assert.rejects(waitForIpcMessage(child, () => true, 2_000), /child exited before IPC result [(]7[)]/)
  assertWaitListenersRemoved(child)
  await assert.rejects(waitForIpcMessage(child, () => true), /child already exited/)
})

test('child exit deadline kills and reaps a stalled bootstrap', { timeout: 3_000 }, async (context) => {
  const child = childFixture(context, 'setInterval(() => {}, 1000)')
  await assert.rejects(waitForSpawnExit(child, 30), /Timed out waiting for child exit/)
  assert.equal(child.signalCode, 'SIGKILL')
  assertWaitListenersRemoved(child)
})

test('child exit wait returns its actual exit code without leftover listeners', { timeout: 3_000 }, async (context) => {
  const child = childFixture(context, 'process.exit(7)')
  assert.deepEqual(await waitForSpawnExit(child, 2_000), [7, null])
  assertWaitListenersRemoved(child)
})

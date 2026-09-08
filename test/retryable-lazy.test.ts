import assert from 'node:assert/strict'
import test from 'node:test'
import { createRetryableLazyResource } from '../lib/retryable-lazy'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function wrapForLazy<T>(load: Promise<T>) {
  return load.then((Loaded) => ({ default: Loaded }))
}

test('pending load joins the in-flight import instead of starting another', async () => {
  let calls = 0
  const pending = deferred<string>()
  const resource = createRetryableLazyResource(() => {
    calls += 1
    return pending.promise
  })
  const first = resource.load()
  const second = resource.load()
  assert.equal(calls, 1)
  assert.equal(resource.snapshot().status, 'pending')
  pending.resolve('ok')
  assert.equal(await first, 'ok')
  assert.equal(await second, 'ok')
  assert.equal(calls, 1)
  assert.equal(resource.snapshot().status, 'loaded')
})

test('loaded resource does not reload on later load calls', async () => {
  let calls = 0
  const panel = function Panel() { return null }
  const resource = createRetryableLazyResource(async () => {
    calls += 1
    return panel
  })
  assert.equal(await resource.load(), panel)
  assert.equal(await resource.load(), panel)
  assert.equal(await resource.load(), panel)
  assert.equal(calls, 1)
  assert.equal(resource.snapshot().status, 'loaded')
  assert.equal(resource.snapshot().value, panel)
  assert.equal(calls, 1)
})

test('rejected import retries with a new loader attempt then succeeds', async () => {
  let calls = 0
  const resource = createRetryableLazyResource(async () => {
    calls += 1
    if (calls === 1) throw new Error('chunk failed')
    return 'panel'
  })
  const first = resource.load()
  await assert.rejects(first, /chunk failed/)
  assert.equal(await first.then(() => 'fulfilled', () => 'rejected'), 'rejected')
  assert.equal(calls, 1)
  assert.equal(resource.snapshot().status, 'failed')
  assert.equal(resource.snapshot().value, undefined)
  assert.equal(await resource.load(), 'panel')
  assert.equal(calls, 2)
  assert.equal(resource.snapshot().status, 'loaded')
  assert.equal(await resource.load(), 'panel')
  assert.equal(calls, 2)
})

test('failed load stays a rejection for React.lazy default wrapping', async () => {
  let calls = 0
  const pending = deferred<string>()
  const resource = createRetryableLazyResource(() => {
    calls += 1
    return pending.promise
  })
  const loadPromise = resource.load()
  const lazyPromise = wrapForLazy(loadPromise)
  pending.reject(new Error('chunk failed'))
  await assert.rejects(loadPromise, /chunk failed/)
  await assert.rejects(lazyPromise, /chunk failed/)
  assert.equal(await lazyPromise.then(() => 'fulfilled', () => 'rejected'), 'rejected')
  assert.equal(calls, 1)
  assert.equal(resource.snapshot().status, 'failed')
})

test('synchronous loader throw becomes a rejected attempt that can retry', async () => {
  let calls = 0
  const resource = createRetryableLazyResource(() => {
    calls += 1
    if (calls === 1) throw new Error('sync fail')
    return Promise.resolve('ok')
  })
  await assert.rejects(resource.load(), /sync fail/)
  assert.equal(calls, 1)
  assert.equal(await resource.load(), 'ok')
  assert.equal(calls, 2)
})

test('abandoned pending success is reused without a second import', async () => {
  let calls = 0
  const pending = deferred<string>()
  const resource = createRetryableLazyResource(() => {
    calls += 1
    return pending.promise
  })
  const abandoned = resource.load()
  pending.resolve('cached')
  assert.equal(await abandoned, 'cached')
  assert.equal(await resource.load(), 'cached')
  assert.equal(calls, 1)
})

test('rejected load does not stay unhandled when the caller unmounts', async () => {
  const unhandled: unknown[] = []
  function onUnhandled(error: unknown) {
    unhandled.push(error)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    let calls = 0
    const resource = createRetryableLazyResource(async () => {
      calls += 1
      throw new Error('chunk failed')
    })
    resource.load()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(unhandled.length, 0)
    assert.equal(calls, 1)
    assert.equal(resource.snapshot().status, 'failed')
    assert.equal(await resource.load().then(() => 'fulfilled', () => 'rejected'), 'rejected')
    assert.equal(calls, 2)
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('a failed resource does not poison a sibling resource', async () => {
  let leftCalls = 0
  let rightCalls = 0
  const left = createRetryableLazyResource(async () => {
    leftCalls += 1
    throw new Error('left failed')
  })
  const right = createRetryableLazyResource(async () => {
    rightCalls += 1
    return 'right'
  })
  await assert.rejects(left.load(), /left failed/)
  assert.equal(await right.load(), 'right')
  assert.equal(leftCalls, 1)
  assert.equal(rightCalls, 1)
  assert.equal(left.snapshot().status, 'failed')
  assert.equal(right.snapshot().status, 'loaded')
})

import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'
import { createLatestRequestGuard } from '../components/use-latest-request'

function abortListenerCount(signal: AbortSignal) {
  return getEventListeners(signal, 'abort').length
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function runGuarded<T>(
  begin: ReturnType<typeof createLatestRequestGuard>['begin'],
  task: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
) {
  const request = begin(externalSignal)
  const result = { applied: undefined as T | undefined, error: undefined as string | undefined, closedLoading: false, current: false }
  try {
    const value = await task(request.signal)
    if (!request.isCurrent()) return result
    result.applied = value
    result.current = true
    return result
  } catch (cause) {
    if (!request.isCurrent()) return result
    result.error = cause instanceof Error ? cause.message : 'fail'
    return result
  } finally {
    request.end()
    if (request.isCurrent()) result.closedLoading = true
  }
}

test('begin A then B: old finally does not close B loading', () => {
  const guard = createLatestRequestGuard()
  const a = guard.begin()
  const b = guard.begin()
  let loading = true
  a.end()
  if (a.isCurrent()) loading = false
  assert.equal(a.isCurrent(), false)
  assert.equal(b.isCurrent(), true)
  assert.equal(loading, true)
  b.end()
  if (b.isCurrent()) loading = false
  assert.equal(loading, false)
})

test('begin A then B: A.end leaves B held so invalidate still aborts B', () => {
  const guard = createLatestRequestGuard()
  const a = guard.begin()
  const b = guard.begin()
  assert.equal(a.isCurrent(), false)
  assert.equal(a.signal.aborted, true)
  assert.equal(b.isCurrent(), true)
  assert.equal(b.signal.aborted, false)
  a.end()
  a.end()
  assert.equal(b.isCurrent(), true)
  assert.equal(b.signal.aborted, false)
  guard.invalidate()
  assert.equal(b.signal.aborted, true)
  assert.equal(b.isCurrent(), false)
})

test('late success of A does not write back after B', async () => {
  const guard = createLatestRequestGuard()
  const aFetch = deferred<string>()
  const bFetch = deferred<string>()
  const aRun = runGuarded(guard.begin, () => aFetch.promise)
  const bRun = runGuarded(guard.begin, () => bFetch.promise)
  aFetch.resolve('stale-success')
  const stale = await aRun
  assert.equal(stale.applied, undefined)
  assert.equal(stale.closedLoading, false)
  bFetch.resolve('fresh')
  const b = await bRun
  assert.equal(b.applied, 'fresh')
  assert.equal(b.closedLoading, true)
  assert.equal(b.current, true)
})

test('late error of A does not write back after B', async () => {
  const guard = createLatestRequestGuard()
  const aFetch = deferred<string>()
  const bFetch = deferred<string>()
  const aRun = runGuarded(guard.begin, () => aFetch.promise)
  const bRun = runGuarded(guard.begin, () => bFetch.promise)
  aFetch.reject(new Error('stale-error'))
  const stale = await aRun
  assert.equal(stale.error, undefined)
  assert.equal(stale.closedLoading, false)
  bFetch.resolve('fresh')
  const b = await bRun
  assert.equal(b.applied, 'fresh')
  assert.equal(b.closedLoading, true)
})

test('pre-cancelled external signal is not current', () => {
  const guard = createLatestRequestGuard()
  const external = new AbortController()
  external.abort()
  const request = guard.begin(external.signal)
  assert.equal(request.signal.aborted, true)
  assert.equal(request.isCurrent(), false)
  request.end()
  const next = guard.begin()
  assert.equal(next.isCurrent(), true)
  assert.equal(next.signal.aborted, false)
})

test('external abort mid-flight cancels the current request', () => {
  const guard = createLatestRequestGuard()
  const external = new AbortController()
  const request = guard.begin(external.signal)
  assert.equal(request.isCurrent(), true)
  assert.equal(abortListenerCount(external.signal), 1)
  external.abort()
  assert.equal(request.signal.aborted, true)
  assert.equal(request.isCurrent(), false)
  assert.equal(abortListenerCount(external.signal), 0)
  request.end()
  assert.equal(abortListenerCount(external.signal), 0)
})

test('end removes this request external listener and does not abort after completion', () => {
  const guard = createLatestRequestGuard()
  const external = new AbortController()
  const request = guard.begin(external.signal)
  assert.equal(abortListenerCount(external.signal), 1)
  request.end()
  assert.equal(abortListenerCount(external.signal), 0)
  assert.equal(request.isCurrent(), true)
  assert.equal(request.signal.aborted, false)
  external.abort()
  assert.equal(request.signal.aborted, false)
  assert.equal(request.isCurrent(), true)
  assert.equal(abortListenerCount(external.signal), 0)
})

test('A.end does not remove B listener on the same external signal', () => {
  const guard = createLatestRequestGuard()
  const external = new AbortController()
  const a = guard.begin(external.signal)
  const b = guard.begin(external.signal)
  assert.equal(abortListenerCount(external.signal), 1)
  a.end()
  assert.equal(abortListenerCount(external.signal), 1)
  assert.equal(b.isCurrent(), true)
  external.abort()
  assert.equal(b.signal.aborted, true)
  assert.equal(b.isCurrent(), false)
  assert.equal(abortListenerCount(external.signal), 0)
})

test('invalidate does not start a request', async () => {
  const guard = createLatestRequestGuard()
  const external = new AbortController()
  const pending = deferred<string>()
  const run = runGuarded(guard.begin, () => pending.promise, external.signal)
  assert.equal(abortListenerCount(external.signal), 1)
  guard.invalidate()
  assert.equal(abortListenerCount(external.signal), 0)
  pending.resolve('ignored-abort')
  const stale = await run
  assert.equal(stale.applied, undefined)
  assert.equal(stale.closedLoading, false)
  const nextExternal = new AbortController()
  const b = guard.begin(nextExternal.signal)
  assert.equal(b.isCurrent(), true)
  assert.equal(abortListenerCount(external.signal), 0)
  assert.equal(abortListenerCount(nextExternal.signal), 1)
  b.end()
  assert.equal(b.isCurrent(), true)
  assert.equal(abortListenerCount(nextExternal.signal), 0)
})

test('unmount invalidates in-flight request so late success does not apply', async () => {
  const guard = createLatestRequestGuard()
  const pending = deferred<string>()
  const run = runGuarded(guard.begin, () => pending.promise)
  guard.invalidate()
  pending.resolve('after-unmount')
  const result = await run
  assert.equal(result.applied, undefined)
  assert.equal(result.closedLoading, false)
  assert.equal(result.current, false)
})

test('current request end still allows finally to close its own loading', async () => {
  const guard = createLatestRequestGuard()
  const pending = deferred<string>()
  const run = runGuarded(guard.begin, () => pending.promise)
  pending.resolve('ok')
  const result = await run
  assert.equal(result.applied, 'ok')
  assert.equal(result.closedLoading, true)
})

test('guard methods stay stable', () => {
  const guard = createLatestRequestGuard()
  const { begin, invalidate } = guard
  begin()
  invalidate()
  begin()
  assert.equal(guard.begin, begin)
  assert.equal(guard.invalidate, invalidate)
})

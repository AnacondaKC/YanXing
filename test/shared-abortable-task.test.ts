import assert from 'node:assert/strict'
import test from 'node:test'

import { createSharedAbortableTaskMap } from '../lib/documents/document-parser'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

test('shared extraction keeps running until the last waiter cancels', async () => {
  let starts = 0
  let aborted = 0
  const pending = deferred<string>()
  const tasks = createSharedAbortableTaskMap(async (_key, signal) => {
    starts += 1
    const onAbort = () => {
      aborted += 1
      pending.reject(new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await pending.promise
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }, '文档')

  const first = new AbortController()
  const second = new AbortController()
  const firstResult = tasks.run('file.docx', first.signal)
  const secondResult = tasks.run('file.docx', second.signal)
  first.abort()
  await assert.rejects(firstResult, /解析已取消/)
  assert.equal(starts, 1)
  assert.equal(aborted, 0)
  pending.resolve('ok')
  assert.equal(await secondResult, 'ok')
  assert.equal(aborted, 0)
})

test('shared extraction aborts the worker after the last waiter leaves', async () => {
  let aborted = 0
  const pending = deferred<string>()
  const tasks = createSharedAbortableTaskMap(async (_key, signal) => {
    const onAbort = () => {
      aborted += 1
      pending.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    try {
      return await pending.promise
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }, '文档')

  const first = new AbortController()
  const second = new AbortController()
  const firstResult = tasks.run('file.pdf', first.signal)
  const secondResult = tasks.run('file.pdf', second.signal)
  first.abort()
  second.abort()
  await assert.rejects(firstResult, /解析已取消/)
  await assert.rejects(secondResult, /解析已取消/)
  assert.equal(aborted, 1)
})

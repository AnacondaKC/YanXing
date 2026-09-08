import assert from 'node:assert/strict'
import test from 'node:test'
import { CHECKPOINT_BUSY_MAX_ATTEMPTS, isTransientSqliteBusyError, retryOnSqliteBusy } from '../lib/db/checkpoint-retry'

test('retryOnSqliteBusy retries only SQLITE_BUSY then succeeds', async () => {
  let attempts = 0
  const result = await retryOnSqliteBusy(() => {
    attempts += 1
    if (attempts < 3) {
      const error = new Error('database is locked')
      ;(error as Error & { code: string }).code = 'SQLITE_BUSY'
      throw error
    }
    return 'ok'
  })
  assert.equal(result, 'ok')
  assert.equal(attempts, 3)
})

test('retryOnSqliteBusy does not retry non-busy errors', async () => {
  let attempts = 0
  await assert.rejects(
    () => retryOnSqliteBusy(() => {
      attempts += 1
      throw new Error('任务已停止，不能保存 AI 调用检查点。')
    }),
    /任务已停止/,
  )
  assert.equal(attempts, 1)
})

test('retryOnSqliteBusy stops after three busy failures', async () => {
  let attempts = 0
  await assert.rejects(
    () => retryOnSqliteBusy(() => {
      attempts += 1
      const error = new Error('SQLITE_BUSY: database is locked')
      ;(error as Error & { code: string }).code = 'SQLITE_BUSY'
      throw error
    }),
    /SQLITE_BUSY/,
  )
  assert.equal(attempts, CHECKPOINT_BUSY_MAX_ATTEMPTS)
})

test('retryOnSqliteBusy aborts the wait without retrying the agent', async () => {
  const controller = new AbortController()
  let attempts = 0
  const pending = retryOnSqliteBusy(() => {
    attempts += 1
    const error = new Error('database is locked')
    ;(error as Error & { code: string }).code = 'SQLITE_BUSY'
    throw error
  }, { signal: controller.signal })
  controller.abort()
  await assert.rejects(() => pending, /Analysis cancelled/)
  assert.equal(attempts, 1)
})

test('isTransientSqliteBusyError ignores lease and cancel errors', () => {
  assert.equal(isTransientSqliteBusyError(new Error('任务租约已失效，不能完成 AI 调用记录。')), false)
  const busy = new Error('database is locked')
  ;(busy as Error & { code: string }).code = 'SQLITE_BUSY'
  assert.equal(isTransientSqliteBusyError(busy), true)
})

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const directory = await mkdtemp(`${tmpdir()}/yanxing-rate-limit-`)
process.env.YANXING_DATABASE_PATH = path.join(directory, 'rate-limit.sqlite')

const { getDatabase } = await import('../lib/db/client')
const { checkRateLimit, waitForRateLimit } = await import('../lib/security/rate-limit')

test.after(async () => {
  getDatabase().close()
  await rm(directory, { recursive: true, force: true })
})

test('persistent limiter uses one rolling window and fixed-size bucket keys', () => {
  const rule = { limit: 2, windowMs: 60_000 }
  assert.equal(checkRateLimit('rolling-window-test', rule).allowed, true)
  assert.equal(checkRateLimit('rolling-window-test', rule).allowed, true)
  const rejected = checkRateLimit('rolling-window-test', rule)
  assert.equal(rejected.allowed, false)
  assert.equal(rejected.remaining, 0)

  const database = getDatabase()
  database.prepare('UPDATE rate_limit_buckets SET window_started_at = ?').run(Date.now() - rule.windowMs - 1)
  assert.equal(checkRateLimit('rolling-window-test', rule).allowed, true)

  const row = database.prepare('SELECT bucket_key, count FROM rate_limit_buckets ORDER BY updated_at DESC LIMIT 1').get() as { bucket_key: string; count: number }
  assert.ok(row.bucket_key.length <= 19)
  assert.equal(row.count, 1)
})

test('waiting for a rate-limit slot does not consume rejected attempts', async () => {
  const rule = { limit: 1, windowMs: 10_000 }
  const database = getDatabase()
  assert.equal(checkRateLimit('wait-side-effect-test', rule).allowed, true)
  const bucket = database.prepare('SELECT bucket_key, count FROM rate_limit_buckets ORDER BY updated_at DESC LIMIT 1').get() as { bucket_key: string; count: number }
  const controller = new AbortController()
  const waiting = waitForRateLimit('wait-side-effect-test', rule, controller.signal)
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(waiting, /请求已取消/)
  const row = database.prepare('SELECT count FROM rate_limit_buckets WHERE bucket_key = ?').get(bucket.bucket_key) as { count: number }
  assert.equal(row.count, bucket.count)
})

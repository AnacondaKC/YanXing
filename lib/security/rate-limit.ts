import { getDatabase } from '@/lib/db/client'

export interface RateLimitRule {
  limit: number
  windowMs: number
}

export interface RateLimitDecision {
  allowed: boolean
  limit: number
  remaining: number
  retryAfterSeconds: number
  unavailable?: boolean
}

const maxPersistentBuckets = 100_000
const unavailableRetrySeconds = 5
const rateLimitBusyTimeoutMs = 100
const rateLimitCleanupIntervalMs = 60_000
let nextRateLimitCleanupAt = 0

/** SQLite 中每个键只有一个滚动窗口桶，所有 Web 实例共享同一计数。数据库不可用时拒绝请求，避免多实例降级绕过限流。 */
export function checkRateLimit(key: string, rule: RateLimitRule): RateLimitDecision {
  const limit = Math.max(1, Math.floor(rule.limit))
  const windowMs = Math.max(1_000, Math.floor(rule.windowMs))
  const now = Date.now()
  const bucketKey = boundedBucketKey(key, windowMs, limit)
  let database: ReturnType<typeof getDatabase> | undefined
  let previousBusyTimeout: number | undefined
  try {
    database = getDatabase()
    const busyTimeoutRow = database.prepare('PRAGMA busy_timeout').get() as { timeout?: unknown } | undefined
    const configuredBusyTimeout = Number(busyTimeoutRow?.timeout)
    previousBusyTimeout = Number.isSafeInteger(configuredBusyTimeout) && configuredBusyTimeout >= 0 ? configuredBusyTimeout : undefined
    // 限流是保护边界，不应因另一条业务写事务让 Web 事件循环同步卡满 5 秒。
    database.exec(`PRAGMA busy_timeout = ${rateLimitBusyTimeoutMs}`)
    database.exec('BEGIN IMMEDIATE')
    try {
      // 过期桶按进程周期清理，避免每个请求都在写事务内扫描/删除整张桶表。
      if (now >= nextRateLimitCleanupAt) {
        nextRateLimitCleanupAt = now + rateLimitCleanupIntervalMs
        const staleBefore = now - Math.max(windowMs * 2, 60_000)
        database.prepare('DELETE FROM rate_limit_buckets WHERE window_started_at < ?').run(staleBefore)
      }
      const current = database.prepare('SELECT window_started_at, count FROM rate_limit_buckets WHERE bucket_key = ? ORDER BY window_started_at DESC LIMIT 1').get(bucketKey) as { window_started_at?: unknown; count?: unknown } | undefined
      const currentStartedAt = Number(current?.window_started_at)
      const hasCurrentWindow = Number.isSafeInteger(currentStartedAt) && currentStartedAt <= now && currentStartedAt + windowMs > now
      let count: number
      let windowStartedAt: number
      if (hasCurrentWindow) {
        windowStartedAt = currentStartedAt
        const currentCount = Number(current?.count ?? 0)
        if (!Number.isSafeInteger(currentCount) || currentCount < 0) throw new Error('限流桶计数无效。')
        // 已达上限时只返回拒绝，不再写入计数；等待中的调用不会消耗未来 slot。
        if (currentCount >= limit) {
          database.exec('COMMIT')
          return decision(Math.max(limit + 1, currentCount), limit, windowStartedAt + windowMs, now)
        }
        const update = database.prepare('UPDATE rate_limit_buckets SET count = count + 1, updated_at = ? WHERE bucket_key = ? AND window_started_at = ?').run(new Date(now).toISOString(), bucketKey, windowStartedAt)
        if (Number(update.changes) !== 1) throw new Error('限流桶更新失败。')
        count = currentCount + 1
      } else {
        const bucketCount = Number((database.prepare('SELECT COUNT(*) AS count FROM rate_limit_buckets').get() as { count?: unknown } | undefined)?.count ?? 0)
        if (bucketCount >= maxPersistentBuckets) {
          database.exec('COMMIT')
          return decision(limit + 1, limit, now + unavailableRetrySeconds * 1_000, now)
        }
        windowStartedAt = now
        database.prepare('INSERT INTO rate_limit_buckets(bucket_key, window_started_at, count, updated_at) VALUES (?, ?, 1, ?)').run(bucketKey, windowStartedAt, new Date(now).toISOString())
        count = 1
      }
      database.exec('COMMIT')
      return decision(count, limit, windowStartedAt + windowMs, now)
    } catch (error) {
      try { database.exec('ROLLBACK') } catch { /* transaction already closed */ }
      throw error
    }
  } catch {
    try { database?.exec('ROLLBACK') } catch { /* transaction already closed */ }
    return {
      allowed: false,
      limit,
      remaining: 0,
      retryAfterSeconds: unavailableRetrySeconds,
      unavailable: true,
    }
  } finally {
    if (database && previousBusyTimeout !== undefined) {
      try { database.exec(`PRAGMA busy_timeout = ${previousBusyTimeout}`) } catch { /* connection may already be closed */ }
    }
  }
}

/** 只读查看当前窗口；不会创建/递增桶，供等待中的上游调用使用。 */
function peekRateLimit(key: string, rule: RateLimitRule): RateLimitDecision {
  const limit = Math.max(1, Math.floor(rule.limit))
  const windowMs = Math.max(1_000, Math.floor(rule.windowMs))
  const now = Date.now()
  const bucketKey = boundedBucketKey(key, windowMs, limit)
  try {
    const database = getDatabase()
    const current = database.prepare('SELECT window_started_at, count FROM rate_limit_buckets WHERE bucket_key = ? ORDER BY window_started_at DESC LIMIT 1').get(bucketKey) as { window_started_at?: unknown; count?: unknown } | undefined
    const windowStartedAt = Number(current?.window_started_at)
    const count = Number(current?.count ?? 0)
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('限流桶计数无效。')
    if (Number.isSafeInteger(windowStartedAt) && windowStartedAt <= now && windowStartedAt + windowMs > now) {
      return decision(count >= limit ? Math.max(limit + 1, count) : count, limit, windowStartedAt + windowMs, now)
    }
    return decision(0, limit, now + windowMs, now)
  } catch {
    return { allowed: false, limit, remaining: 0, retryAfterSeconds: unavailableRetrySeconds, unavailable: true }
  }
}

export class RateLimitUnavailableError extends Error {
  constructor() {
    super('限流服务暂时不可用。')
    this.name = 'RateLimitUnavailableError'
  }
}

export async function waitForRateLimit(key: string, rule: RateLimitRule, signal?: AbortSignal): Promise<void> {
  while (true) {
    if (signal?.aborted) throw abortCancellation()
    const current = peekRateLimit(key, rule)
    if (current.unavailable) throw new RateLimitUnavailableError()
    if (current.allowed) {
      if (signal?.aborted) throw abortCancellation()
      const claimed = checkRateLimit(key, rule)
      if (claimed.unavailable) throw new RateLimitUnavailableError()
      if (claimed.allowed) return
      await delay(Math.max(1, claimed.retryAfterSeconds * 1_000), signal)
      continue
    }
    await delay(Math.max(1, current.retryAfterSeconds * 1_000), signal)
  }
}

function decision(count: number, limit: number, resetAt: number, now: number): RateLimitDecision {
  return {
    allowed: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1_000)),
  }
}

/** 将外部/用户输入压缩为固定长度键；碰撞只会造成更严格限流，不会扩大放行范围。 */
function boundedBucketKey(key: string, windowMs: number, limit: number) {
  const input = key + ':' + windowMs + ':' + limit
  let hash = 14_695_981_039_346_656_037n
  for (const character of input) {
    hash ^= BigInt(character.codePointAt(0) ?? 0)
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n)
  }
  return 'rl:' + hash.toString(16).padStart(16, '0')
}

function delay(milliseconds: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(abortCancellation())
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort)
    const timer = setTimeout(() => { cleanup(); resolve() }, milliseconds)
    const abort = () => { clearTimeout(timer); cleanup(); reject(abortCancellation()) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function abortCancellation() {
  return new DOMException('请求已取消。', 'AbortError')
}

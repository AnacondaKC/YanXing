import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { getAiBudgetSevenDayStartKey, isAiBudgetLimits, isValidAiBudgetLimit, type AiBudgetLimits, type AiBudgetSettingsResponse } from '../lib/ai/budget-settings'

const directory = await mkdtemp(path.join(tmpdir(), 'yanxing-budget-settings-'))
process.env.YANXING_DATABASE_PATH = path.join(directory, 'settings.sqlite')
const { getDatabase } = await import('../lib/db/client')
const { createSession, sessionCookieName } = await import('../lib/auth/session')
const { runtimeConfig } = await import('../lib/config/environment')
const { pageAnalysisModule } = await import('../modules/analysis/modules')
const { getAiBudgetSettings, getAiBudgetLimits, getAiBudgetUsage, saveAiBudgetSettings, AiBudgetSettingsAccessError } = await import('../lib/db/ai-budget-settings-repository')
const { GET, PUT } = await import('../app/api/admin/ai-budget-settings/route')
const { runMigrations } = await import('../lib/db/migrate')
const database = getDatabase()
const timestamp = new Date().toISOString()
for (const [id, role] of [['admin', 'admin'], ['other-admin', 'admin'], ['researcher', 'researcher']]) {
  database.prepare('INSERT INTO users(id, username, display_name, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, id, id, 'unused', role, 'active', timestamp, timestamp)
}
const adminToken = createSession('admin').token
const researcherToken = createSession('researcher').token
const otherAdminToken = createSession('other-admin').token
const limits: AiBudgetLimits = { dailyTokens: 100, sevenDayTokens: 50 }

function request(input: { body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
  return new Request('http://localhost/api/admin/ai-budget-settings', {
    method: input.body === undefined ? 'GET' : 'PUT',
    headers: { ...(input.token ? { cookie: sessionCookieName + '=' + input.token } : {}), ...input.headers },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  })
}

function insertUsage(target: DatabaseSync, input: { id: string; state: string; period: string; actual?: number | null; userId?: string; projectId?: string }) {
  target.prepare(
    "INSERT INTO ai_budget_ledger(id, user_id, project_id, operation, period_key, reserved_tokens, actual_tokens, state, available_at, expires_at, created_at, updated_at) VALUES (?, ?, ?, 'insight', ?, 100, ?, ?, ?, ?, ?, ?)",
  ).run(input.id, input.userId ?? 'admin', input.projectId ?? 'p1', input.period, input.actual ?? null, input.state, timestamp, timestamp, timestamp, timestamp)
}

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

test('shared validation rejects coercion and accepts independent positive safe integer limits', () => {
  for (const value of [undefined, null, false, true, '', '1', 0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1n, {}, []]) {
    assert.equal(isValidAiBudgetLimit(value), false)
    for (const field of Object.keys(limits)) assert.equal(isAiBudgetLimits({ ...limits, [field]: value }), false)
  }
  assert.equal(isValidAiBudgetLimit(1), true)
  assert.equal(isValidAiBudgetLimit(Number.MAX_SAFE_INTEGER), true)
  assert.equal(isAiBudgetLimits(limits), true)
  for (const value of [null, [], {}, 1, 'limits']) assert.equal(isAiBudgetLimits(value), false)
  for (const field of ['scope', 'userId', 'obsolete', 'extra']) {
    assert.equal(isAiBudgetLimits({ ...limits, [field]: 1 }), false)
  }
  assert.equal(isAiBudgetLimits({ dailyTokens: 1, sevenDayTokens: Number.MAX_SAFE_INTEGER }), true)
})

test('GET requires admin, exposes env defaults without seeding, and never caches changing usage', async () => {
  assert.equal((await GET(request())).status, 401)
  assert.equal((await GET(request({ token: researcherToken }))).status, 403)
  const previous = process.env.YANXING_AI_DAILY_TOKENS
  const previousSevenDay = process.env.YANXING_AI_SEVEN_DAY_TOKENS
  try {
    delete process.env.YANXING_AI_DAILY_TOKENS
    delete process.env.YANXING_AI_SEVEN_DAY_TOKENS
    assert.deepEqual(getAiBudgetLimits(), { dailyTokens: 5_000_000, sevenDayTokens: 35_000_000 })
    process.env.YANXING_AI_DAILY_TOKENS = '1234567'
    process.env.YANXING_AI_SEVEN_DAY_TOKENS = '3456789'
    const response = await GET(request({ token: adminToken }))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('etag'), '"budget-1"')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = await response.json() as AiBudgetSettingsResponse
    assert.deepEqual(body.settings, { dailyTokens: 1234567, sevenDayTokens: 3456789, revision: 1, updatedAt: null, updatedBy: null })
    assert.deepEqual(body.usage, { dailyTokens: 0, sevenDayTokens: 0 })
    assert.equal(body.periodKey, timestamp.slice(0, 10))
    assert.equal(body.reservation.analysisTokens, runtimeConfig.ai.pageAnalysisEstimatedTokens * pageAnalysisModule.maxAttempts)
    assert.equal(body.reservation.insightTokens, runtimeConfig.ai.insightEstimatedTokens)
    assert.deepEqual(Object.keys(body.reservation).sort(), ['analysisTokens', 'insightTokens'])
    assert.equal(body.sevenDayStartKey, getAiBudgetSevenDayStartKey(body.periodKey))
    assert.deepEqual(Object.keys(body).sort(), ['periodKey', 'reservation', 'settings', 'sevenDayStartKey', 'usage'])
    process.env.YANXING_AI_DAILY_TOKENS = '7654321'
    assert.equal(getAiBudgetLimits().dailyTokens, 7654321)
    assert.equal(database.prepare('SELECT count(*) AS count FROM ai_budget_settings').get()?.count, 0)
    const conditional = await GET(request({ token: adminToken, headers: { 'if-none-match': '"budget-1"' } }))
    assert.equal(conditional.status, 200)
  } finally {
    if (previous === undefined) delete process.env.YANXING_AI_DAILY_TOKENS
    else process.env.YANXING_AI_DAILY_TOKENS = previous
    if (previousSevenDay === undefined) delete process.env.YANXING_AI_SEVEN_DAY_TOKENS
    else process.env.YANXING_AI_SEVEN_DAY_TOKENS = previousSevenDay
  }
})

test('PUT validates body, authorization, revisions and numeric boundaries without mutating settings', async () => {
  assert.equal((await PUT(request({ body: { revision: 1, limits } }))).status, 401)
  assert.equal((await PUT(request({ body: { revision: 1, limits }, token: researcherToken }))).status, 403)
  for (const body of [null, [], 4, 'x', { revision: 1, limits: {} }, { revision: '1', limits }, { revision: 0, limits }]) {
    assert.equal((await PUT(request({ token: adminToken, body }))).status, 400)
  }
  for (const value of [null, '100', 0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
    for (const field of Object.keys(limits)) {
      assert.equal((await PUT(request({ token: adminToken, body: { revision: 1, limits: { ...limits, [field]: value } } }))).status, 400)
    }
  }
  assert.equal((await PUT(request({ token: adminToken, body: { limits } }))).status, 428)
  for (const header of ['"models-1"', '*', '"budget-0"', '"budget-9007199254740992"', '"budget-2"']) {
    assert.equal((await PUT(request({ token: adminToken, body: { revision: 1, limits }, headers: { 'if-match': header } }))).status, 400)
  }
  const invalidJson = new Request('http://localhost/api/admin/ai-budget-settings', { method: 'PUT', headers: { cookie: sessionCookieName + '=' + adminToken }, body: '{' })
  assert.equal((await PUT(invalidJson)).status, 400)
  assert.equal((await PUT(request({ token: adminToken, body: { revision: 1, limits, padding: 'x'.repeat(4096) } }))).status, 413)
  for (const extra of [{ obsolete: 1 }, { scope: 'global' }, { extra: 1 }]) {
    assert.equal((await PUT(request({ token: adminToken, body: { revision: 1, limits: { ...limits, ...extra } } }))).status, 400)
  }
  assert.equal(getAiBudgetSettings().revision, 1)
})

test('PUT persists shared limits while GET and save return only the current administrator usage', async () => {
  insertUsage(database, { id: 'admin-usage', state: 'settled', period: timestamp.slice(0, 10), actual: 20 })
  insertUsage(database, { id: 'other-admin-usage', state: 'settled', period: timestamp.slice(0, 10), actual: 30, userId: 'other-admin' })
  const results = await Promise.all([PUT(request({ token: adminToken, body: { revision: 1, limits } })), PUT(request({ token: adminToken, body: { revision: 1, limits } }))])
  assert.deepEqual(results.map((response) => response.status).sort(), [200, 409])
  const saved = await results.find((response) => response.status === 200)!.json() as AiBudgetSettingsResponse
  assert.deepEqual(saved.usage, { dailyTokens: 20, sevenDayTokens: 20 })
  const otherResponse = await GET(request({ token: otherAdminToken }))
  const other = await otherResponse.json() as AiBudgetSettingsResponse
  assert.deepEqual(other.usage, { dailyTokens: 30, sevenDayTokens: 30 })
  assert.deepEqual(other.settings, saved.settings)
  assert.equal(saved.settings.revision, 2)
  assert.equal(saved.settings.updatedBy, 'admin')
  assert.ok(saved.settings.updatedAt)
  assert.deepEqual(getAiBudgetLimits(), limits)
  const stale = await PUT(request({ token: adminToken, body: { limits }, headers: { 'if-match': '"budget-1"' } }))
  assert.equal(stale.status, 412)
  const maxLimits = { dailyTokens: Number.MAX_SAFE_INTEGER, sevenDayTokens: 1 }
  const response = await PUT(request({ token: otherAdminToken, body: { limits: maxLimits }, headers: { 'if-match': '"budget-2"' } }))
  assert.equal(response.status, 200)
  assert.deepEqual(getAiBudgetLimits(), maxLimits)
  assert.equal(getAiBudgetSettings().revision, 3)
  const otherSaved = await response.json() as AiBudgetSettingsResponse
  assert.deepEqual(otherSaved.usage, { dailyTokens: 30, sevenDayTokens: 30 })
  assert.equal(otherSaved.settings.updatedBy, 'other-admin')
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('admin permission is checked again after asynchronous request body reading', async () => {
  let deliver: ReadableStreamDefaultController<Uint8Array> | undefined
  const stream = new ReadableStream<Uint8Array>({ start(controller) { deliver = controller } })
  const init = { method: 'PUT', headers: { cookie: sessionCookieName + '=' + adminToken }, body: stream, duplex: 'half' }
  const response = PUT(new Request('http://localhost/api/admin/ai-budget-settings', init))
  database.prepare("UPDATE users SET role = 'researcher' WHERE id = 'admin'").run()
  deliver!.enqueue(new TextEncoder().encode(JSON.stringify({ revision: 3, limits })))
  deliver!.close()
  try {
    assert.equal((await response).status, 403)
    assert.equal(getAiBudgetSettings().revision, 3)
    assert.throws(() => saveAiBudgetSettings({ revision: 3, limits, actorId: 'admin' }), AiBudgetSettingsAccessError)
    database.prepare("UPDATE users SET role = 'admin', status = 'disabled' WHERE id = 'admin'").run()
    assert.throws(() => saveAiBudgetSettings({ revision: 3, limits, actorId: 'admin' }), AiBudgetSettingsAccessError)
  } finally {
    database.prepare("UPDATE users SET role = 'admin', status = 'active' WHERE id = 'admin'").run()
  }
})

test('usage counts only personal reservations and actual usage in the inclusive seven UTC dates', () => {
  const target = new DatabaseSync(':memory:')
  try {
    runMigrations(target)
    const periodKey = '2026-06-01'
    insertUsage(target, { id: 'reserved', state: 'reserved', period: periodKey, actual: 999 })
    insertUsage(target, { id: 'settled', state: 'settled', period: periodKey, actual: 20 })
    insertUsage(target, { id: 'uncertain', state: 'uncertain', period: periodKey })
    insertUsage(target, { id: 'dead', state: 'dead_letter', period: periodKey, actual: 30 })
    insertUsage(target, { id: 'released', state: 'released', period: periodKey, actual: 999 })
    insertUsage(target, { id: 'other', state: 'settled', period: periodKey, actual: 999, userId: 'other' })
    insertUsage(target, { id: 'past', state: 'settled', period: '2026-05-31', actual: 40, projectId: 'p2' })
    insertUsage(target, { id: 'start', state: 'settled', period: '2026-05-26', actual: 50 })
    insertUsage(target, { id: 'expired', state: 'settled', period: '2026-05-25', actual: 999 })
    insertUsage(target, { id: 'future', state: 'settled', period: '2026-06-02', actual: 999 })
    insertUsage(target, { id: 'zero', state: 'settled', period: periodKey, actual: 0 })
    assert.deepEqual(getAiBudgetUsage(target, { userId: 'admin', periodKey }), { dailyTokens: 250, sevenDayTokens: 340 })
    assert.deepEqual(getAiBudgetUsage(target, { userId: 'other', periodKey }), { dailyTokens: 999, sevenDayTokens: 999 })
    assert.deepEqual(getAiBudgetUsage(target, { userId: 'unused', periodKey }), { dailyTokens: 0, sevenDayTokens: 0 })
    assert.throws(() => getAiBudgetUsage(target, { userId: '', periodKey }), /用户无效/)
    target.prepare("UPDATE ai_budget_ledger SET actual_tokens = -1000 WHERE id = 'settled'").run()
    assert.throws(() => getAiBudgetUsage(target, { userId: 'admin', periodKey }), /用量存储无效/)
  } finally { target.close() }
})

test('seven UTC dates cross year and leap-month boundaries, not calendar weeks or lifetime', () => {
  for (const [periodKey, startKey, expiredKey, futureKey] of [
    ['2026-01-03', '2025-12-28', '2025-12-27', '2026-01-04'],
    ['2024-03-01', '2024-02-24', '2024-02-23', '2024-03-02'],
  ]) {
    const target = new DatabaseSync(':memory:')
    try {
      runMigrations(target)
      assert.equal(getAiBudgetSevenDayStartKey(periodKey), startKey)
      insertUsage(target, { id: 'start', state: 'settled', period: startKey, actual: 10 })
      insertUsage(target, { id: 'today', state: 'settled', period: periodKey, actual: 20 })
      insertUsage(target, { id: 'expired', state: 'settled', period: expiredKey, actual: 1000 })
      insertUsage(target, { id: 'future', state: 'reserved', period: futureKey })
      assert.deepEqual(getAiBudgetUsage(target, { userId: 'admin', periodKey }), { dailyTokens: 20, sevenDayTokens: 30 })
    } finally { target.close() }
  }
  for (const periodKey of ['2026-02-30', '2026-1-01', '', 'invalid', '2026-01-01T00:00:00Z']) {
    assert.throws(() => getAiBudgetSevenDayStartKey(periodKey), /日期无效/)
  }
})

test('invalid stored settings and exhausted revision fail closed without overwriting', async () => {
  database.exec('PRAGMA ignore_check_constraints = ON')
  try {
    for (const value of [0, -1, 1.5, 'corrupted']) {
      database.prepare('UPDATE ai_budget_settings SET daily_tokens = ?').run(value)
      assert.throws(() => getAiBudgetLimits(), /存储无效/)
      assert.equal((await GET(request({ token: adminToken }))).status, 500)
      assert.equal((await PUT(request({ token: adminToken, body: { revision: 3, limits } }))).status, 500)
    }
    database.prepare('UPDATE ai_budget_settings SET daily_tokens = 1, revision = ?').run(Number.MAX_SAFE_INTEGER)
    assert.throws(() => saveAiBudgetSettings({ revision: Number.MAX_SAFE_INTEGER, limits, actorId: 'admin' }), /版本已达到上限/)
  } finally {
    database.prepare('UPDATE ai_budget_settings SET daily_tokens = 1, revision = 3').run()
    database.exec('PRAGMA ignore_check_constraints = OFF')
  }
})


test('saving rolls back limits and revision if personal usage cannot be returned safely', () => {
  const before = getAiBudgetSettings()
  insertUsage(database, { id: 'invalid-usage', state: 'settled', period: timestamp.slice(0, 10), actual: -1000 })
  try {
    assert.throws(() => saveAiBudgetSettings({ revision: before.revision, limits, actorId: 'admin' }), /用量存储无效/)
    assert.deepEqual(getAiBudgetSettings(), before)
  } finally {
    database.prepare("DELETE FROM ai_budget_ledger WHERE id = 'invalid-usage'").run()
  }
})


import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { AiBudgetLimits, AiBudgetSettingsResponse } from '../lib/ai/budget-settings'

const directory = await mkdtemp(path.join(tmpdir(), 'yanxing-budget-admission-'))
const originalDatabasePath = process.env.YANXING_DATABASE_PATH
const originalDailyTokens = process.env.YANXING_AI_DAILY_TOKENS
process.env.YANXING_DATABASE_PATH = path.join(directory, 'admission.sqlite')

const { getDatabase } = await import('../lib/db/client')
const { createOrUpdateUser, createSession, sessionCookieName } = await import('../lib/auth/session')
const { AiBudgetError, reserveAiBudget, settleAiBudgetInDatabase } = await import('../lib/ai/budget')
const { createProjectForUser } = await import('../lib/db/repository')
const { GET, PUT } = await import('../app/api/admin/ai-budget-settings/route')
const admin = createOrUpdateUser({ username: 'budget-admission-admin', displayName: '预算测试管理员', password: 'budget-admission-password', role: 'admin' })
const session = createSession(admin.id)
const secondUser = createOrUpdateUser({ username: 'budget-second-user', displayName: '另一用户', password: 'budget-admission-password', role: 'researcher' })
const project = createProjectForUser({ title: '预算测试课题', objective: '验证用户额度隔离', description: '', ownerName: admin.displayName }, admin.id)
const otherProject = createProjectForUser({ title: '预算测试另一课题', objective: '验证用户跨课题汇总', description: '', ownerName: admin.displayName }, admin.id)
const generousLimits: AiBudgetLimits = { dailyTokens: 100_000, sevenDayTokens: 100_000 }

function request(method: string, body?: unknown) {
  return new Request('http://localhost/api/admin/ai-budget-settings', {
    method,
    headers: { 'content-type': 'application/json', cookie: sessionCookieName + '=' + encodeURIComponent(session.token) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function readSettings(): Promise<AiBudgetSettingsResponse> {
  const response = await GET(request('GET'))
  assert.equal(response.status, 200)
  return response.json() as Promise<AiBudgetSettingsResponse>
}

async function saveLimits(limits: AiBudgetLimits) {
  const current = await readSettings()
  const response = await PUT(request('PUT', { revision: current.settings.revision, limits }))
  assert.equal(response.status, 200, await response.text())
}

function reserve(tokens: number, input: { userId?: string; projectId?: string } = {}) {
  return reserveAiBudget({ userId: input.userId ?? admin.id, projectId: input.projectId, operation: 'analysis', estimatedTokens: tokens })
}

function isBudgetExceeded(error: unknown) {
  return error instanceof AiBudgetError && error.reason === 'budget'
}

test.beforeEach(() => {
  getDatabase().exec('DELETE FROM ai_budget_ledger; DELETE FROM ai_budget_settings;')
  process.env.YANXING_AI_DAILY_TOKENS = '100'
})

test.after(async () => {
  getDatabase().close()
  await rm(directory, { recursive: true, force: true })
  if (originalDatabasePath === undefined) delete process.env.YANXING_DATABASE_PATH
  else process.env.YANXING_DATABASE_PATH = originalDatabasePath
  if (originalDailyTokens === undefined) delete process.env.YANXING_AI_DAILY_TOKENS
  else process.env.YANXING_AI_DAILY_TOKENS = originalDailyTokens
})

test('saved budget limits immediately control admission without clearing existing reservations', async () => {
  assert.throws(() => reserve(101), isBudgetExceeded)
  await saveLimits({ ...generousLimits, dailyTokens: 1_000 })
  process.env.YANXING_AI_DAILY_TOKENS = '1'
  const firstReservation = reserve(100)
  reserve(899)
  assert.throws(() => reserve(2), isBudgetExceeded)
  assert.equal((await readSettings()).usage.dailyTokens, 999)

  await saveLimits({ ...generousLimits, dailyTokens: 1 })
  assert.throws(() => reserve(1), isBudgetExceeded)
  assert.equal(getDatabase().prepare('SELECT state FROM ai_budget_ledger WHERE id = ?').get(firstReservation)?.state, 'reserved')
  assert.equal((await readSettings()).usage.dailyTokens, 999)

  await saveLimits({ ...generousLimits, dailyTokens: 2_000 })
  reserve(1_001)
  assert.equal((await readSettings()).usage.dailyTokens, 2_000)
  assert.throws(() => reserve(1), isBudgetExceeded)
})

test('each persisted daily and seven-day token limit independently blocks new admissions', async () => {
  for (const key of Object.keys(generousLimits) as (keyof AiBudgetLimits)[]) {
    await saveLimits({ ...generousLimits, [key]: 50 })
    assert.throws(() => reserve(51), isBudgetExceeded, key)
    const response = await readSettings()
    assert.equal(response.usage.dailyTokens, 0)
  }
})

test('users have independent budgets even in the same project, while one user shares usage across projects', async () => {
  await saveLimits({ dailyTokens: 100, sevenDayTokens: 100 })
  reserve(60, { projectId: project.id })
  reserve(60, { userId: secondUser.id, projectId: project.id })
  reserve(40, { projectId: otherProject.id })
  assert.throws(() => reserve(1, { projectId: otherProject.id }), isBudgetExceeded)
  reserve(40, { userId: secondUser.id, projectId: project.id })
  assert.throws(() => reserve(1, { userId: secondUser.id }), isBudgetExceeded)
  assert.deepEqual((await readSettings()).usage, { dailyTokens: 100, sevenDayTokens: 100 })
})

test('seven-day admission includes the sixth prior UTC date and advances at UTC midnight', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-02T23:59:59.000Z') })
  await saveLimits({ dailyTokens: 100, sevenDayTokens: 100 })
  function historicalTokens(periodKey: string, tokens: number) {
    getDatabase().prepare(
      "INSERT INTO ai_budget_ledger (id,user_id,operation,period_key,reserved_tokens,actual_tokens,state,available_at,expires_at,created_at,updated_at) VALUES (?,?,'analysis',?,?,?,'settled',?,?,?,?)",
    ).run('history-' + periodKey, admin.id, periodKey, tokens, tokens, periodKey, periodKey, periodKey, periodKey)
  }
  historicalTokens('2025-12-26', 10_000)
  historicalTokens('2025-12-27', 40)
  reserve(60)
  assert.throws(() => reserve(1), isBudgetExceeded)
  assert.deepEqual((await readSettings()).usage, { dailyTokens: 60, sevenDayTokens: 100 })
  context.mock.timers.tick(1_000)
  assert.deepEqual((await readSettings()).usage, { dailyTokens: 0, sevenDayTokens: 60 })
  reserve(40)
  assert.throws(() => reserve(1), isBudgetExceeded)
  assert.deepEqual((await readSettings()).usage, { dailyTokens: 40, sevenDayTokens: 100 })
})

test('settled token usage releases unused estimates', async () => {
  await saveLimits({ dailyTokens: 100, sevenDayTokens: 100 })
  const id = reserve(100)
  assert.equal(settleAiBudgetInDatabase(getDatabase(), { reservationId: id, actualTokens: 20 }), true)
  reserve(80)
  assert.throws(() => reserve(1), isBudgetExceeded)
  assert.deepEqual((await readSettings()).usage, { dailyTokens: 100, sevenDayTokens: 100 })
})

test('saved limits are shared with a separate worker process instead of its environment defaults', async () => {
  const limits = { ...generousLimits, dailyTokens: 1_234 }
  await saveLimits(limits)
  const repositoryUrl = new URL('../lib/db/ai-budget-settings-repository.ts', import.meta.url).href
  const child = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e',
    `const { getAiBudgetLimits } = await import(${JSON.stringify(repositoryUrl)}); console.log(JSON.stringify(getAiBudgetLimits()));`,
  ], { cwd: process.cwd(), env: { ...process.env, YANXING_AI_DAILY_TOKENS: '1' }, encoding: 'utf8', timeout: 10_000 })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout.trim()), limits)
})

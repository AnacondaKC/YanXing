import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ModelProviderError } from '../lib/ai/runtime/errors'
import { requestJson } from '../lib/ai/runtime/http'

const directory = await mkdtemp(path.join(tmpdir(), 'yanxing-http-dns-'))
const originalDatabasePath = process.env.YANXING_DATABASE_PATH
process.env.YANXING_DATABASE_PATH = path.join(directory, 'dns.sqlite')

const { getDatabase, migrateDatabase } = await import('../lib/db/client')
migrateDatabase()

test.after(async () => {
  getDatabase().close()
  await rm(directory, { recursive: true, force: true })
  if (originalDatabasePath === undefined) delete process.env.YANXING_DATABASE_PATH
  else process.env.YANXING_DATABASE_PATH = originalDatabasePath
})

test('native fetch failures preserve DNS classification and retry decisions', async (context) => {
  const cases = [
    ...['ENOTFOUND', 'ENODATA', 'EAI_NODATA'].map((causeCode) => ({ causeCode, code: 'dns_error', retryable: false })),
    ...['EAI_AGAIN', 'SERVFAIL', 'ESERVFAIL', 'ETIME'].map((causeCode) => ({ causeCode, code: 'dns_error', retryable: true })),
    { causeCode: 'CERT_HAS_EXPIRED', code: 'tls_error', retryable: false },
    { causeCode: 'ECONNRESET', code: 'network_error', retryable: true },
    { causeCode: 'ETIMEDOUT', code: 'network_error', retryable: true },
  ]
  for (const expected of cases) {
    await context.test(expected.causeCode, async (subcontext) => {
      const cause = Object.assign(new Error('upstream failure'), { code: expected.causeCode })
      subcontext.mock.method(globalThis, 'fetch', async () => {
        throw new TypeError('fetch failed', { cause: new Error('connector failed', { cause }) })
      })
      await assert.rejects(requestJson({
        url: 'https://dns-test.invalid/v1/chat/completions',
        apiKey: 'test-key',
        providerLabel: '测试模型',
        json: {},
        timeoutMs: 1_000,
      }), (error: unknown) => {
        assert.ok(error instanceof ModelProviderError)
        assert.equal(error.code, expected.code)
        assert.equal(error.retryable, expected.retryable)
        if (expected.code === 'dns_error') assert.equal(error.message, '测试模型 域名无法解析。')
        return true
      })
    })
  }

  await context.test('cyclic cause chains remain bounded', async (subcontext) => {
    const cause = new Error('fetch failed')
    cause.cause = cause
    subcontext.mock.method(globalThis, 'fetch', async () => { throw cause })
    await assert.rejects(requestJson({
      url: 'https://dns-test.invalid/v1/chat/completions',
      apiKey: 'test-key',
      providerLabel: '测试模型',
      timeoutMs: 1_000,
    }), (error: unknown) => {
      assert.ok(error instanceof ModelProviderError)
      assert.equal(error.code, 'network_error')
      assert.equal(error.retryable, true)
      return true
    })
  })
})

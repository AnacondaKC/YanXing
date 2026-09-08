import assert from 'node:assert/strict'
import test from 'node:test'

import { requireSettingsRevision } from '../lib/http/settings-revision'

function makeRequest(headers?: Record<string, string>): Request {
  return new Request('http://localhost/api/admin/settings', { headers })
}

async function errorBody(response: Response): Promise<{ error?: string }> {
  return await response.json() as { error?: string }
}

test('settings revision accepts a body revision', () => {
  const result = requireSettingsRevision(4, makeRequest(), 'models')
  assert.deepEqual(result, { revision: 4 })
})

test('settings revision accepts a matching If-Match revision', () => {
  const result = requireSettingsRevision(undefined, makeRequest({ 'If-Match': '"prompts-7"' }), 'prompts')
  assert.deepEqual(result, { revision: 7 })
})

test('settings revision rejects missing, malformed, invalid, mismatched, and cross-scope values', async () => {
  const cases = [
    [undefined, makeRequest(), 'models', 428],
    [undefined, makeRequest({ 'If-Match': 'models-7' }), 'models', 400],
    [0, makeRequest(), 'models', 400],
    [4, makeRequest({ 'If-Match': '"models-5"' }), 'models', 400],
    [undefined, makeRequest({ 'If-Match': '"prompts-7"' }), 'models', 400],
  ] as const

  for (const [value, request, scope, expectedStatus] of cases) {
    const response = requireSettingsRevision(value, request, scope)
    assert.equal(response instanceof Response, true)
    const body = await errorBody(response as Response)
    assert.equal(typeof body.error, 'string')
    assert.equal((response as Response).status, expectedStatus)
  }
})

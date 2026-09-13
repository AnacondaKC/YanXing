import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHiddenProjectIds, toggleHiddenProjectId } from '../lib/workspace-reports'
import { shouldRedirectToLogin } from '../lib/client-request'

test('hidden project ids ignore malformed localStorage payloads', () => {
  assert.deepEqual(parseHiddenProjectIds(null), [])
  assert.deepEqual(parseHiddenProjectIds('not-json'), [])
  assert.deepEqual(parseHiddenProjectIds('{"foo":1}'), [])
  assert.deepEqual(parseHiddenProjectIds('["a",1,"",null,"b"]'), ['a', 'b'])
  assert.deepEqual(toggleHiddenProjectId(['a'], 'b'), ['a', 'b'])
  assert.deepEqual(toggleHiddenProjectId(['a', 'b'], 'a'), ['b'])
})

test('401 redirects to login except on the login page', () => {
  assert.equal(shouldRedirectToLogin(401, '/'), true)
  assert.equal(shouldRedirectToLogin(401, '/login'), false)
  assert.equal(shouldRedirectToLogin(403, '/'), false)
})

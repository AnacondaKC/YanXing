import assert from 'node:assert/strict'
import test from 'node:test'

import { readRequiredUpdatedAt } from '../lib/http/optimistic-lock'

test('optimistic lock requires a non-empty parseable updatedAt string', () => {
  assert.equal(readRequiredUpdatedAt('2026-01-01T00:00:00.000Z'), '2026-01-01T00:00:00.000Z')
  assert.equal(readRequiredUpdatedAt(undefined), undefined)
  assert.equal(readRequiredUpdatedAt(null), undefined)
  assert.equal(readRequiredUpdatedAt(123), undefined)
  assert.equal(readRequiredUpdatedAt(''), undefined)
  assert.equal(readRequiredUpdatedAt('   '), undefined)
  assert.equal(readRequiredUpdatedAt('not-a-date'), undefined)
})

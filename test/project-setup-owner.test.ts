import assert from 'node:assert/strict'
import test from 'node:test'

import { memberPickerAtCapacity, nextOwnerIdAfterCurrentUser } from '../components/project-setup-guide'

test('capacity disable applies to multi-select only', () => {
  assert.equal(memberPickerAtCapacity(1, 1), false)
  assert.equal(memberPickerAtCapacity(3, 3), true)
  assert.equal(memberPickerAtCapacity(3, 2), false)
  assert.equal(memberPickerAtCapacity(undefined, 8), false)
})

test('async current user fills owner only before the first edit', () => {
  assert.equal(nextOwnerIdAfterCurrentUser({ currentOwnerId: '', currentUserId: 'admin', ownerTouched: false }), 'admin')
  assert.equal(nextOwnerIdAfterCurrentUser({ currentOwnerId: '', currentUserId: 'admin', ownerTouched: true }), '')
  assert.equal(nextOwnerIdAfterCurrentUser({ currentOwnerId: 'other', currentUserId: 'admin', ownerTouched: false }), 'other')
})

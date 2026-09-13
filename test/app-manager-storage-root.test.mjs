import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveManagedTempDirectory } from '../scripts/app-manager.mjs'

test('startup cleanup follows the selected database instead of the retained old storage', () => {
  assert.equal(resolveManagedTempDirectory({ cwd: '/app' }), '/app/storage/tmp')
  assert.equal(resolveManagedTempDirectory({ cwd: '/app', databasePath: '  ' }), '/app/storage/tmp')
  assert.equal(resolveManagedTempDirectory({ cwd: '/app', databasePath: 'storage-native/app.sqlite' }), '/app/storage-native/tmp')
  assert.equal(resolveManagedTempDirectory({ cwd: '/app', databasePath: '/srv/native/app.sqlite' }), '/srv/native/tmp')
})

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertNoIncompleteRestore, createRestoreIncompleteMarker, incompleteRestoreMarkerPresent, removeRestoreIncompleteMarker, restoreIncompleteMarkerPath } from '../lib/storage/native-restore-guard'

test('incomplete restore blocks only its bound runtime, not a sibling instance', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'yanxing-restore-guard-'))
  const first = join(parent, 'first'), second = join(parent, 'second')
  try {
    await createRestoreIncompleteMarker(first)
    assert.notEqual(restoreIncompleteMarkerPath(first), restoreIncompleteMarkerPath(second))
    assert.throws(() => assertNoIncompleteRestore(join(first, 'app.sqlite')), { code: 'RESTORE_INCOMPLETE' })
    assert.doesNotThrow(() => assertNoIncompleteRestore(join(second, 'app.sqlite')))
    await createRestoreIncompleteMarker(second)
    removeRestoreIncompleteMarker(first)
    assert.equal(incompleteRestoreMarkerPresent(first), false)
    assert.equal(incompleteRestoreMarkerPresent(second), true)
    assert.throws(() => assertNoIncompleteRestore(join(second, 'app.sqlite')), { code: 'RESTORE_INCOMPLETE' })
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

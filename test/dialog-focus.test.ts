import assert from 'node:assert/strict'
import test from 'node:test'

import { isTopmostDialog } from '../components/use-dialog-focus'

function node(children: object[] = []) {
  return {
    contains(other: Node) {
      return children.includes(other)
    },
  }
}

test('nested dialog Escape belongs to the innermost registered dialog', () => {
  const child = node()
  const parent = node([child])
  const entries = [parent, child]
  assert.equal(isTopmostDialog(parent, entries), false)
  assert.equal(isTopmostDialog(child, entries), true)
})

test('closing the child restores the remaining parent as topmost', () => {
  const parent = node()
  assert.equal(isTopmostDialog(parent, [parent]), true)
})

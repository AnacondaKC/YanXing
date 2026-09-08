import assert from 'node:assert/strict'
import test from 'node:test'

import { panTowardCursor } from '../components/research-visualization-card'

test('mind map wheel zoom pans relative to the current pan and cursor', () => {
  assert.deepEqual(
    panTowardCursor({ x: 40, y: -20 }, { x: 100, y: 50 }, 2),
    { x: 100 + (40 - 100) * 2, y: 50 + (-20 - 50) * 2 },
  )
  assert.deepEqual(
    panTowardCursor({ x: 0, y: 0 }, { x: 80, y: 60 }, 0.5),
    { x: 80 + (0 - 80) * 0.5, y: 60 + (0 - 60) * 0.5 },
  )
})

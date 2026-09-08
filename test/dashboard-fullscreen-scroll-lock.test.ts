import assert from 'node:assert/strict'
import test from 'node:test'

import { applyFullscreenScrollLock, shouldLockOverviewScroll } from '../lib/workspace-scroll'

function createOverflowTarget(overflow: string) {
  return { style: { overflow } }
}

test('Dashboard fullscreen scroll lock restores workspace and document scrolling when closed', () => {
  const workspace = createOverflowTarget('auto')
  const documentElement = createOverflowTarget('clip')
  const body = createOverflowTarget('scroll')

  const restore = applyFullscreenScrollLock(workspace, documentElement, body)

  assert.equal(workspace.style.overflow, 'hidden')
  assert.equal(documentElement.style.overflow, 'hidden')
  assert.equal(body.style.overflow, 'hidden')

  restore()

  assert.equal(workspace.style.overflow, 'auto')
  assert.equal(documentElement.style.overflow, 'clip')
  assert.equal(body.style.overflow, 'scroll')
})

test('Overview scroll lock engages only when content fits the workspace', () => {
  assert.equal(shouldLockOverviewScroll(800, 800), true)
  assert.equal(shouldLockOverviewScroll(801, 800), true)
  assert.equal(shouldLockOverviewScroll(802, 800), true)
  assert.equal(shouldLockOverviewScroll(803, 800), false)
  assert.equal(shouldLockOverviewScroll(1200, 800), false)
})

test('Dashboard fullscreen scroll lock restores styles during effect cleanup', () => {
  const workspace = createOverflowTarget('')
  const documentElement = createOverflowTarget('visible')
  const body = createOverflowTarget('auto')

  const cleanup = applyFullscreenScrollLock(workspace, documentElement, body)
  cleanup()

  assert.equal(workspace.style.overflow, '')
  assert.equal(documentElement.style.overflow, 'visible')
  assert.equal(body.style.overflow, 'auto')
})

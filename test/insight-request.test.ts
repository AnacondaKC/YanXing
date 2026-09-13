import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { canDispatchInsight } from '../components/insight-workspace'

test('insight regeneration keeps its feedback beside the disabled refresh button', () => {
  const source = readFileSync(new URL('../components/insight-workspace.tsx', import.meta.url), 'utf8')
  const toolbar = source.slice(source.indexOf('aria-label="阅读工具"'), source.indexOf('<iframe'))
  assert.match(toolbar, /role="status" aria-live="polite" aria-atomic="true"/)
  assert.ok(toolbar.indexOf('正在重新生成洞察') < toolbar.indexOf('aria-label="重新生成洞察"'))
  assert.match(toolbar, /disabled={generating} aria-busy={generating}/)
  assert.match(toolbar, /animate-spin motion-reduce:animate-none/)
  assert.match(toolbar, /yx-insight-wait-dots/)
  assert.match(toolbar, /flex-wrap/)
  assert.doesNotMatch(toolbar, /正在重新编排洞察|bg-black/)
  assert.match(toolbar, /role="alert"/)
})

test('insight waiting dots animate opacity without layout shifts and respect reduced motion', () => {
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')
  const dots = css.slice(css.indexOf('.yx-insight-wait-dots {'), css.indexOf('.yx-detail[data-enter="true"] .yx-detail-still-loading'))
  assert.match(dots, /width: 1.2em/)
  assert.match(dots, /animation-delay: 160ms/)
  assert.match(dots, /animation-delay: 320ms/)
  assert.match(dots, /opacity: 0.3/)
  assert.match(dots, /prefers-reduced-motion: reduce/)
  assert.match(dots, /animation: none/)
})

test('insight dispatch never retries unknown or view-only outcomes automatically', () => {
  const source = readFileSync(new URL('../components/insight-workspace.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /onGenerate\(\)|void generateInsight/)
  assert.equal(canDispatchInsight('view'), false)
  assert.equal(canDispatchInsight('none'), false)
  assert.equal(canDispatchInsight('retry'), true)
})

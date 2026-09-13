import assert from 'node:assert/strict'
import test from 'node:test'

import { fitMindMapToViewport } from '../lib/rendering/graph-layout'

const wideMap = { viewBoxWidth: 2445, viewBoxHeight: 784, minZoom: 0.05, maxZoom: 4, padding: 8 }

test('mind map fit keeps the whole map inside the viewport', () => {
  const fit = fitMindMapToViewport({ ...wideMap, viewportWidth: 790, viewportHeight: 508 })
  assert.ok(fit.zoom * wideMap.viewBoxWidth <= 790 - 16, '导图宽度完整落在画布内')
  assert.ok(fit.zoom * wideMap.viewBoxHeight <= 508 - 16, '导图高度完整落在画布内')
})

test('mind map fit maximizes the map instead of shrinking it further', () => {
  const viewport = { viewportWidth: 790, viewportHeight: 508 }
  const fit = fitMindMapToViewport({ ...wideMap, ...viewport })
  // 宽度方向是当前限制条件：再大一点就会溢出，说明已取到最大值
  assert.equal(fit.zoom, Math.floor(((viewport.viewportWidth - 16) / wideMap.viewBoxWidth) * 1000) / 1000)
  assert.ok(fit.zoom * wideMap.viewBoxWidth > viewport.viewportWidth - 16 - 8, '与可用宽度只差取整误差')
})

test('mind map fit fills the shorter side and centers on the longer one', () => {
  const tallMap = { viewBoxWidth: 1070, viewBoxHeight: 2275, minZoom: 0.05, maxZoom: 4, padding: 8 }
  const fit = fitMindMapToViewport({ ...tallMap, viewportWidth: 722, viewportHeight: 318 })
  assert.ok(fit.zoom * tallMap.viewBoxHeight <= 318 - 16)
  assert.ok(fit.panX > 0, '高度受限时横向居中留白')
  assert.equal(fit.panY, (318 - tallMap.viewBoxHeight * fit.zoom) / 2)
})

test('mind map fit never exceeds the zoom limits', () => {
  assert.equal(fitMindMapToViewport({ viewBoxWidth: 10, viewBoxHeight: 10, minZoom: 0.05, maxZoom: 4, viewportWidth: 2000, viewportHeight: 2000 }).zoom, 4)
  assert.equal(fitMindMapToViewport({ viewBoxWidth: 100000, viewBoxHeight: 100000, minZoom: 0.05, maxZoom: 4, viewportWidth: 722, viewportHeight: 318 }).zoom, 0.05)
})

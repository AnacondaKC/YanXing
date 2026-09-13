import assert from 'node:assert/strict'
import test from 'node:test'
import { sparklineGeometry, sparklineValues } from '../lib/sparkline-geometry'

const MINI = { width: 48, height: 20, pad: 1.5 }
const PANEL = { width: 96, height: 28, pad: 2 }
const REPO = { width: 56, height: 22, pad: 2 }

test('sparklineValues keeps the original few-point fallback', () => {
  assert.deepEqual(sparklineValues([]), [0, 0])
  assert.deepEqual(sparklineValues([0]), [0, 0])
  assert.deepEqual(sparklineValues([5]), [5, 5])
  assert.deepEqual(sparklineValues([1, 5]), [1, 5])
  assert.deepEqual(sparklineValues([1, 5, 12]), [1, 5, 12])
})

test('sparklineGeometry matches original straight paths for each chart size', () => {
  const cases: Array<{ points: number[]; size: typeof MINI; linePath: string; areaPath: string }> = [
    { points: sparklineValues([]), size: MINI, linePath: 'M1.5,10.0 L46.5,10.0', areaPath: 'M1.5,10.0 L46.5,10.0 L46.5,20 L1.5,20 Z' },
    { points: sparklineValues([5]), size: MINI, linePath: 'M1.5,10.0 L46.5,10.0', areaPath: 'M1.5,10.0 L46.5,10.0 L46.5,20 L1.5,20 Z' },
    { points: [0, 0, 0], size: MINI, linePath: 'M1.5,10.0 L24.0,10.0 L46.5,10.0', areaPath: 'M1.5,10.0 L24.0,10.0 L46.5,10.0 L46.5,20 L1.5,20 Z' },
    { points: [1, 5], size: MINI, linePath: 'M1.5,18.5 L46.5,1.5', areaPath: 'M1.5,18.5 L46.5,1.5 L46.5,20 L1.5,20 Z' },
    { points: [1, 5, 12], size: MINI, linePath: 'M1.5,18.5 L24.0,12.3 L46.5,1.5', areaPath: 'M1.5,18.5 L24.0,12.3 L46.5,1.5 L46.5,20 L1.5,20 Z' },
    { points: [12, 5, 1], size: MINI, linePath: 'M1.5,1.5 L24.0,12.3 L46.5,18.5', areaPath: 'M1.5,1.5 L24.0,12.3 L46.5,18.5 L46.5,20 L1.5,20 Z' },
    { points: sparklineValues([]), size: PANEL, linePath: 'M2.0,14.0 L94.0,14.0', areaPath: 'M2.0,14.0 L94.0,14.0 L94.0,28 L2.0,28 Z' },
    { points: [0], size: PANEL, linePath: 'M2.0,14.0 L94.0,14.0', areaPath: 'M2.0,14.0 L94.0,14.0 L94.0,28 L2.0,28 Z' },
    { points: [1, 5, 12], size: PANEL, linePath: 'M2.0,26.0 L48.0,17.3 L94.0,2.0', areaPath: 'M2.0,26.0 L48.0,17.3 L94.0,2.0 L94.0,28 L2.0,28 Z' },
    { points: [80, 80, 80], size: PANEL, linePath: 'M2.0,14.0 L48.0,14.0 L94.0,14.0', areaPath: 'M2.0,14.0 L48.0,14.0 L94.0,14.0 L94.0,28 L2.0,28 Z' },
    { points: [1, 2, 3], size: PANEL, linePath: 'M2.0,26.0 L48.0,14.0 L94.0,2.0', areaPath: 'M2.0,26.0 L48.0,14.0 L94.0,2.0 L94.0,28 L2.0,28 Z' },
    { points: [0, 0], size: PANEL, linePath: 'M2.0,14.0 L94.0,14.0', areaPath: 'M2.0,14.0 L94.0,14.0 L94.0,28 L2.0,28 Z' },
    { points: sparklineValues([]), size: REPO, linePath: 'M2.0,11.0 L54.0,11.0', areaPath: 'M2.0,11.0 L54.0,11.0 L54.0,22 L2.0,22 Z' },
    { points: [1, 5, 12], size: REPO, linePath: 'M2.0,20.0 L28.0,13.5 L54.0,2.0', areaPath: 'M2.0,20.0 L28.0,13.5 L54.0,2.0 L54.0,22 L2.0,22 Z' },
    { points: [12, 5, 1], size: REPO, linePath: 'M2.0,2.0 L28.0,13.5 L54.0,20.0', areaPath: 'M2.0,2.0 L28.0,13.5 L54.0,20.0 L54.0,22 L2.0,22 Z' },
  ]
  for (const current of cases) {
    const geometry = sparklineGeometry(current.points.length > 1 ? current.points : sparklineValues(current.points), current.size)
    assert.equal(geometry.linePath, current.linePath)
    assert.equal(geometry.areaPath, current.areaPath)
    assert.equal(geometry.coords[geometry.coords.length - 1][0].toFixed(1) + ',' + geometry.coords[geometry.coords.length - 1][1].toFixed(1), current.linePath.slice(current.linePath.lastIndexOf(' ') + 2))
  }
})

test('identical values stay on the vertical midpoint', () => {
  for (const size of [MINI, PANEL, REPO]) {
    const { coords } = sparklineGeometry([4, 4], size)
    assert.equal(coords[0][1], size.height / 2)
    assert.equal(coords[1][1], size.height / 2)
  }
})

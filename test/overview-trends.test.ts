import assert from 'node:assert/strict'
import test from 'node:test'
import { cumulativeTrend, lastDayKeys, localDayKey, runningAverageValues, trendDirectionOf } from '../lib/overview-trends'
import { dateWeeksFromNow } from '../modules/projects/milestone-presets'

const now = new Date(2026, 7, 26, 15, 0, 0)

test('lastDayKeys 返回含今天在内的连续本地日期', () => {
  assert.deepEqual(lastDayKeys(3, now), ['2026-08-24', '2026-08-25', '2026-08-26'])
})

test('cumulativeTrend 把窗口前的数据计入基线并按日累加', () => {
  const before = new Date(Date.UTC(2026, 7, 20, 2, 0, 0))
  const points = cumulativeTrend([
    { at: before.toISOString(), value: 2 },
    { at: new Date(2026, 7, 24, 9).toISOString(), value: 1 },
    { at: new Date(2026, 7, 26, 10).toISOString(), value: 3 },
  ], 3, now)
  assert.equal(localDayKey(before) < '2026-08-24', true)
  assert.deepEqual(points, [3, 3, 6])
})

test('没有事件时趋势为全 0', () => {
  assert.deepEqual(cumulativeTrend([], 3, now), [0, 0, 0])
  assert.deepEqual(runningAverageValues([], 3, now), [0, 0, 0])
})

test('runningAverageValues 保留未四舍五入均值，调用端自行取整', () => {
  const values = runningAverageValues([
    { at: new Date(2026, 7, 24, 9).toISOString(), value: 80 },
    { at: new Date(2026, 7, 24, 10).toISOString(), value: 91 },
    { at: new Date(2026, 7, 26, 8).toISOString(), value: 70 },
  ], 3, now)
  assert.deepEqual(values.map((value) => Math.round(value)), [86, 86, 80])
  assert.deepEqual(values.map((value) => Math.round(value * 10) / 10), [85.5, 85.5, 80.3])
})

test('dateWeeksFromNow uses local calendar days and does not mutate the source date', () => {
  const from = new Date(2026, 0, 1, 0, 30, 0)
  const original = from.getTime()
  const nextWeek = dateWeeksFromNow(1, from)
  const sameDay = dateWeeksFromNow(0, from)
  assert.equal(from.getTime(), original)
  assert.equal(sameDay, localDayKey(from))
  assert.equal(nextWeek, localDayKey(new Date(2026, 0, 8, 0, 30, 0)))
  const utcKey = from.toISOString().slice(0, 10)
  if (utcKey !== localDayKey(from)) {
    assert.notEqual(sameDay, utcKey)
  }
})

test('trendDirectionOf 比较窗口首尾判断升、降、平', () => {
  assert.equal(trendDirectionOf([3, 3, 6]), 'up')
  assert.equal(trendDirectionOf([6, 4, 3]), 'down')
  assert.equal(trendDirectionOf([4, 4, 4]), 'flat')
  assert.equal(trendDirectionOf([4]), 'flat')
  assert.equal(trendDirectionOf([]), 'flat')
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { formatBeijingDateTime } from '../lib/format'

test('formats UTC login timestamps in Beijing time with minute precision', () => {
  assert.equal(formatBeijingDateTime('2026-09-10T08:25:59.123Z'), '2026-09-10 16:25')
})

test('handles midnight and year rollover in Beijing time', () => {
  assert.equal(formatBeijingDateTime('2026-12-31T16:00:00.000Z'), '2027-01-01 00:00')
})

test('respects explicit input offsets without adding eight hours twice', () => {
  assert.equal(formatBeijingDateTime('2026-09-10T16:25:00+08:00'), '2026-09-10 16:25')
  assert.equal(formatBeijingDateTime('2026-09-10T01:25:00-07:00'), '2026-09-10 16:25')
})

test('handles missing and invalid timestamps', () => {
  assert.equal(formatBeijingDateTime(undefined), '--')
  assert.equal(formatBeijingDateTime(''), '--')
  assert.equal(formatBeijingDateTime('invalid'), '--')
})

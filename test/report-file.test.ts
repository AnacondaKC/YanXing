import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveByteRange } from '../lib/documents/byte-range'
import { contentDispositionHeader } from '../lib/documents/content-disposition'

test('byte ranges resolve full, explicit, open, and suffix requests', () => {
  assert.deepEqual(resolveByteRange(null, 1_000), { start: 0, end: 999, partial: false })
  assert.deepEqual(resolveByteRange('bytes=100-199', 1_000), { start: 100, end: 199, partial: true })
  assert.deepEqual(resolveByteRange('bytes=900-', 1_000), { start: 900, end: 999, partial: true })
  assert.deepEqual(resolveByteRange('bytes=-100', 1_000), { start: 900, end: 999, partial: true })
  assert.deepEqual(resolveByteRange('bytes=950-1200', 1_000), { start: 950, end: 999, partial: true })
  assert.deepEqual(resolveByteRange('bytes=-1200', 1_000), { start: 0, end: 999, partial: true })
})

test('byte ranges reject malformed and unsatisfiable requests', () => {
  assert.equal(resolveByteRange(null, 0), undefined)
  assert.equal(resolveByteRange('items=0-10', 1_000), undefined)
  assert.equal(resolveByteRange('bytes=0-10,20-30', 1_000), undefined)
  assert.equal(resolveByteRange('bytes=-0', 1_000), undefined)
  assert.equal(resolveByteRange('bytes=1000-', 1_000), undefined)
  assert.equal(resolveByteRange('bytes=200-100', 1_000), undefined)
  assert.equal(resolveByteRange('bytes=-', 1_000), undefined)
})

test('report file disposition switches between inline preview and download', () => {
  assert.equal(contentDispositionHeader('阶段报告.docx'), "inline; filename*=UTF-8''%E9%98%B6%E6%AE%B5%E6%8A%A5%E5%91%8A.docx")
  assert.match(contentDispositionHeader('阶段报告.pdf', true), /^attachment; filename\*=UTF-8''/)
})

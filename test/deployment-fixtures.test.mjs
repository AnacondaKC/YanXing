import assert from 'node:assert/strict'
import test from 'node:test'
import { crc32 } from 'node:zlib'
import { createMinimalDocxBuffer, createPreviewableDocxBuffer } from '../scripts/deployment-fixtures.mjs'

const LOCAL_FILE_SIGNATURE = 0x04034b50
const LOCAL_FILE_HEADER_BYTES = 30
function readStoredEntries(buffer) {
  const entries = new Map()
  let offset = 0
  while (buffer.readUInt32LE(offset) === LOCAL_FILE_SIGNATURE) {
    const checksum = buffer.readUInt32LE(offset + 14)
    const size = buffer.readUInt32LE(offset + 18)
    const nameSize = buffer.readUInt16LE(offset + 26)
    const extraSize = buffer.readUInt16LE(offset + 28)
    const nameStart = offset + LOCAL_FILE_HEADER_BYTES
    const name = buffer.subarray(nameStart, nameStart + nameSize).toString('utf8')
    const bodyStart = nameStart + nameSize + extraSize
    const content = buffer.subarray(bodyStart, bodyStart + size)
    assert.equal(checksum, crc32(content), name + ' checksum must match its bytes')
    entries.set(name, content.toString('utf8'))
    offset = bodyStart + size
  }
  return entries
}

test('DOCX fixtures contain real ZIP checksums', () => {
  assert.equal(readStoredEntries(createMinimalDocxBuffer()).size, 2)
  assert.equal(readStoredEntries(createPreviewableDocxBuffer()).size, 4)
})

test('previewable DOCX supplies package relationships and XML-escaped text', () => {
  const entries = readStoredEntries(createPreviewableDocxBuffer('研究 & <证据>'))
  assert.ok(entries.get('_rels/.rels').includes('Target="word/document.xml"'))
  assert.ok(entries.get('word/_rels/document.xml.rels').includes('Relationships'))
  assert.ok(entries.get('[Content_Types].xml').includes('application/vnd.openxmlformats-package.relationships+xml'))
  assert.ok(entries.get('word/document.xml').includes('研究 &amp; &lt;证据&gt;'))
})

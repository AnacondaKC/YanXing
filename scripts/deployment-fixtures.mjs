import { deflateRawSync } from 'node:zlib'

export const PDF_MIME_TYPE = 'application/pdf'
export const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export function createMinimalPdfBuffer(text = 'Hello PDF world') {
  const stream = `BT /F1 12 Tf 50 700 Td (${escapePdfText(text)}) Tj ET`
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj',
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'))
    pdf += `${object}\n`
  }
  const xrefStart = Buffer.byteLength(pdf, 'latin1')
  let xref = 'xref\n0 6\n0000000000 65535 f \n'
  for (let index = 1; index <= 5; index += 1) xref += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  pdf += `${xref}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
  return Buffer.from(pdf, 'latin1')
}

export function createMinimalDocxBuffer(text = 'Hello DOCX world') {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p></w:body>
</w:document>`
  return createStoredZip([
    { name: '[Content_Types].xml', content: contentTypesXml() },
    { name: 'word/document.xml', content: documentXml },
  ])
}

function escapePdfText(text) {
  return text.replace(/[\\()]/g, (character) => `\\${character}`)
}

function escapeXml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function contentTypesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
}

function createStoredZip(entries) {
  const localEntries = []
  const centralEntries = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.from(entry.content, 'utf8')
    const content = entry.deflate ? deflateRawSync(raw) : raw
    const method = entry.deflate ? 8 : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(content.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localEntries.push(local, name, content)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(content.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt32LE(offset, 42)
    centralEntries.push(central, name)
    offset += local.length + name.length + content.length
  }

  const centralDirectory = Buffer.concat(centralEntries)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localEntries, centralDirectory, end])
}

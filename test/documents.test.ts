import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { DocumentParseError, fitTextToPrompt, isDocumentParseError, extractCachedDocumentText, extractDocumentText, extractDocxText, extractPdfText } from '../lib/documents/document-parser'
import { isRetryableDocumentParseFailure } from '../worker/job-processor'
import { maxUploadBytes, persistReportStream, ReportUploadError, writeBufferFully } from '../lib/documents/report-storage'

const directory = await mkdtemp(`${tmpdir()}/yanxing-documents-`)

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** 构造一个包含单行文本的最小合法 PDF。 */
function createMinimalPdfBuffer(text = 'Hello PDF world'): Buffer {
  const stream = `BT /F1 24 Tf 100 700 Td (${text}) Tj ET`
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj',
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'))
    pdf += `${obj}\n`
  }
  const xrefStart = Buffer.byteLength(pdf, 'latin1')
  let xref = 'xref\n0 6\n0000000000 65535 f \n'
  for (let index = 1; index <= 5; index += 1) xref += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  pdf += `${xref}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
  return Buffer.from(pdf, 'latin1')
}

function createStoredZip(entries: Array<{ name: string, content: string, declaredCompressedSize?: number, declaredUncompressedSize?: number, deflate?: boolean }>): Buffer {
  const localEntries: Buffer[] = []
  const centralEntries: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.from(entry.content, 'utf8')
    const content = entry.deflate ? deflateRawSync(raw) : raw
    const uncompressedSize = entry.declaredUncompressedSize ?? raw.length
    const method = entry.deflate ? 8 : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(content.length, 18)
    local.writeUInt32LE(uncompressedSize, 22)
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
    central.writeUInt32LE(entry.declaredCompressedSize ?? content.length, 20)
    central.writeUInt32LE(uncompressedSize, 24)
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

function createMinimalDocxBuffer(text = 'Hello DOCX world'): Buffer {
  return createStoredZip([
    { name: '[Content_Types].xml', content: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types" />' },
    { name: 'word/document.xml', content: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>` },
  ])
}

function bodyStream(buffer: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer))
      controller.close()
    },
  })
}

test('PDF upload passes storage validation and is persisted with the pdf extension', async () => {
  const reportId = 'report-pdf-valid'
  const pdfPath = path.join(directory, 'report.pdf')
  await rm(pdfPath, { force: true }).catch(() => undefined)
  const source = await persistReportStream({
    reportId,
    fileName: '研究报告.pdf',
    body: bodyStream(createMinimalPdfBuffer()),
    contentLength: createMinimalPdfBuffer().length,
  })
  assert.equal(source.mimeType, 'application/pdf')
  assert.match(source.path, /\.pdf$/)
  assert.equal(path.dirname(path.dirname(source.path)), path.join(process.cwd(), 'storage', 'reports'))
  assert.equal(source.fileName, '研究报告.pdf')
  assert.equal(source.size, createMinimalPdfBuffer().length)
  const stored = await readFile(source.path)
  assert.equal(stored.subarray(0, 5).toString('latin1'), '%PDF-')
  await rm(path.dirname(source.path), { recursive: true, force: true })
})

test('non-document uploads are rejected before any file is persisted', async () => {
  await assert.rejects(
    () => persistReportStream({ reportId: 'report-pdf-txt', fileName: 'note.txt', body: bodyStream(Buffer.from('hello')), contentLength: 5 }),
    (error: unknown) => error instanceof ReportUploadError && error.status === 415,
  )
  await assert.rejects(
    () => persistReportStream({ reportId: 'report-pdf-garbage', fileName: 'report.pdf', body: bodyStream(Buffer.from([0, 1, 2, 3])), contentLength: 4 }),
    (error: unknown) => error instanceof ReportUploadError && error.status === 422,
  )
  const disguisedPdf = createMinimalPdfBuffer()
  await assert.rejects(
    () => persistReportStream({ reportId: 'report-pdf-disguised', fileName: 'report.docx', body: bodyStream(disguisedPdf), contentLength: disguisedPdf.length }),
    (error: unknown) => error instanceof ReportUploadError && error.status === 422 && /扩展名/.test(error.message),
  )
  // PDF 缺少 EOF 标记视为结构不完整。
  const missingEof = createMinimalPdfBuffer().toString('latin1').replace('%%EOF', '')
  await assert.rejects(
    () => persistReportStream({ reportId: 'report-pdf-noeof', fileName: 'report.pdf', body: bodyStream(Buffer.from(missingEof, 'latin1')), contentLength: missingEof.length }),
    (error: unknown) => error instanceof ReportUploadError && error.status === 422 && /EOF/.test(error.message),
  )
})

test('report identifiers cannot escape managed storage roots', async () => {
  const escapedDirectory = path.join(process.cwd(), 'storage', 'escape')
  await rm(escapedDirectory, { recursive: true, force: true })
  await assert.rejects(
    () => persistReportStream({ reportId: '../escape', fileName: 'report.pdf', body: bodyStream(Buffer.from('%PDF-1.4\n%%EOF', 'latin1')) }),
    (error: unknown) => error instanceof ReportUploadError && error.status === 400,
  )
  await assert.rejects(() => readdir(escapedDirectory))
})

test('failed stream uploads remove temporary files and directories', async () => {
  const reportId = `report-stream-failure-${Date.now()}`
  const reportDirectory = path.join(process.cwd(), 'storage', 'reports', reportId)
  const temporaryDirectory = path.join(process.cwd(), 'storage', 'tmp')
  await rm(reportDirectory, { recursive: true, force: true })
  const failure = new Error('simulated upload stream failure')
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(failure)
    },
  })

  await assert.rejects(
    () => persistReportStream({ reportId, fileName: 'failed.pdf', body }),
    (error: unknown) => error === failure,
  )
  const temporaryEntries = await readdir(temporaryDirectory).catch(() => [])
  assert.equal(temporaryEntries.some((entry) => entry.startsWith(`${reportId}-`) && entry.endsWith('.upload')), false)
  await assert.rejects(() => readdir(reportDirectory))
})

test('concurrent uploads cannot remove the successful reused report upload', async () => {
  const reportId = `report-reused-${Date.now()}`
  const reportDirectory = path.join(process.cwd(), 'storage', 'reports', reportId)
  const pdf = createMinimalPdfBuffer('Reusable report')
  await rm(reportDirectory, { recursive: true, force: true })
  const attempts = await Promise.allSettled([
    persistReportStream({ reportId, fileName: 'reused.pdf', body: bodyStream(pdf), contentLength: pdf.length }),
    persistReportStream({ reportId, fileName: 'reused.pdf', body: bodyStream(pdf), contentLength: pdf.length }),
  ])
  const successfulAttempts = attempts.filter((result) => result.status === 'fulfilled')
  assert.equal(successfulAttempts.length, 1)
  assert.equal(attempts.filter((result) => result.status === 'rejected').length, 1)
  const winner = successfulAttempts[0]
  if (winner.status !== 'fulfilled') throw new Error('expected one successful upload')
  assert.deepEqual(await readFile(winner.value.path), pdf)
  await rm(path.dirname(winner.value.path), { recursive: true, force: true })
})

test('extractPdfText extracts plain text from a minimal PDF', async () => {
  const pdfPath = path.join(directory, 'extract.pdf')
  await rm(pdfPath, { force: true }).catch(() => undefined)
  const pdfBuffer = createMinimalPdfBuffer('Chapter One Research Background')
  await writeFile(pdfPath, pdfBuffer)

  const extracted = await extractPdfText(pdfPath)
  assert.ok(extracted.text.includes('Chapter One Research Background'))
  assert.ok(extracted.paragraphCount > 0)
  assert.ok(extracted.characterCount > 0)
})

test('extracted report text is reused from its private source cache', async () => {
  const pdfPath = path.join(directory, 'cached.pdf')
  await writeFile(pdfPath, createMinimalPdfBuffer('Cached report content'))

  const first = await extractCachedDocumentText(pdfPath)
  await rm(pdfPath)
  const cached = await extractCachedDocumentText(pdfPath)

  assert.deepEqual(cached, first)
  assert.ok(cached.text.includes('Cached report content'))
})

test('DOCX parser accepts a minimal valid document after archive preflight', async () => {
  const docxPath = path.join(directory, 'valid.docx')
  await writeFile(docxPath, createMinimalDocxBuffer('DOCX resource limits remain compatible'))

  const extracted = await extractDocxText(docxPath)
  assert.ok(extracted.text.includes('DOCX resource limits remain compatible'))
  assert.equal(extracted.characterCount, extracted.text.length)
})

test('DOCX central directory cannot declare compressed data beyond the source file', async () => {
  const forgedArchive = createStoredZip([
    { name: '[Content_Types].xml', content: '<Types />' },
    { name: 'word/document.xml', content: '<w:document />', declaredCompressedSize: 0x7fff_ffff },
  ])

  await assert.rejects(
    () => persistReportStream({ reportId: 'report-docx-forged-size', fileName: 'forged.docx', body: bodyStream(forgedArchive), contentLength: forgedArchive.length }),
    (error: unknown) => error instanceof ReportUploadError && error.status === 422 && /压缩大小|边界/.test(error.message),
  )
})

test('DOCX compression expansion is rejected before the parser opens the archive', async () => {
  const compressedBomb = createStoredZip([
    { name: '[Content_Types].xml', content: 'x', declaredUncompressedSize: 10_000 },
    { name: 'word/document.xml', content: 'x', declaredUncompressedSize: 10_000 },
  ])

  await assert.rejects(
    () => persistReportStream({ reportId: 'report-docx-ratio-limit', fileName: 'bomb.docx', body: bodyStream(compressedBomb), contentLength: compressedBomb.length }),
    (error: unknown) => error instanceof ReportUploadError && error.status === 422 && /压缩比/.test(error.message),
  )

  const docxPath = path.join(directory, 'bomb.docx')
  await writeFile(docxPath, compressedBomb)
  await assert.rejects(
    () => extractDocxText(docxPath),
    (error: unknown) => isDocumentParseError(error) && /压缩比/.test(error.message),
  )
})

test('DOCX with DTD entities inside deflated XML is rejected before parsing', async () => {
  const withDtd = createStoredZip([
    { name: '[Content_Types].xml', content: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types" />', deflate: true },
    { name: 'word/document.xml', content: '<!DOCTYPE foo [<!ENTITY x "xxxxxxxx">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">&x;</w:document>', deflate: true },
  ])

  await assert.rejects(
    () => persistReportStream({ reportId: 'report-docx-dtd', fileName: 'dtd.docx', body: bodyStream(withDtd), contentLength: withDtd.length }),
    (error: unknown) => error instanceof ReportUploadError && error.status === 422 && /DTD/.test(error.message),
  )
})

test('PDF parser rejects an oversized source before reading it into memory', async () => {
  const pdfPath = path.join(directory, 'over-limit.pdf')
  const oversizedPdf = Buffer.alloc(maxUploadBytes + 1)
  oversizedPdf.write('%PDF-1.4', 'latin1')
  await writeFile(pdfPath, oversizedPdf)

  await assert.rejects(
    () => extractPdfText(pdfPath),
    (error: unknown) => isDocumentParseError(error) && /文件超过/.test(error.message),
  )
})

test('extractDocumentText dispatches by file extension and wraps failures', async () => {
  const pdfPath = path.join(directory, 'dispatch.pdf')
  await writeFile(pdfPath, createMinimalPdfBuffer('Hello PDF world'))
  const pdfExtracted = await extractDocumentText(pdfPath)
  assert.ok(pdfExtracted.text.includes('Hello PDF world'))

  const docxPath = path.join(directory, 'broken.docx')
  await writeFile(docxPath, Buffer.from([0, 1, 2, 3]))
  await assert.rejects(
    () => extractDocumentText(docxPath),
    (error: unknown) => isDocumentParseError(error),
  )
  await assert.rejects(
    () => extractDocxText(docxPath),
    (error: unknown) => isDocumentParseError(error),
  )
})

test('missing document sources are permanent parser failures, not retryable failures', async () => {
  const missingPath = path.join(directory, 'missing.docx')
  await assert.rejects(
    () => extractDocxText(missingPath),
    (error: unknown) => isDocumentParseError(error)
      && error.retryable === false
      && isRetryableDocumentParseFailure(error) === false,
  )
  assert.equal(isRetryableDocumentParseFailure(new DocumentParseError('temporary parser capacity', true)), true)
})

test('writeBufferFully retries short writes and rejects zero progress', async () => {
  const written: Buffer[] = []
  await writeBufferFully({
    write: async (buffer) => {
      const take = Math.min(2, buffer.length)
      written.push(Buffer.from(buffer.subarray(0, take)))
      return { bytesWritten: take }
    },
  }, Buffer.from('abcdef'))
  assert.equal(Buffer.concat(written).toString(), 'abcdef')

  await assert.rejects(
    () => writeBufferFully({ write: async () => ({ bytesWritten: 0 }) }, Buffer.from('x')),
    (error: unknown) => error instanceof ReportUploadError && error.status === 507 && /写入中断/.test(error.message),
  )
  await assert.rejects(
    () => writeBufferFully({ write: async () => { throw new Error('disk full') } }, Buffer.from('x')),
    /disk full/,
  )
})

test('fitTextToPrompt treats the remaining budget as a hard cap', () => {
  const body = '正文内容'.repeat(8_000)
  const budget = 800
  const fitted = fitTextToPrompt(body, budget)
  assert.equal(fitted.text.length, budget)
  assert.equal(fitted.truncated, true)
  assert.ok(fitted.text.includes('[正文中间部分因模型提示词限制被省略]'))

  assert.equal(fitTextToPrompt('abc', 0).text, '')
  assert.equal(fitTextToPrompt('abc', 0).truncated, true)
  assert.equal(fitTextToPrompt('', 0).truncated, false)
  assert.equal(fitTextToPrompt('short', 100).text, 'short')
  assert.equal(fitTextToPrompt('short', 100).truncated, false)
  assert.throws(() => fitTextToPrompt('abc', -1), /预算无效/)
  assert.throws(() => fitTextToPrompt('abc', Number.NaN), /预算无效/)

  const tiny = fitTextToPrompt('abcdefghij', 5)
  assert.equal(tiny.text, 'abcde')
  assert.equal(tiny.truncated, true)
})

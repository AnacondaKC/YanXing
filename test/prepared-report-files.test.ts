import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DocumentParseError } from '../lib/documents/document-parser'
import { createPreparedReportFiles } from '../lib/documents/prepared-report-files'
import { maxUploadBytes } from '../lib/documents/report-storage'
import { ReportSubmissionError, type PreparedReportFile } from '../modules/reports/upload-domain'
import { createMinimalDocxBuffer, createMinimalPdfBuffer, DOCX_MIME_TYPE } from '../scripts/deployment-fixtures.mjs'

type ExtractText = NonNullable<Parameters<typeof createPreparedReportFiles>[0]['extractText']>

function bodyStream(buffer: Buffer) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer))
      controller.close()
    },
  })
}

function newUploadId() {
  return `upload-${randomUUID()}`
}

function isCode(error: unknown, code: ReportSubmissionError['code'], status?: number) {
  return error instanceof ReportSubmissionError
    && error.code === code
    && (status === undefined || error.status === status)
    && !error.message.includes(path.sep + 'yanxing-prepared-')
}

async function withRoot(run: (input: {
  storageRoot: string
  sentinelPath: string
  files: ReturnType<typeof createPreparedReportFiles>
  ownedNames: () => Promise<string[]>
}) => Promise<void>, extractText?: ExtractText) {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'yanxing-prepared-'))
  const sentinelPath = path.join(storageRoot, 'caller-sentinel')
  await writeFile(sentinelPath, 'keep')
  try {
    await run({
      storageRoot,
      sentinelPath,
      files: createPreparedReportFiles({ storageRoot, extractText }),
      ownedNames: async () => {
        const entries = await readdir(storageRoot)
        return entries.filter((name) => name !== '.tmp' && name !== 'caller-sentinel').sort()
      },
    })
  } finally {
    await rm(storageRoot, { recursive: true, force: true })
  }
}

async function prepareDocx(
  files: ReturnType<typeof createPreparedReportFiles>,
  text = 'Prepared report body',
  fileName = '阶段报告.docx',
) {
  const buffer = createMinimalDocxBuffer(text)
  const prepared = await files.prepare({
    uploadId: newUploadId(),
    fileName,
    body: bodyStream(buffer),
    contentLength: buffer.length,
  })
  return { prepared, buffer }
}

test('prepare stores a real DOCX under the private root, parses text, and skips the parser cache', async () => {
  await withRoot(async ({ storageRoot, sentinelPath, files }) => {
    const { prepared, buffer } = await prepareDocx(files, 'Prepared report body')
    assert.match(prepared.text, /Prepared report body/)
    assert.equal(prepared.characterCount, prepared.text.length)
    assert.ok(prepared.paragraphCount >= 1)
    assert.equal(prepared.title, '阶段报告')
    assert.equal(prepared.fileName, '阶段报告.docx')
    assert.equal(prepared.mimeType, DOCX_MIME_TYPE)
    assert.equal(prepared.sourceSize, buffer.length)
    assert.match(prepared.sourceKey, /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.docx$/)
    assert.equal(prepared.sourceKey.includes('..'), false)
    const absolute = path.join(storageRoot, prepared.sourceKey)
    assert.equal(path.resolve(storageRoot, prepared.sourceKey), absolute)
    assert.deepEqual(await readFile(absolute), buffer)
    const siblings = await readdir(path.dirname(absolute))
    assert.equal(siblings.some((name) => name.endsWith('.content.json')), false)
    await files.verify(prepared)
    const defaultDirectory = path.join(process.cwd(), 'storage', 'reports', path.dirname(prepared.sourceKey))
    await assert.rejects(() => readdir(defaultDirectory))
    assert.equal(await readFile(sentinelPath, 'utf8'), 'keep')
  })
})

test('identical-byte uploads keep separate owned directories', async () => {
  await withRoot(async ({ files }) => {
    const buffer = createMinimalDocxBuffer('Same bytes twice')
    const first = await files.prepare({
      uploadId: newUploadId(),
      fileName: 'first.docx',
      body: bodyStream(buffer),
      contentLength: buffer.length,
    })
    const second = await files.prepare({
      uploadId: newUploadId(),
      fileName: 'second.docx',
      body: bodyStream(buffer),
      contentLength: buffer.length,
    })
    assert.notEqual(first.sourceKey, second.sourceKey)
    assert.equal(first.fileHash, second.fileHash)
    assert.equal(first.text, second.text)
    await files.verify(first)
    await files.verify(second)
  })
})

test('abort, oversize, invalid extension, and invalid content fail without leftover files', async () => {
  await withRoot(async ({ files, ownedNames }) => {
    const docx = createMinimalDocxBuffer('Rejected uploads')
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () => files.prepare({ uploadId: newUploadId(), fileName: 'a.docx', body: bodyStream(docx), signal: controller.signal }),
      (error: unknown) => isCode(error, 'UPLOAD_ABORTED', 408),
    )
    await assert.rejects(
      () => files.prepare({ uploadId: newUploadId(), fileName: 'a.docx', body: bodyStream(docx), contentLength: maxUploadBytes + 1 }),
      (error: unknown) => isCode(error, 'UPLOAD_FILE_INVALID', 413),
    )
    await assert.rejects(
      () => files.prepare({ uploadId: newUploadId(), fileName: 'note.txt', body: bodyStream(Buffer.from('hello')), contentLength: 5 }),
      (error: unknown) => isCode(error, 'UPLOAD_FILE_INVALID', 415),
    )
    await assert.rejects(
      () => files.prepare({ uploadId: newUploadId(), fileName: 'a.docx', body: bodyStream(Buffer.from([0, 1, 2, 3])), contentLength: 4 }),
      (error: unknown) => isCode(error, 'UPLOAD_FILE_INVALID', 422),
    )
    const pdf = createMinimalPdfBuffer()
    await assert.rejects(
      () => files.prepare({ uploadId: newUploadId(), fileName: 'a.docx', body: bodyStream(pdf), contentLength: pdf.length }),
      (error: unknown) => isCode(error, 'UPLOAD_FILE_INVALID', 422),
    )
    assert.deepEqual(await ownedNames(), [])
  })
})

test('failed parse and abort during parse remove the owned file and empty directory', async () => {
  const buffer = createMinimalDocxBuffer('Parse then cleanup')
  await withRoot(async ({ files, ownedNames, sentinelPath }) => {
    await assert.rejects(
      () => files.prepare({
        uploadId: newUploadId(),
        fileName: 'a.docx',
        body: bodyStream(buffer),
        contentLength: buffer.length,
      }),
      (error: unknown) => isCode(error, 'REPORT_PARSE_FAILED', 422) && error instanceof ReportSubmissionError && !error.message.includes('injected'),
    )
    assert.deepEqual(await ownedNames(), [])
    assert.equal(await readFile(sentinelPath, 'utf8'), 'keep')
  }, async () => { throw new DocumentParseError('injected parse failure') })

  await withRoot(async ({ files, ownedNames }) => {
    await assert.rejects(
      () => files.prepare({
        uploadId: newUploadId(),
        fileName: 'a.docx',
        body: bodyStream(buffer),
        contentLength: buffer.length,
      }),
      (error: unknown) => isCode(error, 'REPORT_PARSE_FAILED', 422),
    )
    assert.deepEqual(await ownedNames(), [])
  }, async () => ({ text: 'hello', paragraphCount: 1, characterCount: 4 }))

  await withRoot(async ({ files, ownedNames }) => {
    await assert.rejects(
      () => files.prepare({
        uploadId: newUploadId(),
        fileName: 'a.docx',
        body: bodyStream(buffer),
        contentLength: buffer.length,
      }),
      (error: unknown) => isCode(error, 'REPORT_PARSE_FAILED', 422),
    )
    assert.deepEqual(await ownedNames(), [])
  }, async () => ({ text: '   ', paragraphCount: 1, characterCount: 3 }))

  const controller = new AbortController()
  await withRoot(async ({ files, ownedNames }) => {
    await assert.rejects(
      () => files.prepare({
        uploadId: newUploadId(),
        fileName: 'a.docx',
        body: bodyStream(buffer),
        contentLength: buffer.length,
        signal: controller.signal,
      }),
      (error: unknown) => isCode(error, 'UPLOAD_ABORTED', 408),
    )
    assert.deepEqual(await ownedNames(), [])
  }, async () => {
    controller.abort()
    throw new DocumentParseError('文档解析已取消。')
  })
})

test('failed prepare cleanup that cannot remove the leftover raises UPLOAD_CLEANUP_FAILED', async () => {
  const buffer = createMinimalDocxBuffer('Stuck leftover')
  const uploadId = newUploadId()
  await withRoot(async ({ storageRoot, files }) => {
    await assert.rejects(
      () => files.prepare({
        uploadId,
        fileName: 'a.docx',
        body: bodyStream(buffer),
        contentLength: buffer.length,
      }),
      (error: unknown) => isCode(error, 'UPLOAD_CLEANUP_FAILED', 500),
    )
    assert.equal(await readFile(path.join(storageRoot, uploadId, `${uploadId}.docx`, 'stuck.txt'), 'utf8'), 'x')
  }, async (filePath) => {
    await rm(filePath)
    await mkdir(filePath)
    await writeFile(path.join(filePath, 'stuck.txt'), 'x')
    throw new DocumentParseError('injected parse failure')
  })
})

test('verify rejects a changed file without deleting it', async () => {
  await withRoot(async ({ storageRoot, files }) => {
    const { prepared } = await prepareDocx(files, 'Unchanged until tampered')
    const absolute = path.join(storageRoot, prepared.sourceKey)
    const original = await readFile(absolute)
    await writeFile(absolute, Buffer.concat([original, Buffer.from('x')]))
    await assert.rejects(
      () => files.verify(prepared),
      (error: unknown) => isCode(error, 'REPORT_FILE_CHANGED', 409),
    )
    assert.equal((await readFile(absolute)).length, original.length + 1)
    await assert.rejects(
      () => files.verify({ ...prepared, fileHash: '0'.repeat(64) } as PreparedReportFile),
      (error: unknown) => isCode(error, 'REPORT_FILE_CHANGED', 409),
    )
    assert.equal((await readFile(absolute)).length, original.length + 1)
    await assert.rejects(
      () => files.verify({ ...prepared, sourceSize: maxUploadBytes + 1 }),
      (error: unknown) => isCode(error, 'REPORT_FILE_CHANGED', 409),
    )
    await assert.rejects(
      () => files.verify({ ...prepared, sourceKey: undefined as never }),
      (error: unknown) => isCode(error, 'UPLOAD_FILE_INVALID', 400),
    )
    await assert.rejects(
      () => files.discard({ ...prepared, sourceKey: 1 as never }),
      (error: unknown) => isCode(error, 'UPLOAD_FILE_INVALID', 400),
    )
    assert.equal((await readFile(absolute)).length, original.length + 1)
  })
})

test('verify and discard reject traversal and do not touch the caller root', async () => {
  await withRoot(async ({ storageRoot, sentinelPath, files }) => {
    const { prepared } = await prepareDocx(files, 'Traversal stays put')
    const original = await readFile(path.join(storageRoot, prepared.sourceKey))
    await assert.rejects(
      () => files.verify({ ...prepared, sourceKey: '../secret.docx' }),
      (error: unknown) => isCode(error, 'UPLOAD_FILE_INVALID', 400),
    )
    await assert.rejects(
      () => files.discard({ ...prepared, sourceKey: `${prepared.sourceKey}/../../passwd` }),
      (error: unknown) => isCode(error, 'UPLOAD_FILE_INVALID', 400),
    )
    await assert.rejects(
      () => files.discard({ ...prepared, sourceKey: '/etc/passwd' }),
      (error: unknown) => isCode(error, 'UPLOAD_FILE_INVALID', 400),
    )
    assert.deepEqual(await readFile(path.join(storageRoot, prepared.sourceKey)), original)
    assert.equal(await readFile(sentinelPath, 'utf8'), 'keep')
  })
})

test('verify and discard refuse symlinks and never delete the symlink target', async () => {
  await withRoot(async ({ storageRoot, files }) => {
    const { prepared } = await prepareDocx(files, 'Symlink original')
    const absolute = path.join(storageRoot, prepared.sourceKey)
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'yanxing-prepared-outside-'))
    const secret = path.join(outsideDir, 'secret.bin')
    await writeFile(secret, 'secret')
    try {
      await rm(absolute)
      await symlink(secret, absolute)
      await assert.rejects(
        () => files.verify(prepared),
        (error: unknown) => isCode(error, 'UPLOAD_FILE_INVALID', 400) || isCode(error, 'REPORT_FILE_CHANGED', 409),
      )
      await assert.rejects(
        () => files.discard(prepared),
        (error: unknown) => isCode(error, 'UPLOAD_FILE_INVALID', 400),
      )
      assert.equal(await readFile(secret, 'utf8'), 'secret')

      const ancestorPrepared = (await prepareDocx(files, 'Ancestor symlink')).prepared
      const ownedFile = path.join(storageRoot, ancestorPrepared.sourceKey)
      const ownedDir = path.dirname(ownedFile)
      const moved = path.join(outsideDir, 'moved')
      await rename(ownedDir, moved)
      await symlink(moved, ownedDir)
      await assert.rejects(
        () => files.verify(ancestorPrepared),
        (error: unknown) => isCode(error, 'UPLOAD_FILE_INVALID', 400) || isCode(error, 'REPORT_FILE_CHANGED', 409),
      )
      await assert.rejects(
        () => files.discard(ancestorPrepared),
        (error: unknown) => isCode(error, 'UPLOAD_FILE_INVALID', 400),
      )
      assert.ok((await readFile(path.join(moved, path.basename(ownedFile)))).length > 0)
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })
})

test('discard removes only the owned prepared file and leaves unrelated files', async () => {
  await withRoot(async ({ storageRoot, sentinelPath, files, ownedNames }) => {
    const { prepared } = await prepareDocx(files, 'Discard target')
    const ownedDir = path.join(storageRoot, path.dirname(prepared.sourceKey))
    const extra = path.join(ownedDir, 'extra.txt')
    await writeFile(extra, 'stay')
    await files.discard(prepared)
    assert.equal(await readFile(extra, 'utf8'), 'stay')
    assert.equal(await readFile(sentinelPath, 'utf8'), 'keep')
    await assert.rejects(() => readFile(path.join(storageRoot, prepared.sourceKey)))
    await files.discard(prepared)
    const { prepared: clean } = await prepareDocx(files, 'Clean discard')
    await files.discard(clean)
    assert.equal((await ownedNames()).includes(path.dirname(clean.sourceKey)), false)
    assert.equal(await readFile(sentinelPath, 'utf8'), 'keep')
  })
})

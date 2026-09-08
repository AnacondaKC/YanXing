import { createHash, randomUUID } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { basename, extname, join } from 'node:path'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import type { ReportSource } from '@/modules/reports/domain'
import { runtimeConfig } from '@/lib/config/environment'
import {
  cancelReader,
  errorCode,
  releaseReaderLock,
  storageUnavailableErrnos,
  type UploadReader,
} from '@/lib/storage/stream-utils'

const storageRoot = join(process.cwd(), 'storage')
export const reportStorageRoot = join(storageRoot, 'reports')
const temporaryStorageRoot = join(storageRoot, 'tmp')
const docxMimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const pdfMimeType = 'application/pdf'

/** 上传时按文件头识别的文档类型。 */
type DetectedDocumentType = 'docx' | 'pdf'

function detectDocumentType(header: Buffer): DetectedDocumentType | undefined {
  if (header.length >= 4 && header.toString('binary').startsWith('PK\u0003\u0004')) return 'docx'
  if (header.length >= 4 && header.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf'
  return undefined
}

export const maxUploadBytes = runtimeConfig.report.maxUploadBytes
const maxArchiveEntries = runtimeConfig.report.maxArchiveEntries
const maxUncompressedBytes = runtimeConfig.report.maxUncompressedBytes
const maxArchiveEntryUncompressedBytes = runtimeConfig.report.maxArchiveEntryUncompressedBytes
const maxCompressionRatio = runtimeConfig.report.maxCompressionRatio
const maxCentralDirectoryBytes = 8 * 1024 * 1024
// PDF 声明流总量的默认上限：远大于正常研究报告（通常 < 50MB），
// 但能挡住解压后达 GB 量级的构造文件。
const maxPdfDeclaredStreamBytes = runtimeConfig.report.maxPdfStreamBytes
const uploadIdleTimeoutMs = runtimeConfig.report.uploadIdleTimeoutMs
const uploadTotalTimeoutMs = runtimeConfig.report.uploadTotalTimeoutMs
const maxConcurrentReportUploads = Math.min(8, runtimeConfig.report.uploadConcurrency)
const reportIdPattern = /^[A-Za-z0-9_-]{1,128}$/
type ReportUploadGlobal = typeof globalThis & { __yanxingReportUploads?: { active: number } }
const reportUploadGlobal = globalThis as ReportUploadGlobal
const reportUploadState = reportUploadGlobal.__yanxingReportUploads ?? { active: 0 }
reportUploadGlobal.__yanxingReportUploads = reportUploadState

export class ReportUploadError extends Error {
  constructor(message: string, readonly status: 400 | 408 | 413 | 415 | 422 | 503 | 507, options: { code?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ReportUploadError'
    if (options.code) this.code = options.code
  }

  readonly code?: string
}


function normalizeStorageError(error: unknown) {
  const code = errorCode(error)
  if (!code || !storageUnavailableErrnos.has(code)) return error
  return new ReportUploadError('报告存储空间不可用。', 507, { code, cause: error })
}

export function createReportId() {
  return `report-${randomUUID()}`
}

export function parseContentLengthHeader(value: string | null) {
  if (value === null) return undefined
  if (!/^\d+$/.test(value)) throw new ReportUploadError('Content-Length 无效。', 400)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new ReportUploadError('Content-Length 无效。', 400)
  return parsed
}

export async function persistReportStream(input: {
  reportId: string
  fileName: string
  body: ReadableStream<Uint8Array> | null
  contentLength?: number
  signal?: AbortSignal
}): Promise<ReportSource> {
  if (!reportIdPattern.test(input.reportId)) throw new ReportUploadError('报告标识无效。', 400)
  const originalName = basename(input.fileName || 'report.docx').slice(0, 240)
  const extension = extname(originalName).toLowerCase()
  if (extension !== '.docx' && extension !== '.pdf') {
    throw new ReportUploadError('仅支持 DOCX 或 PDF 文件。', 415)
  }
  if (!input.body) throw new ReportUploadError('未找到报告文件。', 400)
  if (input.contentLength !== undefined && input.contentLength > maxUploadBytes) {
    throw new ReportUploadError('报告文件超过大小限制。', 413)
  }
  throwIfUploadAborted(input.signal)

  if (reportUploadState.active >= maxConcurrentReportUploads) {
    throw new ReportUploadError('当前报告上传任务较多，请稍后再试。', 503)
  }
  reportUploadState.active += 1
  try {
    await mkdir(reportStorageRoot, { recursive: true })
    await mkdir(temporaryStorageRoot, { recursive: true })
  } catch (error) {
    reportUploadState.active = Math.max(0, reportUploadState.active - 1)
    throw normalizeStorageError(error)
  }
  const temporaryPath = join(temporaryStorageRoot, `${input.reportId}-${randomUUID()}.upload`)
  const finalDirectory = join(reportStorageRoot, input.reportId)
  const digest = createHash('sha256')
  const firstBytes = Buffer.alloc(4)
  let firstByteCount = 0
  let size = 0
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined
  let reader: UploadReader | undefined
  let streamEnded = false
  let finalDirectoryCreated = false
  let renameSucceeded = false

  try {
    fileHandle = await open(temporaryPath, 'wx', 0o600)
    reader = input.body.getReader()
    const uploadDeadline = Date.now() + uploadTotalTimeoutMs
    try {
      while (true) {
        const result = await readUploadChunk(reader, input.signal, uploadDeadline)
        if (result.done) {
          streamEnded = true
          break
        }
        const value = result.value
        if (!value?.byteLength) continue
        size += value.byteLength
        if (size > maxUploadBytes) {
          cancelReader(reader, 'upload limit exceeded')
          throw new ReportUploadError('报告文件超过大小限制。', 413)
        }
        const bytes = Buffer.from(value)
        if (firstByteCount < firstBytes.length) {
          const copyLength = Math.min(firstBytes.length - firstByteCount, bytes.length)
          bytes.copy(firstBytes, firstByteCount, 0, copyLength)
          firstByteCount += copyLength
        }
        digest.update(bytes)
        await writeBufferFully(fileHandle, bytes)
      }
    } finally {
      releaseReaderLock(reader)
    }
    await fileHandle.close()
    fileHandle = undefined
    throwIfUploadAborted(input.signal)

    if (!size) throw new ReportUploadError('报告文件为空。', 422)
    const detectedType = detectDocumentType(firstBytes)
    if (!detectedType) {
      throw new ReportUploadError('上传文件不是有效的 DOCX 或 PDF 文档。', 422)
    }
    const expectedExtension = detectedType === 'pdf' ? '.pdf' : '.docx'
    if (extension !== expectedExtension) {
      throw new ReportUploadError('文件扩展名与实际文档类型不一致。', 422)
    }

    if (detectedType === 'docx') await validateDocxArchive(temporaryPath, size)
    else await validatePdfFile(temporaryPath)
    throwIfUploadAborted(input.signal)
    await mkdir(finalDirectory, { recursive: false })
    finalDirectoryCreated = true
    // 按文件头识别的实际类型存储，避免扩展名与内容不符时解析分派错误。
    const finalPath = join(finalDirectory, `${input.reportId}${detectedType === 'pdf' ? '.pdf' : '.docx'}`)
    throwIfUploadAborted(input.signal)
    await rename(temporaryPath, finalPath)
    renameSucceeded = true

    reportUploadState.active = Math.max(0, reportUploadState.active - 1)
    return {
      path: finalPath,
      fileName: originalName,
      mimeType: detectedType === 'pdf' ? pdfMimeType : docxMimeType,
      size,
      sha256: digest.digest('hex'),
    }
  } catch (error) {
    reportUploadState.active = Math.max(0, reportUploadState.active - 1)
    if (reader && !streamEnded) cancelReader(reader, 'upload failed')
    if (fileHandle) await fileHandle.close().catch(() => undefined)
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    // The directory may have been populated by a concurrent writer. A
    // non-recursive removal cleans up only our empty directory and never
    // deletes another upload's files.
    if (finalDirectoryCreated && !renameSucceeded) await rm(finalDirectory, { force: true }).catch(() => undefined)
    if (input.signal?.aborted && !renameSucceeded) {
      throw new ReportUploadError('报告上传已取消。', 408, { cause: error })
    }
    if (error instanceof ReportUploadError) throw error
    throw normalizeStorageError(error)
  }
}

export async function writeBufferFully(
  fileHandle: { write: (buffer: Buffer) => Promise<{ bytesWritten: number }> },
  bytes: Buffer,
) {
  let offset = 0
  while (offset < bytes.length) {
    const remaining = bytes.subarray(offset)
    const result = await fileHandle.write(remaining)
    if (!Number.isFinite(result.bytesWritten) || result.bytesWritten <= 0) {
      throw new ReportUploadError('报告文件写入中断。', 507)
    }
    offset += result.bytesWritten
    if (offset > bytes.length) throw new ReportUploadError('报告文件写入偏移异常。', 507)
  }
}

function throwIfUploadAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new ReportUploadError('报告上传已取消。', 408)
}

async function readUploadChunk(
  reader: UploadReader,
  signal?: AbortSignal,
  deadline = Number.POSITIVE_INFINITY,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal?.aborted) throw new ReportUploadError('报告上传已取消。', 408)
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new ReportUploadError('报告上传超过总时限。', 408)
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const rejectAndCancel = (message: string) => {
      cancelReader(reader, message)
      finish(() => reject(new ReportUploadError(message, 408)))
    }
    const onAbort = () => rejectAndCancel('报告上传已取消。')

    timer = setTimeout(
      () => rejectAndCancel(remaining <= uploadIdleTimeoutMs ? '报告上传超过总时限。' : '报告上传连接超时。'),
      Math.min(uploadIdleTimeoutMs, remaining),
    )
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    if (settled) return

    let readPromise: Promise<ReadableStreamReadResult<Uint8Array>>
    try {
      readPromise = reader.read()
    } catch (error) {
      finish(() => reject(error))
      return
    }
    readPromise.then(
      (result) => finish(() => resolve(result)),
      (error) => finish(() => reject(error)),
    )
  })
}

async function validatePdfFile(filePath: string) {
  const file = await open(filePath, 'r')
  let primaryError: unknown
  try {
    const header = Buffer.alloc(8)
    const headerRead = await file.read(header, 0, 8, 0)
    if (headerRead.bytesRead < 5 || header.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new ReportUploadError('上传文件不是有效的 PDF 文档。', 422)
    }

    const stat = await file.stat()
    if (stat.size < 16) throw new ReportUploadError('上传文件不是有效的 PDF 文档。', 422)
    const tailSize = Math.min(Number(stat.size), 1_024)
    const tail = Buffer.alloc(tailSize)
    await file.read(tail, 0, tailSize, Number(stat.size) - tailSize)
    if (tail.indexOf(Buffer.from('%%EOF', 'latin1')) < 0) {
      throw new ReportUploadError('PDF 文件结构不完整（缺少 EOF 标记）。', 422)
    }
    await rejectOversizedPdfStreams(filePath, Number(stat.size))
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try {
      await file.close()
    } catch (error) {
      if (primaryError === undefined) throw error
    }
  }
}

/**
 * 解压炸弹预扫：按对象声明的 /Length 估算解压后的流总量。
 * /Length 是大多数 PDF 写入器保证正确的必填字段；声明总量超限的文件
 * 在解析（pdf.js 解压）之前直接拒绝，避免解析期内存放大。
 */
async function rejectOversizedPdfStreams(filePath: string, fileSize: number) {
  const file = await open(filePath, 'r')
  let primaryError: unknown
  try {
    const chunkSize = 1024 * 1024
    const overlap = 32
    let declaredTotal = 0
    let carry = Buffer.alloc(0)
    let offset = 0
    while (offset < fileSize) {
      const length = Math.min(chunkSize, fileSize - offset)
      const chunk = Buffer.alloc(length)
      await file.read(chunk, 0, length, offset)
      const haystack = Buffer.concat([carry, chunk]).toString('latin1')
      for (const match of haystack.matchAll(/\/Length(?:1|2|3)?\s+(\d{1,12})(?![\d.])/g)) {
        declaredTotal += Number(match[1])
        if (declaredTotal > maxPdfDeclaredStreamBytes) {
          throw new ReportUploadError('PDF 内容流声明大小超过限制。', 422)
        }
      }
      carry = chunk.subarray(Math.max(0, chunk.length - overlap))
      offset += length
    }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try {
      await file.close()
    } catch (error) {
      if (primaryError === undefined) throw error
    }
  }
}

export async function validateDocxArchive(filePath: string, fileSize: number) {
  const tailSize = Math.min(fileSize, 65_557)
  const file = await open(filePath, 'r')
  let primaryError: unknown
  try {
    const tail = Buffer.alloc(tailSize)
    await file.read(tail, 0, tailSize, fileSize - tailSize)
    const eocdOffset = findSignatureBackwards(tail, 0x06054b50)
    if (eocdOffset < 0 || eocdOffset + 22 > tail.length) {
      throw new ReportUploadError('DOCX ZIP 目录不完整。', 422)
    }

    const diskNumber = tail.readUInt16LE(eocdOffset + 4)
    const centralDisk = tail.readUInt16LE(eocdOffset + 6)
    const entries = tail.readUInt16LE(eocdOffset + 10)
    const centralSize = tail.readUInt32LE(eocdOffset + 12)
    const centralOffset = tail.readUInt32LE(eocdOffset + 16)
    if (diskNumber !== 0 || centralDisk !== 0 || entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new ReportUploadError('不支持多卷或 ZIP64 DOCX 文件。', 422)
    }
    if (!entries || entries > maxArchiveEntries) throw new ReportUploadError('DOCX 内部条目数量超出限制。', 422)
    if (centralSize > maxCentralDirectoryBytes || centralOffset + centralSize > fileSize) {
      throw new ReportUploadError('DOCX ZIP 目录大小异常。', 422)
    }

    const central = Buffer.alloc(centralSize)
    await file.read(central, 0, centralSize, centralOffset)
    let cursor = 0
    let totalCompressed = 0
    let totalUncompressed = 0
    const names = new Set<string>()
    const archiveEntries: Array<{ compressionMethod: number; compressedSize: number; uncompressedSize: number; localOffset: number; inspectXml: boolean }> = []

    for (let index = 0; index < entries; index += 1) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) {
        throw new ReportUploadError('DOCX ZIP 中央目录损坏。', 422)
      }
      const flags = central.readUInt16LE(cursor + 8)
      const compressionMethod = central.readUInt16LE(cursor + 10)
      const compressedSize = central.readUInt32LE(cursor + 20)
      const uncompressedSize = central.readUInt32LE(cursor + 24)
      const fileNameLength = central.readUInt16LE(cursor + 28)
      const extraLength = central.readUInt16LE(cursor + 30)
      const commentLength = central.readUInt16LE(cursor + 32)
      const localOffset = central.readUInt32LE(cursor + 42)
      if (flags & 0x1) throw new ReportUploadError('不支持加密 DOCX 文件。', 422)
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
        throw new ReportUploadError('不支持 ZIP64 DOCX 文件。', 422)
      }
      if (compressedSize > fileSize || localOffset > fileSize - 30) {
        throw new ReportUploadError('DOCX 内部条目压缩大小或偏移异常。', 422)
      }
      if (uncompressedSize > maxArchiveEntryUncompressedBytes) {
        throw new ReportUploadError('DOCX 内部条目解压后超过限制。', 413)
      }
      const entryEnd = cursor + 46 + fileNameLength + extraLength + commentLength
      if (entryEnd > central.length) throw new ReportUploadError('DOCX ZIP 条目边界无效。', 422)
      const entryName = central.subarray(cursor + 46, cursor + 46 + fileNameLength).toString('utf8').replace(/\\/g, '/')
      if (entryName.startsWith('/') || entryName.split('/').includes('..')) {
        throw new ReportUploadError('DOCX 包含不安全的内部路径。', 422)
      }
      if (names.has(entryName)) {
        throw new ReportUploadError('DOCX 包含重复的内部条目。', 422)
      }
      names.add(entryName)
      archiveEntries.push({ compressionMethod, compressedSize, uncompressedSize, localOffset, inspectXml: isXmlArchiveEntry(entryName) })
      totalCompressed += compressedSize
      totalUncompressed += uncompressedSize
      if (totalCompressed > fileSize) throw new ReportUploadError('DOCX 内部条目累计压缩大小异常。', 422)
      if (totalUncompressed > maxUncompressedBytes) throw new ReportUploadError('DOCX 解压后内容超过限制。', 413)
      cursor = entryEnd
    }

    if (!names.has('[Content_Types].xml') || !names.has('word/document.xml')) {
      throw new ReportUploadError('ZIP 文件缺少 DOCX 必需内容。', 422)
    }
    const ratio = totalUncompressed / Math.max(1, totalCompressed)
    if (ratio > maxCompressionRatio) throw new ReportUploadError('DOCX 压缩比异常。', 422)
    await validateArchiveEntryContents(file, fileSize, archiveEntries)
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try {
      await file.close()
    } catch (error) {
      if (primaryError === undefined) throw error
    }
  }
}

function isXmlArchiveEntry(name: string) {
  const lower = name.toLowerCase()
  return lower.endsWith('.xml') || lower.endsWith('.rels')
}

/**
 * 解析器（@xmldom/xmldom）会展开 DTD 内部实体（billion laughs）。
 * 合法 OOXML 部件不允许声明 DOCTYPE/ENTITY；必须解压 XML 条目后再扫，
 * 压缩流上的明文搜索看不到 deflate 后的声明。
 */
async function validateArchiveEntryContents(
  file: Awaited<ReturnType<typeof open>>,
  fileSize: number,
  entries: Array<{ compressionMethod: number; compressedSize: number; uncompressedSize: number; localOffset: number; inspectXml: boolean }>,
) {
  for (const entry of entries) {
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
      throw new ReportUploadError('DOCX 包含不支持的压缩方式。', 422)
    }
    const local = Buffer.alloc(30)
    const headerRead = await file.read(local, 0, 30, entry.localOffset)
    if (headerRead.bytesRead < 30 || local.readUInt32LE(0) !== 0x04034b50) {
      throw new ReportUploadError('DOCX ZIP 本地头损坏。', 422)
    }
    const nameLength = local.readUInt16LE(26)
    const extraLength = local.readUInt16LE(28)
    const dataOffset = entry.localOffset + 30 + nameLength + extraLength
    if (dataOffset > fileSize || entry.compressedSize > fileSize - dataOffset) {
      throw new ReportUploadError('DOCX 内部 XML 数据边界无效。', 422)
    }
    const compressed = Buffer.alloc(entry.compressedSize)
    if (entry.compressedSize > 0) {
      const dataRead = await file.read(compressed, 0, entry.compressedSize, dataOffset)
      if (dataRead.bytesRead !== entry.compressedSize) {
        throw new ReportUploadError('DOCX 内部 XML 读取不完整。', 422)
      }
    }
    let content = compressed
    if (entry.compressionMethod === 8) {
      try {
        content = inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.uncompressedSize) })
      } catch {
        throw new ReportUploadError('DOCX 内部条目无法安全解压。', 422)
      }
    }
    if (content.length !== entry.uncompressedSize) {
      throw new ReportUploadError('DOCX 内部条目声明大小与实际内容不一致。', 422)
    }
    if (entry.inspectXml && (content.includes('<!DOCTYPE') || content.includes('<!ENTITY'))) {
      throw new ReportUploadError('DOCX 包含不允许的 DTD 实体声明。', 422)
    }
  }
}

function findSignatureBackwards(buffer: Buffer, signature: number) {
  for (let offset = buffer.length - 4; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset
  }
  return -1
}

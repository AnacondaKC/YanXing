import type { NextRequest } from 'next/server'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createWriteStream } from 'node:fs'
import { Transform, Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { extname, join } from 'node:path'
import { knowledgeMaxUploadBytes } from '@/lib/upload-limits'
import { runtimeConfig } from '@/lib/config/environment'
import {
  cancelReader,
  errorCode,
  releaseReaderLock,
  storageUnavailableErrnos,
  type UploadReader,
} from '@/lib/storage/stream-utils'
import { userCanDeleteKnowledgeItem, type KnowledgeItem } from '@/lib/db/repository'

export const maxFileBytes = knowledgeMaxUploadBytes
export const maxMultipartBytes = maxFileBytes + 1024 * 1024
export const uploadRateLimit = { limit: 12, windowMs: 60 * 60 * 1000 }
export const listRateLimit = { limit: 120, windowMs: 15 * 60 * 1000 }
export const fieldLimits = { title: 160, category: 40, description: 2_000, tags: 20, tagLength: 32 }

const knowledgeUploadConfig = runtimeConfig.knowledgeUpload
export const maxConcurrentUploads = Math.min(8, Math.max(1, knowledgeUploadConfig.concurrency))
const uploadIdleTimeoutMs = Math.max(1_000, knowledgeUploadConfig.idleTimeoutMs)
const uploadTotalTimeoutMs = Math.max(uploadIdleTimeoutMs, knowledgeUploadConfig.totalTimeoutMs)

type KnowledgeUploadGlobal = typeof globalThis & { __yanxingKnowledgeUploads?: { active: number } }
const uploadGlobal = globalThis as KnowledgeUploadGlobal
export const uploadState = uploadGlobal.__yanxingKnowledgeUploads ?? { active: 0 }
uploadGlobal.__yanxingKnowledgeUploads = uploadState

const allowedTypes = new Map([
  ['.pdf', new Set(['application/pdf'])],
  ['.docx', new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document'])],
])

type MultipartFileInfo = { filename: string; mimeType: string }
type MultipartFieldInfo = { valueTruncated?: boolean }
type MultipartParser = Writable & {
  on(event: 'field', listener: (name: string, value: string, info: MultipartFieldInfo) => void): MultipartParser
  on(event: 'file', listener: (name: string, file: Readable, info: MultipartFileInfo) => void): MultipartParser
  on(event: 'filesLimit' | 'fieldsLimit' | 'partsLimit', listener: () => void): MultipartParser
  on(event: 'error', listener: (error: Error) => void): MultipartParser
}
type MultipartFactory = (options: {
  headers: { 'content-type': string }
  limits: { files: number; fields: number; parts: number; fieldSize: number; fileSize: number }
}) => MultipartParser

const createMultipartParser = createRequire(import.meta.url)('next/dist/compiled/busboy/index.js') as MultipartFactory

export class UploadError extends Error {
  readonly code?: string

  constructor(readonly status: number, message: string, options: { code?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'UploadError'
    this.code = options.code
  }
}

export function normalizeUploadError(error: unknown): Error {
  const code = errorCode(error)
  if (code && storageUnavailableErrnos.has(code)) {
    return new UploadError(507, '知识库存储空间不可用。', { code, cause: error })
  }
  if (error instanceof Error) return error
  return new Error('上传请求格式无效。')
}

function isAbortLike(error: unknown) {
  return error instanceof Error && error.name === 'AbortError' || errorCode(error) === 'ABORT_ERR'
}

type MultipartErrorSource = 'parser' | 'parser-validation' | 'body' | 'file'

function multipartErrorPriority(error: Error, source: MultipartErrorSource) {
  if (source === 'parser' && (!(error instanceof UploadError) || error.status === 400)) return 0
  if (error instanceof UploadError) {
    if (error.status === 408) return 100
    if (error.status === 413) return 90
    if (error.status === 507) return 85
    if (error.status === 415) return 80
    return 70
  }
  return 60
}

export function throwIfUploadAborted(signal: AbortSignal) {
  if (signal.aborted) throw new UploadError(408, '上传已取消。')
}

export type PublicKnowledgeItem = Omit<KnowledgeItem, 'sourcePath' | 'fileHash' | 'uploadedByUserId'> & { canDelete: boolean }

export function toPublicItem(item: KnowledgeItem, user: Parameters<typeof userCanDeleteKnowledgeItem>[1]): PublicKnowledgeItem {
  const { sourcePath: _sourcePath, fileHash: _fileHash, uploadedByUserId: _uploadedByUserId, ...publicItem } = item
  return { ...publicItem, canDelete: userCanDeleteKnowledgeItem(item, user) }
}

export function parseContentLength(value: string | null) {
  if (value === null) return undefined
  if (!/^\d+$/.test(value)) throw new UploadError(400, 'Content-Length 无效。')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new UploadError(400, 'Content-Length 无效。')
  return parsed
}

function fileNameFromUpload(name: string) {
  const fileName = name.replace(/\\/g, '/').split('/').pop()?.replace(/[\u0000-\u001f\u007f]/g, '').trim() ?? ''
  if (!fileName || fileName.length > 255) throw new UploadError(400, '文件名无效。')
  return fileName
}

function validateFileDescriptor(name: string, mimeType: string) {
  const fileName = fileNameFromUpload(name)
  const extension = extname(fileName).toLowerCase()
  const mimeTypes = allowedTypes.get(extension)
  if (!mimeTypes || !mimeTypes.has(mimeType)) throw new UploadError(415, '仅支持 PDF 或 DOCX 文件。')
  return { fileName, extension }
}

async function* requestBodyChunks(request: NextRequest) {
  if (!request.body) throw new UploadError(400, '上传请求不能为空。')
  const reader = request.body.getReader()
  let total = 0
  let streamEnded = false
  const deadline = Date.now() + uploadTotalTimeoutMs
  try {
    while (true) {
      const result = await readUploadChunk(reader, request.signal, deadline)
      if (result.done) {
        streamEnded = true
        return
      }
      const value = result.value
      if (!value?.byteLength) continue
      total += value.byteLength
      if (total > maxMultipartBytes) {
        cancelReader(reader, 'multipart upload limit exceeded')
        throw new UploadError(413, '上传请求过大。')
      }
      yield value
    }
  } finally {
    if (!streamEnded) cancelReader(reader, 'multipart upload stopped')
    releaseReaderLock(reader)
  }
}

async function readUploadChunk(reader: UploadReader, signal: AbortSignal, deadline: number): Promise<ReadableStreamReadResult<Uint8Array>> {
  const remaining = deadline - Date.now()
  if (signal.aborted || remaining <= 0) throw new UploadError(408, signal.aborted ? '上传已取消。' : '上传超过总时限。')
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const rejectAndCancel = (message: string) => {
      cancelReader(reader, message)
      finish(() => reject(new UploadError(408, message)))
    }
    const onAbort = () => rejectAndCancel('上传已取消。')

    timer = setTimeout(
      () => rejectAndCancel(remaining <= uploadIdleTimeoutMs ? '上传超过总时限。' : '上传连接超时。'),
      Math.min(uploadIdleTimeoutMs, remaining),
    )
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
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

export type StreamedFile = { bytes: number; hash: string; firstBytes: Buffer; lastBytes: Buffer }

async function streamUploadToDisk(file: Readable, sourcePath: string): Promise<StreamedFile> {
  const hash = createHash('sha256')
  const firstBytes = Buffer.alloc(8)
  const lastBytes = Buffer.alloc(1024)
  let firstBytesLength = 0
  let lastBytesLength = 0
  let bytes = 0
  const observer = new Transform({
    transform(chunk: Buffer | Uint8Array, _encoding, callback) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += value.length
      hash.update(value)
      if (firstBytesLength < firstBytes.length) {
        const firstLength = Math.min(value.length, firstBytes.length - firstBytesLength)
        value.copy(firstBytes, firstBytesLength, 0, firstLength)
        firstBytesLength += firstLength
      }
      const keepLength = Math.min(value.length, lastBytes.length)
      if (keepLength === lastBytes.length) {
        value.copy(lastBytes, 0, value.length - keepLength)
        lastBytesLength = lastBytes.length
      } else {
        const discardLength = Math.max(0, lastBytesLength + keepLength - lastBytes.length)
        if (discardLength > 0) lastBytes.copyWithin(0, discardLength, lastBytesLength)
        value.copy(lastBytes, lastBytesLength - discardLength, value.length - keepLength)
        lastBytesLength = Math.min(lastBytes.length, lastBytesLength + keepLength)
      }
      callback(null, value)
    },
  })
  await pipeline(file, observer, createWriteStream(sourcePath, { flags: 'wx', mode: 0o600 }))
  return {
    bytes,
    hash: hash.digest('hex'),
    firstBytes: firstBytes.subarray(0, firstBytesLength),
    lastBytes: lastBytes.subarray(0, lastBytesLength),
  }
}

export async function parseStreamingMultipart(request: NextRequest, itemDirectory: string) {
  const contentType = request.headers.get('content-type')
  if (!contentType?.toLowerCase().startsWith('multipart/form-data')) {
    throw new UploadError(415, '上传请求必须使用 multipart/form-data。')
  }

  const fields = new Map<string, string>()
  let parser: MultipartParser
  try {
    parser = createMultipartParser({
      headers: { 'content-type': contentType },
      limits: { files: 1, fields: 10, parts: 12, fieldSize: 16 * 1024, fileSize: maxFileBytes },
    })
  } catch {
    throw new UploadError(400, '上传请求格式无效。')
  }

  let firstError: Error | undefined
  let firstErrorPriority = -1
  let streamedFile: StreamedFile | undefined
  let fileName: string | undefined
  let extension: string | undefined
  let sourcePath: string | undefined
  let filePromise: Promise<void> | undefined
  const fail = (error: unknown, source: MultipartErrorSource = 'file') => {
    let normalized = normalizeUploadError(error)
    if (isAbortLike(normalized)) normalized = new UploadError(408, '上传已取消。', { cause: error })
    const priority = multipartErrorPriority(normalized, source)
    if (!firstError || priority > firstErrorPriority) {
      firstError = normalized
      firstErrorPriority = priority
    }
  }

  parser.on('field', (name: string, value: string, info: MultipartFieldInfo) => {
    if (info.valueTruncated) {
      fail(new UploadError(413, '上传字段过大。'), 'parser-validation')
      return
    }
    if (!fields.has(name)) fields.set(name, value)
  })
  parser.on('file', (name: string, file: Readable, info: MultipartFileInfo) => {
    if (name !== 'file') {
      file.resume()
      fail(new UploadError(400, '请上传研报文件。'))
      return
    }
    if (filePromise) {
      file.resume()
      fail(new UploadError(400, '上传请求只能包含一个文件。'))
      return
    }
    try {
      const descriptor = validateFileDescriptor(info.filename, info.mimeType)
      fileName = descriptor.fileName
      extension = descriptor.extension
      sourcePath = join(itemDirectory, `source${extension}`)
      file.once('limit', () => fail(new UploadError(413, '文件大小不能超过 20 MB。')))
      filePromise = streamUploadToDisk(file, sourcePath).then((result) => {
        streamedFile = result
      }).catch((error) => {
        fail(error, 'file')
      })
    } catch (error) {
      file.resume()
      fail(error, 'file')
    }
  })
  parser.on('filesLimit', () => fail(new UploadError(400, '上传请求只能包含一个文件。'), 'parser-validation'))
  parser.on('fieldsLimit', () => fail(new UploadError(413, '上传字段过多。'), 'parser-validation'))
  parser.on('partsLimit', () => fail(new UploadError(413, '上传字段过多。'), 'parser-validation'))
  parser.on('error', (error: Error) => fail(error, 'parser'))

  try {
    await pipeline(Readable.from(requestBodyChunks(request)), parser)
  } catch (error) {
    fail(error, 'body')
  }
  if (request.signal.aborted) fail(new UploadError(408, '上传已取消。'), 'body')
  if (filePromise) await filePromise
  if (request.signal.aborted) fail(new UploadError(408, '上传已取消。'), 'body')
  if (firstError) {
    if (firstError instanceof UploadError) throw firstError
    throw new UploadError(400, firstError.message || '上传请求格式无效。', { cause: firstError })
  }
  if (!streamedFile || !fileName || !extension || !sourcePath) throw new UploadError(400, '请上传研报文件。')
  return { fields, fileName, extension, sourcePath, streamedFile }
}

export function validateFileContent(extension: string, firstBytes: Buffer, lastBytes: Buffer) {
  if (extension === '.pdf') {
    if (!firstBytes.toString('ascii').startsWith('%PDF-') || !lastBytes.toString('ascii').includes('%%EOF')) {
      throw new UploadError(415, 'PDF 文件格式无效。')
    }
    return
  }
  if (extension === '.docx' && !(firstBytes[0] === 0x50 && firstBytes[1] === 0x4b)) {
    throw new UploadError(415, 'DOCX 文件格式无效。')
  }
}

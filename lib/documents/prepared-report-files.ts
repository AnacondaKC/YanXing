import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, rm, rmdir, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { runtimeConfig } from '@/lib/config/environment'
import { DocumentParseError, extractDocumentText, type ExtractedDocumentText } from '@/lib/documents/document-parser'
import { maxUploadBytes, persistReportStream, ReportUploadError } from '@/lib/documents/report-storage'
import { errorCode } from '@/lib/storage/stream-utils'
import {
  ReportSubmissionError,
  type PreparedReportFiles,
} from '@/modules/reports/upload-domain'

const HASH_ALGORITHM = 'sha256'
const HASH_CHUNK_BYTES = 64 * 1024
const OWNED_SOURCE_KEY = /^([A-Za-z0-9_-]{1,128})\/\1\.(docx|pdf)$/i
const FALLBACK_TITLE = '未命名研究报告'
const FILE_OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW
const MISSING_ERRNOS = new Set(['ENOENT', 'ENOTDIR'])
const PRESERVED_DIRECTORY_ERRNOS = new Set(['ENOTEMPTY', 'EEXIST'])

type ExtractText = (filePath: string, signal?: AbortSignal) => Promise<ExtractedDocumentText>

export function createPreparedReportFiles(options: {
  storageRoot: string
  extractText?: ExtractText
  withMutation?: <T>(uploadId:string,write:()=>T)=>T
}): PreparedReportFiles {
  const storageRoot = resolve(requireStorageRoot(options.storageRoot))
  const extractText = options.extractText ?? extractDocumentText
  const maxExtractedCharacters = runtimeConfig.report.maxExtractedCharacters

  return {
    async prepare(input) {
      let persistedPath: string | undefined
      try {
        const source = await persistReportStream({
          reportId: input.uploadId,
          fileName: input.fileName,
          body: input.body,
          contentLength: input.contentLength,
          signal: input.signal,
          storageRoot,
          mutationFence: options.withMutation ? (write)=>options.withMutation!(input.uploadId,write) : undefined,
        })
        persistedPath = source.path
        const sourceKey = toRelativeSourceKey(storageRoot, source.path)
        const extracted = await extractBoundedText({
          extractText,
          filePath: source.path,
          maxCharacters: maxExtractedCharacters,
          signal: input.signal,
        })
        return {
          sourceKey,
          fileName: source.fileName,
          mimeType: source.mimeType,
          fileHash: source.sha256,
          sourceSize: source.size,
          title: titleFromFileName(source.fileName),
          text: extracted.text,
          paragraphCount: extracted.paragraphCount,
          characterCount: extracted.characterCount,
        }
      } catch (error) {
        const mapped = mapPrepareError(error, input.signal)
        if (!persistedPath) throw mapped
        try {
          await removePersistedFile(storageRoot, persistedPath)
        } catch {
          throw new ReportSubmissionError('UPLOAD_CLEANUP_FAILED', '准备文件清理失败。', 500)
        }
        throw mapped
      }
    },

    async verify(file) {
      const absolutePath = resolveOwnedPath(storageRoot, file.sourceKey)
      const handle = await openOwnedRegularFile(storageRoot, absolutePath)
      try {
        const expectedSize = file.sourceSize
        if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > maxUploadBytes) throw fileChanged()
        const stats = await handle.stat()
        if (!stats.isFile() || Number(stats.size) !== expectedSize) throw fileChanged()
        const digest = await hashHandle(handle, expectedSize)
        if (digest.size !== expectedSize || digest.sha256 !== file.fileHash) throw fileChanged()
      } catch (error) {
        if (error instanceof ReportSubmissionError) throw error
        throw fileChanged()
      } finally {
        await handle.close()
      }
    },

    async discard(file) {
      const absolutePath = resolveOwnedPath(storageRoot, file.sourceKey)
      try {
        await removePersistedFile(storageRoot, absolutePath)
      } catch (error) {
        if (isMissing(error)) return
        if (error instanceof ReportSubmissionError) throw error
        throw new ReportSubmissionError('UPLOAD_CLEANUP_FAILED', '准备文件清理失败。', 500)
      }
    },
  }
}

function requireStorageRoot(storageRoot: string) {
  if (typeof storageRoot !== 'string' || !storageRoot.trim()) throw new Error('准备文件存储根目录无效。')
  return storageRoot
}

function titleFromFileName(fileName: string) {
  return basename(fileName).replace(/\.(docx|pdf)$/i, '').trim() || FALLBACK_TITLE
}

async function extractBoundedText(input: {
  extractText: ExtractText
  filePath: string
  maxCharacters: number
  signal?: AbortSignal
}) {
  const extracted = await input.extractText(input.filePath, input.signal)
  if (
    typeof extracted.text !== 'string'
    || !extracted.text.trim()
    || extracted.characterCount !== extracted.text.length
    || !Number.isInteger(extracted.paragraphCount)
    || extracted.paragraphCount < 1
    || extracted.text.length > input.maxCharacters
  ) {
    throw new ReportSubmissionError('REPORT_PARSE_FAILED', '报告正文解析结果无效。', 422)
  }
  return extracted
}

function mapPrepareError(error: unknown, signal?: AbortSignal) {
  if (error instanceof ReportSubmissionError) return error
  if (error instanceof ReportUploadError && error.code === 'UPLOAD_CLEANUP_FAILED') {
    return new ReportSubmissionError('UPLOAD_CLEANUP_FAILED', '准备文件清理失败。', 500)
  }
  if (signal?.aborted || isAbortError(error)) {
    return new ReportSubmissionError('UPLOAD_ABORTED', '报告上传已取消。', 408)
  }
  if (error instanceof ReportUploadError) {
    return new ReportSubmissionError('UPLOAD_FILE_INVALID', error.message, error.status)
  }
  if (error instanceof DocumentParseError) {
    return new ReportSubmissionError('REPORT_PARSE_FAILED', '报告正文解析失败。', 422)
  }
  return new ReportSubmissionError('UPLOAD_FILE_INVALID', '报告文件无效。', 422)
}

function isAbortError(error: unknown) {
  return error instanceof ReportUploadError && error.status === 408
    || error instanceof DocumentParseError && error.message.includes('已取消')
}

function toRelativeSourceKey(root: string, absolutePath: string) {
  if (!isContained(root, absolutePath)) throw invalidPath()
  const sourceKey = relative(resolve(root), resolve(absolutePath)).split(sep).join('/')
  assertOwnedSourceKey(sourceKey)
  return sourceKey
}

function resolveOwnedPath(root: string, sourceKey: unknown) {
  assertOwnedSourceKey(sourceKey)
  const absolutePath = resolve(root, sourceKey)
  if (!isContained(root, absolutePath)) throw invalidPath()
  return absolutePath
}

function assertOwnedSourceKey(sourceKey: unknown): asserts sourceKey is string {
  if (
    typeof sourceKey !== 'string'
    || sourceKey.includes('\\')
    || sourceKey.includes('\0')
    || isAbsolute(sourceKey)
    || !OWNED_SOURCE_KEY.test(sourceKey)
  ) {
    throw invalidPath()
  }
}

function isContained(root: string, candidate: string) {
  const rel = relative(resolve(root), resolve(candidate))
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

async function openOwnedRegularFile(root: string, absolutePath: string) {
  await assertSafeOwnedPath(root, absolutePath)
  try {
    const handle = await open(absolutePath, FILE_OPEN_FLAGS)
    const stats = await handle.stat()
    if (!stats.isFile()) {
      await handle.close().catch(() => undefined)
      throw fileChanged()
    }
    return handle
  } catch (error) {
    if (error instanceof ReportSubmissionError) throw error
    if (errorCode(error) === 'ELOOP' || isMissing(error)) throw fileChanged()
    throw invalidPath()
  }
}

async function removePersistedFile(root: string, absolutePath: string) {
  try {
    await assertSafeOwnedPath(root, absolutePath)
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  await rm(absolutePath)
  const parent = dirname(absolutePath)
  if (!isContained(root, parent)) return
  try {
    await rmdir(parent)
  } catch (error) {
    if (isMissing(error)) return
    const code = errorCode(error)
    if (code && PRESERVED_DIRECTORY_ERRNOS.has(code)) return
    throw error
  }
}

async function assertSafeOwnedPath(root: string, filePath: string) {
  if (!isContained(root, filePath)) throw invalidPath()
  await assertSafeAncestors(root, filePath)
  const stats = await lstat(filePath)
  if (stats.isSymbolicLink() || !stats.isFile()) throw invalidPath()
  const realRoot = await realpath(resolve(root))
  const realParent = await realpath(dirname(filePath))
  if (!isContained(realRoot, realParent)) throw invalidPath()
}

async function assertSafeAncestors(root: string, filePath: string) {
  const resolvedRoot = resolve(root)
  let cursor = dirname(resolve(filePath))
  while (cursor !== resolvedRoot && cursor !== dirname(cursor)) {
    const stats = await lstat(cursor)
    if (stats.isSymbolicLink()) throw invalidPath()
    cursor = dirname(cursor)
  }
}

async function hashHandle(handle: FileHandle, byteCeiling: number) {
  const digest = createHash(HASH_ALGORITHM)
  const buffer = Buffer.alloc(HASH_CHUNK_BYTES)
  let size = 0
  let position = 0
  while (true) {
    const result = await handle.read(buffer, 0, buffer.length, position)
    if (result.bytesRead === 0) break
    if (size + result.bytesRead > byteCeiling) throw fileChanged()
    digest.update(buffer.subarray(0, result.bytesRead))
    size += result.bytesRead
    position += result.bytesRead
  }
  return { size, sha256: digest.digest('hex') }
}

function isMissing(error: unknown) {
  const code = errorCode(error)
  return Boolean(code && MISSING_ERRNOS.has(code))
}

function invalidPath() {
  return new ReportSubmissionError('UPLOAD_FILE_INVALID', '准备文件路径无效。', 400)
}

function fileChanged() {
  return new ReportSubmissionError('REPORT_FILE_CHANGED', '报告文件已变化。', 409)
}

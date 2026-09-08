import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { runtimeConfig } from '@/lib/config/environment'
import { errorCode } from '@/lib/storage/stream-utils'
import { resolveParserChildRuntime } from './parser-child-runtime'
import { maxUploadBytes } from './report-storage'

const maxExtractedCharacters = runtimeConfig.report.maxExtractedCharacters
const maxDocxParseConcurrency = Math.min(8, runtimeConfig.report.docxParseConcurrency)
const maxPdfParseConcurrency = Math.min(2, runtimeConfig.report.pdfParseConcurrency)
const maxParseQueue = Math.min(256, runtimeConfig.report.parseQueueLimit)
const pdfParseTimeoutMs = runtimeConfig.report.pdfParseTimeoutMs
const pdfParserMemoryMb = runtimeConfig.report.pdfParserMemoryMb
const maxPdfParserResultBytes = Math.max(1_048_576, maxExtractedCharacters * 4)
const docxParseTimeoutMs = runtimeConfig.report.docxParseTimeoutMs
const docxParserMemoryMb = runtimeConfig.report.docxParserMemoryMb
const maxDocxParserResultBytes = Math.max(1_048_576, maxExtractedCharacters * 4)
type SharedAbortableTaskEntry<T> = {
  promise: Promise<T>
  controller: AbortController
  waiters: number
  completed: boolean
}

export function createSharedAbortableTaskMap<T>(
  start: (key: string, signal: AbortSignal) => Promise<T>,
  label: string,
) {
  const pending = new Map<string, SharedAbortableTaskEntry<T>>()

  return {
    run(key: string, signal?: AbortSignal): Promise<T> {
      throwIfParserAborted(signal, label)
      let entry = pending.get(key)
      if (!entry || entry.completed) {
        const controller = new AbortController()
        const created: SharedAbortableTaskEntry<T> = {
          promise: Promise.resolve() as Promise<T>,
          controller,
          waiters: 0,
          completed: false,
        }
        created.promise = start(key, controller.signal).then(
          (value) => {
            created.completed = true
            if (pending.get(key) === created) pending.delete(key)
            return value
          },
          (error: unknown) => {
            created.completed = true
            if (pending.get(key) === created) pending.delete(key)
            throw error
          },
        )
        entry = created
        pending.set(key, created)
      }

      entry.waiters += 1
      let released = false
      const release = () => {
        if (released) return
        released = true
        entry.waiters -= 1
        if (entry.waiters === 0 && !entry.completed) entry.controller.abort()
      }
      signal?.addEventListener('abort', release, { once: true })
      return raceWithParserAbort(entry.promise, signal, label).finally(() => {
        signal?.removeEventListener('abort', release)
        release()
      })
    },
  }
}

const pendingCachedDocumentExtractions = createSharedAbortableTaskMap(
  (filePath, signal) => readOrExtractCachedDocumentText(filePath, signal),
  '文档',
)

// 解析并发信号量：mammoth / pdf.js 在解析期会展开压缩流，无界并发。
// PDF 的实测 RSS 远高于 DOCX，因此使用独立且更保守的并发池。
type ParseKind = 'DOCX' | 'PDF'
type ParseWaiter = { resolve: () => void; reject: (error: Error) => void; cancelled: boolean }
type ParsePool = { active: number; queue: ParseWaiter[]; limit: number }

const parsePools: Record<ParseKind, ParsePool> = {
  DOCX: { active: 0, queue: [], limit: maxDocxParseConcurrency },
  PDF: { active: 0, queue: [], limit: maxPdfParseConcurrency },
}

async function withParseSlot<T>(kind: ParseKind, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  await acquireParseSlot(kind, signal)
  try {
    throwIfParserAborted(signal, '文档')
    return await operation()
  } finally {
    releaseParseSlot(kind)
  }
}

function acquireParseSlot(kind: ParseKind, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DocumentParseError('文档解析已取消。'))
  const pool = parsePools[kind]
  if (pool.active < pool.limit) {
    pool.active += 1
    return Promise.resolve()
  }
  if (pool.queue.length >= maxParseQueue) throw new DocumentParseError('文档解析任务较多，请稍后再试。', true)
  return new Promise((resolve, reject) => {
    let settled = false
    const waiter: ParseWaiter = {
      cancelled: false,
      resolve: () => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        resolve()
      },
      reject: (error) => {
        if (settled) return
        settled = true
        waiter.cancelled = true
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      },
    }
    const onAbort = () => {
      if (settled) return
      const index = pool.queue.indexOf(waiter)
      if (index >= 0) pool.queue.splice(index, 1)
      waiter.reject(new DocumentParseError('文档解析已取消。'))
    }
    // 先入队，再注册监听，避免自定义 AbortSignal 在注册时同步触发 abort
    // 时留下一个已拒绝但仍占据队列的 waiter。
    pool.queue.push(waiter)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function releaseParseSlot(kind: ParseKind) {
  const pool = parsePools[kind]
  while (pool.queue.length) {
    const next = pool.queue.shift()
    if (!next || next.cancelled) continue
    next.resolve()
    return
  }
  pool.active -= 1
}

export interface ExtractedDocumentText {
  text: string
  paragraphCount: number
  characterCount: number
}

export class DocumentParseError extends Error {
  readonly code?: string

  constructor(message: string, readonly retryable = false, options: { code?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DocumentParseError'
    this.code = options.code
  }
}

export function isDocumentParseError(error: unknown): error is DocumentParseError {
  return error instanceof DocumentParseError
}

/** 按文件扩展名分派到对应的本地解析器（DOCX / PDF）。 */
export async function extractDocumentText(filePath: string, signal?: AbortSignal): Promise<ExtractedDocumentText> {
  throwIfParserAborted(signal, '文档')
  return /\.pdf$/i.test(filePath) ? extractPdfText(filePath, signal) : extractDocxText(filePath, signal)
}

/** 报告文件不可变，因此可按源文件路径安全复用已提取的纯文本。 */
export function extractCachedDocumentText(filePath: string, signal?: AbortSignal): Promise<ExtractedDocumentText> {
  return pendingCachedDocumentExtractions.run(filePath, signal)
}

async function readOrExtractCachedDocumentText(filePath: string, signal?: AbortSignal): Promise<ExtractedDocumentText> {
  const cachePath = `${filePath}.content.json`
  throwIfParserAborted(signal, '文档')
  const cached = await readExtractedTextCache(cachePath)
  if (cached) return cached

  throwIfParserAborted(signal, '文档')
  const extracted = await extractDocumentText(filePath, signal)
  throwIfParserAborted(signal, '文档')
  const temporaryPath = `${cachePath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, JSON.stringify(extracted), { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, cachePath)
  } catch {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
  return extracted
}

function throwIfParserAborted(signal: AbortSignal | undefined, label: string) {
  if (signal?.aborted) throw new DocumentParseError(`${label} 解析已取消。`)
}

function raceWithParserAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, label: string): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new DocumentParseError(`${label} 解析已取消。`))
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const onAbort = () => finish(() => reject(new DocumentParseError(`${label} 解析已取消。`)))

    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}

async function readExtractedTextCache(cachePath: string): Promise<ExtractedDocumentText | undefined> {
  try {
    const value = JSON.parse(await readFile(cachePath, 'utf8')) as Partial<ExtractedDocumentText>
    if (
      typeof value.text !== 'string'
      || !value.text
      || value.text.length > maxExtractedCharacters
      || !Number.isInteger(value.paragraphCount)
      || Number(value.paragraphCount) < 1
      || value.characterCount !== value.text.length
    ) return undefined
    return value as ExtractedDocumentText
  } catch {
    return undefined
  }
}

export async function extractDocxText(filePath: string, signal?: AbortSignal): Promise<ExtractedDocumentText> {
  try {
    throwIfParserAborted(signal, 'DOCX')
    return await withParseSlot('DOCX', async () => {
      await assertFileWithinUploadLimit(filePath, 'DOCX')
      return await runIsolatedDocxParser(filePath, signal)
    }, signal)
  } catch (error) {
    if (error instanceof DocumentParseError) throw error
    const detail = error instanceof Error && error.message ? `：${error.message}` : ''
    throw new DocumentParseError(`DOCX 解析失败${detail}`)
  }
}

export async function extractPdfText(filePath: string, signal?: AbortSignal): Promise<ExtractedDocumentText> {
  try {
    throwIfParserAborted(signal, 'PDF')
    return await withParseSlot('PDF', async () => {
      await assertFileWithinUploadLimit(filePath, 'PDF')
      return await runIsolatedPdfParser(filePath, signal)
    }, signal)
  } catch (error) {
    if (error instanceof DocumentParseError) throw error
    const detail = error instanceof Error && error.message ? `：${error.message}` : ''
    throw new DocumentParseError(`PDF 解析失败${detail}`)
  }
}

function runIsolatedPdfParser(filePath: string, signal?: AbortSignal): Promise<ExtractedDocumentText> {
  return runIsolatedParser(filePath, {
    ...resolveParserChildRuntime({ kind: 'PDF' }),
    label: 'PDF',
    memoryMb: pdfParserMemoryMb,
    timeoutMs: pdfParseTimeoutMs,
    maxResultBytes: maxPdfParserResultBytes,
    signal,
  })
}

function runIsolatedDocxParser(filePath: string, signal?: AbortSignal): Promise<ExtractedDocumentText> {
  return runIsolatedParser(filePath, {
    ...resolveParserChildRuntime({ kind: 'DOCX' }),
    label: 'DOCX',
    memoryMb: docxParserMemoryMb,
    timeoutMs: docxParseTimeoutMs,
    maxResultBytes: maxDocxParserResultBytes,
    signal,
  })
}

// A broken child implementation must not keep the parse slot forever after kill.
const parserCloseFallbackMs = 100

function runIsolatedParser(
  filePath: string,
  options: { workerPath: string; tsxLoaderPath: string; label: 'DOCX' | 'PDF'; memoryMb: number; timeoutMs: number; maxResultBytes: number; signal?: AbortSignal },
): Promise<ExtractedDocumentText> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      `--max-old-space-size=${options.memoryMb}`,
      '--import',
      options.tsxLoaderPath,
      options.workerPath,
      filePath,
    ], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const output: Buffer[] = []
    let outputBytes = 0
    let stderr = ''
    let settled = false
    let processError: Error | undefined
    let terminationError: Error | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let closeFallback: ReturnType<typeof setTimeout> | undefined
    let processErrorFallback: ReturnType<typeof setTimeout> | undefined

    const finish = (error?: Error, value?: ExtractedDocumentText) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (closeFallback) clearTimeout(closeFallback)
      if (processErrorFallback) clearTimeout(processErrorFallback)
      options.signal?.removeEventListener('abort', onAbort)
      const finalError = terminationError ?? processError ?? error
      if (finalError) reject(finalError)
      else if (value) resolve(value)
      else reject(new DocumentParseError(stderr.trim() || `${options.label} 解析失败。`))
    }

    const scheduleCloseFallback = () => {
      if (closeFallback || settled) return
      closeFallback = setTimeout(() => finish(terminationError), parserCloseFallbackMs)
      closeFallback.unref()
    }

    const terminate = (error: Error) => {
      if (settled || terminationError) return
      terminationError = error
      let killed = false
      try {
        killed = child.kill('SIGKILL')
      } catch {
        killed = false
      }
      if (killed) scheduleCloseFallback()
      else finish(error)
    }

    const onAbort = () => terminate(new DocumentParseError(`${options.label} 解析已取消。`))

    // ChildProcess can emit close/error as soon as it is spawned. Register every
    // process listener before observing an already-aborted signal.
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled || terminationError) return
      outputBytes += chunk.byteLength
      if (outputBytes > options.maxResultBytes) {
        terminate(new DocumentParseError(`${options.label} 提取结果超过大小限制。`))
        return
      }
      output.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) return
      stderr += chunk.toString('utf8').slice(0, 4_096 - stderr.length)
    })
    child.once('error', (error) => {
      processError = new DocumentParseError(`${options.label} 解析进程启动失败：${error.message}`, true)
      if (terminationError || settled || processErrorFallback) return
      processErrorFallback = setTimeout(() => finish(processError), parserCloseFallbackMs)
      processErrorFallback.unref()
    })
    child.once('close', (code, terminationSignal) => {
      if (settled) return
      if (terminationError) {
        finish(terminationError)
        return
      }
      if (processError) {
        finish(processError)
        return
      }
      const raw = Buffer.concat(output).toString('utf8').trim()
      let result: { ok?: boolean; text?: string; paragraphCount?: number; characterCount?: number; error?: string } | undefined
      try {
        result = raw ? JSON.parse(raw) as typeof result : undefined
      } catch {
        result = undefined
      }
      const resultText = result?.text
      const resultParagraphCount = result?.paragraphCount
      const resultCharacterCount = result?.characterCount
      if (result?.ok && typeof resultText === 'string' && Number.isInteger(resultParagraphCount) && Number.isInteger(resultCharacterCount)) {
        finish(undefined, { text: resultText, paragraphCount: resultParagraphCount as number, characterCount: resultCharacterCount as number })
        return
      }
      const reason = result?.error || stderr.trim() || (terminationSignal ? `解析进程被 ${terminationSignal} 终止` : `${options.label} 解析进程退出码：${code ?? 'unknown'}`)
      finish(new DocumentParseError(reason))
    })

    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    if (!terminationError) {
      timeout = setTimeout(() => {
        terminate(new DocumentParseError(`${options.label} 解析超过时间限制。`, true))
      }, options.timeoutMs)
      timeout.unref()
    }
  })
}

const permanentStatErrnos = new Set(['ENOENT', 'ENOTDIR'])

async function assertFileWithinUploadLimit(filePath: string, documentType: 'DOCX' | 'PDF') {
  let details: Awaited<ReturnType<typeof stat>>
  try {
    details = await stat(filePath)
  } catch (error) {
    throw classifyStatFailure(error, documentType)
  }
  if (!details.isFile()) {
    throw new DocumentParseError(`${documentType} 文件读取失败：不是常规文件。`, false, { code: 'NOT_REGULAR_FILE' })
  }

  const fileSize = Number(details.size)
  if (fileSize > maxUploadBytes) {
    throw new DocumentParseError(`${documentType} 文件超过 ${maxUploadBytes} 字节限制。`)
  }
  return fileSize
}

function classifyStatFailure(error: unknown, documentType: 'DOCX' | 'PDF') {
  const code = errorCode(error) ?? 'UNKNOWN'
  const retryable = !permanentStatErrnos.has(code)
  const detail = error instanceof Error && error.message ? `：${error.message}` : ''
  return new DocumentParseError(`${documentType} 文件读取失败${detail}`, retryable, { code, cause: error })
}

const PROMPT_TEXT_OMISSION_MARK = '\n\n[正文中间部分因模型提示词限制被省略]\n\n'

export function fitTextToPrompt(text: string, characterBudget: number) {
  if (!Number.isFinite(characterBudget) || characterBudget < 0) {
    throw new Error('正文截取预算无效。')
  }
  if (characterBudget === 0) return { text: '', truncated: text.length > 0 }
  if (text.length <= characterBudget) return { text, truncated: false }

  if (characterBudget <= PROMPT_TEXT_OMISSION_MARK.length) {
    return { text: text.slice(0, characterBudget), truncated: true }
  }
  const contentBudget = characterBudget - PROMPT_TEXT_OMISSION_MARK.length
  const headLength = Math.floor(contentBudget * 0.65)
  const tailLength = contentBudget - headLength
  return {
    text: `${text.slice(0, headLength)}${PROMPT_TEXT_OMISSION_MARK}${text.slice(-tailLength)}`,
    truncated: true,
  }
}

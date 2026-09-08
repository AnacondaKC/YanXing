import { type Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { DocumentParseError } from '@/lib/documents/document-parser'
import { errorCode } from '@/lib/storage/stream-utils'

export type ReportSourceErrorKind =
  | 'missing'
  | 'not_regular'
  | 'invalid_path'
  | 'permission'
  | 'io'
  | 'resource'
  | 'stale'
  | 'unavailable'

type ReportSourceErrorOptions = {
  code: string
  kind: ReportSourceErrorKind
  message: string
  retryable: boolean
  cause?: unknown
}

export class ReportSourceError extends DocumentParseError {
  readonly kind: ReportSourceErrorKind

  constructor(options: ReportSourceErrorOptions) {
    super(options.message, options.retryable, { code: options.code, cause: options.cause })
    this.name = 'ReportSourceError'
    this.kind = options.kind
  }
}

export function isReportSourceError(error: unknown): error is ReportSourceError {
  return error instanceof ReportSourceError
}

export function isPermanentReportSourceError(error: unknown): error is ReportSourceError {
  return isReportSourceError(error) && (error.kind === 'missing' || error.kind === 'not_regular' || error.kind === 'invalid_path')
}

/**
 * Check the immutable report source before handing it to a parser or provider.
 * fs.stat does not cancel an in-flight syscall on every supported Node version,
 * so the promise is raced with the worker signal as well as checking it around stat.
 */
export async function ensureReportSourceFile(sourcePath: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  let file: Stats
  try {
    file = await statWithSignal(sourcePath, signal)
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) throw error
    throw classifyReportSourceError(error)
  }
  throwIfAborted(signal)
  if (!file.isFile()) {
    throw new ReportSourceError({
      code: 'NOT_REGULAR_FILE',
      kind: 'not_regular',
      message: '报告原始文件不是常规文件，无法提交给 AI。',
      retryable: false,
    })
  }
}

function statWithSignal(sourcePath: string, signal?: AbortSignal): Promise<Stats> {
  if (!signal) return stat(sourcePath)
  if (signal.aborted) return Promise.reject(createAbortError())

  return new Promise<Stats>((resolve, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const onAbort = () => finish(() => reject(createAbortError()))

    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }

    statWithAbortSignal(sourcePath, signal).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    )
  })
}

function statWithAbortSignal(sourcePath: string, signal: AbortSignal): Promise<Stats> {
  // Cancellation is enforced by the surrounding abort race.
  const statWithOptions = stat as unknown as (path: string, options: { signal: AbortSignal }) => Promise<Stats>
  return statWithOptions(sourcePath, { signal })
}

function classifyReportSourceError(error: unknown): ReportSourceError {
  const code = errorCode(error)
  switch (code) {
    case 'ENOENT':
      return new ReportSourceError({ code, kind: 'missing', message: '报告原始文件不存在，无法提交给 AI。', retryable: false, cause: error })
    case 'ENOTDIR':
      return new ReportSourceError({ code, kind: 'invalid_path', message: '报告原始文件路径无效，无法提交给 AI。', retryable: false, cause: error })
    case 'EACCES':
    case 'EPERM':
      return new ReportSourceError({ code, kind: 'permission', message: '报告原始文件权限不足，暂时无法提交给 AI。', retryable: true, cause: error })
    case 'EIO':
      return new ReportSourceError({ code, kind: 'io', message: '报告原始文件读取失败，请稍后重试。', retryable: true, cause: error })
    case 'EMFILE':
    case 'ENFILE':
      return new ReportSourceError({ code, kind: 'resource', message: '系统文件资源暂时不足，请稍后重试。', retryable: true, cause: error })
    case 'ESTALE':
      return new ReportSourceError({ code, kind: 'stale', message: '报告原始文件状态已失效，请稍后重试。', retryable: true, cause: error })
    default:
      return new ReportSourceError({ code: code ?? 'UNKNOWN', kind: 'unavailable', message: '报告原始文件检查失败，请稍后重试。', retryable: true, cause: error })
  }
}

function isAbortError(error: unknown) {
  if (error instanceof Error && error.name === 'AbortError') return true
  return errorCode(error) === 'ABORT_ERR'
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw createAbortError()
}

function createAbortError() {
  const error = new Error('报告原始文件检查已取消。')
  error.name = 'AbortError'
  return error
}

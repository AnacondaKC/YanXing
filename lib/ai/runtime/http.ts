import { waitForRateLimit } from '@/lib/security/rate-limit'
import { ModelProviderError, parseRetryAfter, providerErrorMessage, redactSecret } from '@/lib/ai/runtime/errors'
import { runtimeConfig } from '@/lib/config/environment'

// 非流式请求在完整生成结束前不会返回任何字节，空闲超时必须容纳洞察等长内容生成的首字节等待。
function getMaxResponseBytes() {
  return runtimeConfig.model.maxResponseBytes
}

export interface HttpRequestInput {
  url: string
  apiKey: string
  providerLabel: string
  json?: unknown
  headers?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  /** 在 fetch 前通知调用方，确保 provider 调用开始状态先于网络请求落库。 */
  onRequestStarted?: () => void | PromiseLike<void>
}

export interface HttpJsonResult {
  ok: boolean
  status: number
  headers: Headers
  value: Record<string, unknown>
  raw: string
  retryAfterMs?: number
}

type HttpRequestHandle = {
  response: Response
  signal: AbortSignal
  abort: (timedOut?: boolean) => void
  timedOut: () => boolean
  cleanup: () => void
  providerLabel: string
  idleTimeoutMs: number
}

type ResponseReader = ReadableStreamDefaultReader<Uint8Array>

function cancelReader(reader: ResponseReader, reason?: unknown) {
  try {
    void reader.cancel(reason).catch(() => undefined)
  } catch {
    // Cleanup must remain best-effort when a custom body has already closed.
  }
}

function releaseReaderLock(reader: ResponseReader) {
  try {
    reader.releaseLock()
  } catch {
    // A reader can be released by the stream implementation while cleanup races.
  }
}

export async function requestJson(input: HttpRequestInput): Promise<HttpJsonResult> {
  const handle = await sendHttpRequest(input)
  try {
    const body = await readResponseBytes(handle.response, input.apiKey, {
      signal: handle.signal,
      abort: handle.abort,
      timedOut: handle.timedOut,
      providerLabel: input.providerLabel,
      maxBytes: getMaxResponseBytes(),
      idleTimeoutMs: handle.idleTimeoutMs,
    })
    return {
      ok: handle.response.ok,
      status: handle.response.status,
      headers: handle.response.headers,
      value: body.value,
      get raw() { return body.raw },
      retryAfterMs: parseRetryAfter(handle.response.headers.get('retry-after')),
    }
  } finally {
    handle.cleanup()
  }
}

async function awaitRequestStart(
  callback: HttpRequestInput['onRequestStarted'],
  signal: AbortSignal,
  providerLabel: string,
  timedOut: () => boolean,
): Promise<void> {
  if (signal.aborted) throw requestAbortError(providerLabel, timedOut())
  if (!callback) return
  let abortListener: (() => void) | undefined
  const abortPromise = new Promise<never>((_, reject) => {
    abortListener = () => reject(requestAbortError(providerLabel, timedOut()))
    signal.addEventListener('abort', abortListener, { once: true })
    if (signal.aborted) abortListener()
  })
  if (signal.aborted) throw requestAbortError(providerLabel, timedOut())
  const callbackPromise = Promise.resolve().then(callback)
  try {
    await Promise.race([callbackPromise, abortPromise])
    if (signal.aborted) {
      callbackPromise.catch(() => undefined)
      throw requestAbortError(providerLabel, timedOut())
    }
  } catch (error) {
    if (error instanceof ModelProviderError) throw error
    if (signal.aborted) throw requestAbortError(providerLabel, timedOut())
    throw new ModelProviderError(
      providerLabel + ' 请求启动回调失败：' + safeErrorMessage(error),
      { code: 'request_start_failed', retryable: false },
    )
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener)
  }
}

function requestAbortError(providerLabel: string, timedOut: boolean) {
  return new ModelProviderError(
    timedOut ? providerLabel + ' 请求超时。' : providerLabel + ' 请求已取消。',
    { code: timedOut ? 'timeout' : 'aborted', retryable: timedOut },
  )
}

async function sendHttpRequest(input: HttpRequestInput): Promise<HttpRequestHandle> {
  if (!input.apiKey.trim()) throw new ModelProviderError(input.providerLabel + ' API 密钥不能为空。', { code: 'unauthorized', retryable: false })
  const modelConfig = runtimeConfig.model

  const controller = new AbortController()
  let timedOut = false
  const signal = input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, positiveNumber(input.timeoutMs ?? 120_000, 120_000))
  // 消费者弃读且未 cancel 时，超时定时器不应独自挂住事件循环。
  timeout.unref?.()
  const cleanup = () => clearTimeout(timeout)
  let responseReturned = false

  try {
    await waitForRateLimit(
      'model:' + input.url,
      { limit: modelConfig.callsPerMinute, windowMs: 60 * 1000 },
      signal,
    )

    const headers: Record<string, string> = { ...(input.headers ?? {}) }
    headers.Authorization = 'Bearer ' + input.apiKey
    if (input.json !== undefined) headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'

    const body = input.json !== undefined ? JSON.stringify(input.json) : undefined
    // 只有通过限流和请求体预检后才标记开始；此前失败不会把 reservation 锁成 uncertain。
    await awaitRequestStart(input.onRequestStarted, signal, input.providerLabel, () => timedOut)
    const response = await fetch(input.url, {
      method: 'POST',
      headers,
      body,
      signal,
    })
    responseReturned = true
    return {
      response,
      signal,
      abort: (dueToTimeout = false) => {
        if (dueToTimeout) timedOut = true
        controller.abort()
      },
      timedOut: () => timedOut,
      cleanup,
      providerLabel: input.providerLabel,
      idleTimeoutMs: Math.min(positiveNumber(input.timeoutMs ?? 120_000, 120_000), modelConfig.idleTimeoutMs),
    }
  } catch (error) {
    cleanup()
    if (error instanceof ModelProviderError) throw error
    if (error instanceof Error && (error.name === 'AbortError' || signal.aborted)) {
      throw new ModelProviderError(
        timedOut ? input.providerLabel + ' 请求超时。' : input.providerLabel + ' 请求已取消。',
        { code: timedOut ? 'timeout' : 'aborted', retryable: timedOut },
      )
    }
    const code = requestErrorCode(error)
    throw new ModelProviderError(
      code === 'dns_error'
        ? input.providerLabel + ' 域名无法解析。'
        : input.providerLabel + ' 请求失败：' + safeErrorMessage(error),
      { code, retryable: requestErrorRetryable(error) },
    )
  } finally {
    if (!responseReturned) cleanup()
  }
}

export async function readResponseBytes(
  response: Response,
  apiKey: string,
  options: {
    signal?: AbortSignal
    abort?: (timedOut?: boolean) => void
    timedOut?: () => boolean
    providerLabel?: string
    maxBytes?: number
    idleTimeoutMs?: number
  } = {},
): Promise<{ raw: string; value: Record<string, unknown> }> {
  if (!response.body) return { raw: '', value: {} as Record<string, unknown> }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  const limit = options.maxBytes ?? getMaxResponseBytes()
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await readWithIdleTimeout(reader, options)
      if (done) break
      if (!value?.byteLength) continue
      bytes += value.byteLength
      if (bytes > limit) {
        cancelReader(reader, 'response limit exceeded')
        throw new ModelProviderError('模型响应超过大小限制。', { code: 'response_too_large', retryable: false })
      }
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    cancelReader(reader)
    throw normalizeResponseReadError(error, options)
  } finally {
    releaseReaderLock(reader)
  }

  const raw = Buffer.concat(chunks, bytes).toString('utf8')
  const trimmed = raw.trim()
  if (!trimmed) return { raw, value: {} as Record<string, unknown> }
  try {
    const parsed = JSON.parse(trimmed) as unknown
    const redacted = redactSecret(parsed, apiKey)
    if (redacted && typeof redacted === 'object' && !Array.isArray(redacted)) {
      const value = redacted as Record<string, unknown>
      let cachedRaw: string | undefined
      return {
        value,
        get raw() {
          cachedRaw ??= serializeResponseValue(value)
          return cachedRaw
        },
      }
    }
    const safeRaw = serializeResponseValue(redacted)
    return { raw: safeRaw, value: { raw: safeRaw.slice(0, 1200) } }
  } catch {
    const safeRaw = sanitizeDiagnosticText(redactSecret(trimmed.slice(0, 1200), apiKey))
    return { raw: safeRaw, value: { raw: safeRaw } }
  }
}

function serializeResponseValue(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value) ?? String(value)
}

async function readWithIdleTimeout(
  reader: ResponseReader,
  options: {
    signal?: AbortSignal
    abort?: (timedOut?: boolean) => void
    timedOut?: () => boolean
    providerLabel?: string
    idleTimeoutMs?: number
  },
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (options.signal?.aborted) {
    cancelReader(reader, 'response read aborted')
    return Promise.reject(requestAbortError(options.providerLabel ?? '模型', options.timedOut?.() === true))
  }

  const idleTimeoutMs = options.idleTimeoutMs
  const read = reader.read()
  if (!options.signal && (!idleTimeoutMs || idleTimeoutMs <= 0)) return read

  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let abortListener: (() => void) | undefined
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (abortListener && options.signal) options.signal.removeEventListener('abort', abortListener)
    }
    const resolveRead = (result: ReadableStreamReadResult<Uint8Array>) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const rejectRead = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    if (idleTimeoutMs && idleTimeoutMs > 0) {
      timer = setTimeout(() => {
        options.abort?.(true)
        cancelReader(reader, 'response read timeout')
        rejectRead(new ModelProviderError((options.providerLabel ?? '模型') + ' 响应读取超时。', { code: 'timeout', retryable: true }))
      }, idleTimeoutMs)
    }
    if (options.signal) {
      abortListener = () => {
        cancelReader(reader, 'response read aborted')
        rejectRead(requestAbortError(options.providerLabel ?? '模型', options.timedOut?.() === true))
      }
      options.signal.addEventListener('abort', abortListener, { once: true })
      if (options.signal.aborted) abortListener()
    }
    read.then(resolveRead, rejectRead)
  })
}

function normalizeResponseReadError(error: unknown, options: { signal?: AbortSignal; timedOut?: () => boolean; providerLabel?: string }) {
  if (error instanceof ModelProviderError) return error
  if (isAbortError(error) || options.signal?.aborted) {
    const timedOut = options.timedOut?.() === true
    return new ModelProviderError(
      timedOut ? (options.providerLabel ?? '模型') + ' 响应读取超时。' : (options.providerLabel ?? '模型') + ' 响应读取已取消。',
      { code: timedOut ? 'timeout' : 'aborted', retryable: timedOut },
    )
  }
  return new ModelProviderError(
    (options.providerLabel ?? '模型') + ' 响应读取失败：' + safeErrorMessage(error),
    { code: 'network_error', retryable: true },
  )
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError'
}

const TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_UNKNOWN',
  'ERR_TLS_INVALID_PROTOCOL_VERSION',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_PROTOCOL_ERROR',
])

const PERMANENT_DNS_ERROR_CODES = new Set(['ENOTFOUND', 'ENODATA', 'EAI_NODATA'])
const TEMPORARY_DNS_ERROR_CODES = new Set(['EAI_AGAIN', 'SERVFAIL', 'ESERVFAIL', 'ETIME'])

function requestErrorCode(error: unknown) {
  if (hasErrorCode(error, TLS_ERROR_CODES)) return 'tls_error'
  if (hasErrorCode(error, PERMANENT_DNS_ERROR_CODES) || hasErrorCode(error, TEMPORARY_DNS_ERROR_CODES)) return 'dns_error'
  return 'network_error'
}

function requestErrorRetryable(error: unknown) {
  return !hasErrorCode(error, TLS_ERROR_CODES) && !hasErrorCode(error, PERMANENT_DNS_ERROR_CODES)
}

function hasErrorCode(error: unknown, codes: ReadonlySet<string>, seen = new Set<object>()): boolean {
  if (!error || typeof error !== 'object' || seen.has(error)) return false
  seen.add(error)
  if ('code' in error && typeof error.code === 'string' && codes.has(error.code)) return true
  return 'cause' in error && hasErrorCode(error.cause, codes, seen)
}

function safeErrorMessage(error: unknown) {
  return sanitizeDiagnosticText(error instanceof Error ? error.message : String(error))
}

function sanitizeDiagnosticText(value: string) {
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, (character) => {
    const code = character.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000'
    return '\\u' + code
  })
}

export function httpErrorMessage(payload: Record<string, unknown>, apiKey: string) {
  return sanitizeDiagnosticText(redactSecret(providerErrorMessage(payload), apiKey))
}

function positiveNumber(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

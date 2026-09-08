export class RequestBodyTimeoutError extends Error {
  constructor() {
    super('请求体读取超时。')
    this.name = 'RequestBodyTimeoutError'
  }
}

const requestBodyIdleTimeoutMs = 15_000
const requestBodyTotalTimeoutMs = 60_000

export class RequestBodyTooLargeError extends Error {
  readonly status = 413

  constructor(readonly maxBytes: number) {
    super('请求体超过大小限制。')
    this.name = 'RequestBodyTooLargeError'
  }
}

async function readRequestText(request: Request, maxBytes: number): Promise<string> {
  const contentLength = request.headers.get('content-length')
  if (contentLength) {
    const parsed = Number(contentLength)
    if (Number.isFinite(parsed) && parsed > maxBytes) throw new RequestBodyTooLargeError(maxBytes)
  }
  if (!request.body) return ''

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  const deadline = Date.now() + requestBodyTotalTimeoutMs
  try {
    while (true) {
      const { done, value } = await readRequestChunk(reader, request.signal, deadline)
      if (done) break
      if (!value?.byteLength) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel('request body too large').catch(() => undefined)
        throw new RequestBodyTooLargeError(maxBytes)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

async function readRequestChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal, deadline: number): Promise<ReadableStreamReadResult<Uint8Array>> {
  const remaining = deadline - Date.now()
  if (signal.aborted || remaining <= 0) throw new RequestBodyTimeoutError()
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const rejectAndCancel = () => {
      cleanup()
      void reader.cancel('request body timeout').catch(() => undefined)
      reject(new RequestBodyTimeoutError())
    }
    const onAbort = () => rejectAndCancel()
    const timer = setTimeout(rejectAndCancel, Math.min(requestBodyIdleTimeoutMs, remaining))
    signal.addEventListener('abort', onAbort, { once: true })
    reader.read().then((result) => { cleanup(); resolve(result) }, (error) => { cleanup(); reject(error) })
  })
}

export async function readJsonBody<T>(request: Request, maxBytes: number): Promise<T | null> {
  const text = await readRequestText(request, maxBytes)
  if (!text.trim()) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

export async function readJsonBodyOrTooLarge<T>(request: Request, maxBytes: number): Promise<{ ok: true; body: T | null } | { ok: false; status: 408 | 413 }> {
  try {
    return { ok: true, body: await readJsonBody<T>(request, maxBytes) }
  } catch (error) {
    if (error instanceof RequestBodyTimeoutError) return { ok: false, status: 408 }
    if (error instanceof RequestBodyTooLargeError) return { ok: false, status: 413 }
    throw error
  }
}

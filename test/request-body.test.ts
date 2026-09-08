import assert from 'node:assert/strict'
import test from 'node:test'
import { readJsonBody, readJsonBodyOrTooLarge, RequestBodyTimeoutError, RequestBodyTooLargeError } from '../lib/http/request-body'

function requestFromStream(stream: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  return {
    headers: { get: () => null },
    body: stream,
    signal: signal ?? new AbortController().signal,
  } as unknown as Request
}

function countingStream(chunks: Uint8Array[], options?: { hang?: boolean }) {
  let cancelled = 0
  let released = 0
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      if (!options?.hang) controller.close()
    },
    cancel() {
      cancelled += 1
    },
  })
  const originalGetReader = stream.getReader.bind(stream)
  stream.getReader = ((...args: Parameters<ReadableStream<Uint8Array>['getReader']>) => {
    const reader = originalGetReader(...args)
    const originalRelease = reader.releaseLock.bind(reader)
    reader.releaseLock = () => {
      released += 1
      originalRelease()
    }
    return reader
  }) as ReadableStream<Uint8Array>['getReader']
  return { stream, counts: () => ({ cancelled, released }) }
}

test('request body concatenates offset views without sibling bytes', async () => {
  const backing = Buffer.from('NO{"ok":true}NO')
  const first = backing.subarray(2, 7)
  const second = backing.subarray(7, 13)
  const { stream, counts } = countingStream([first, second])
  const body = await readJsonBody<{ ok: boolean }>(requestFromStream(stream), 1024)
  assert.deepEqual(body, { ok: true })
  assert.equal(counts().cancelled, 0)
  assert.equal(counts().released, 1)
})

test('request body cancel and releaseLock once on abort', async () => {
  const abort = new AbortController()
  const { stream, counts } = countingStream([], { hang: true })
  const pending = readJsonBody(requestFromStream(stream, abort.signal), 1024)
  await new Promise((resolve) => setImmediate(resolve))
  abort.abort()
  await assert.rejects(pending, RequestBodyTimeoutError)
  assert.equal(counts().cancelled, 1)
  assert.equal(counts().released, 1)
})

test('request body cancel and releaseLock once on idle timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stream, counts } = countingStream([], { hang: true })
  const pending = readJsonBody(requestFromStream(stream), 1024)
  await Promise.resolve()
  t.mock.timers.tick(15_000)
  await assert.rejects(pending, RequestBodyTimeoutError)
  assert.equal(counts().cancelled, 1)
  assert.equal(counts().released, 1)
})

test('request body cancel and releaseLock once when over the size limit', async () => {
  const { stream, counts } = countingStream([Buffer.from('{"a":"' + 'x'.repeat(64) + '"}')], { hang: true })
  await assert.rejects(readJsonBody(requestFromStream(stream), 8), RequestBodyTooLargeError)
  assert.equal(counts().cancelled, 1)
  assert.equal(counts().released, 1)
  const tooLarge = await readJsonBodyOrTooLarge(requestFromStream(countingStream([Buffer.from('{"a":"' + 'x'.repeat(64) + '"}')], { hang: true }).stream), 8)
  assert.equal(tooLarge.ok, false)
})

function abortedJsonRequest() {
  const controller = new AbortController()
  controller.abort()
  return new Request('http://localhost/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '课题' }),
    signal: controller.signal,
  })
}

test('JSON body timeout throws instead of returning a successful null body', async () => {
  await assert.rejects(() => readJsonBody(abortedJsonRequest(), 1024), (error: unknown) => error instanceof RequestBodyTimeoutError)
  const wrapped = await readJsonBodyOrTooLarge(abortedJsonRequest(), 1024)
  assert.deepEqual(wrapped, { ok: false, status: 408 })
})

test('JSON body size limit is distinguishable from timeout', async () => {
  const request = new Request('http://localhost/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '4096' },
    body: '{"title":"课题"}',
  })
  await assert.rejects(() => readJsonBody(request, 16), (error: unknown) => error instanceof RequestBodyTooLargeError)
  const wrapped = await readJsonBodyOrTooLarge(new Request('http://localhost/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '4096' },
    body: '{"title":"课题"}',
  }), 16)
  assert.deepEqual(wrapped, { ok: false, status: 413 })
})

test('empty JSON body remains a successful null payload', async () => {
  const request = new Request('http://localhost/api', { method: 'POST', body: '' })
  assert.equal(await readJsonBody(request, 1024), null)
  assert.deepEqual(await readJsonBodyOrTooLarge(new Request('http://localhost/api', { method: 'POST', body: '' }), 1024), { ok: true, body: null })
})

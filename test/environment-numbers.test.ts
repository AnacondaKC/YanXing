import assert from 'node:assert/strict'
import test from 'node:test'
import { runtimeConfig } from '../lib/config/environment'

const original = { ...process.env }

test.afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in original)) delete process.env[key]
  }
  Object.assign(process.env, original)
})

test('count, byte and integer-ms configs reject fractional, negative and non-integer values', () => {
  process.env.REPORT_DOCX_PARSE_CONCURRENCY = '0.5'
  process.env.REPORT_MAX_UPLOAD_BYTES = '-1'
  process.env.KNOWLEDGE_UPLOAD_CONCURRENCY = 'Infinity'
  process.env.KNOWLEDGE_UPLOAD_IDLE_TIMEOUT_MS = 'NaN'
  process.env.REPORT_PDF_PARSE_TIMEOUT_MS = ''
  process.env.YANXING_MODEL_CALLS_PER_MINUTE = String(Number.MAX_SAFE_INTEGER + 1)
  process.env.YANXING_JOB_EVENTS_RETENTION_DAYS = '0.5'

  assert.equal(runtimeConfig.report.docxParseConcurrency, 2)
  assert.equal(runtimeConfig.report.maxUploadBytes, 25 * 1024 * 1024)
  assert.equal(runtimeConfig.knowledgeUpload.concurrency, 2)
  assert.equal(runtimeConfig.knowledgeUpload.idleTimeoutMs, 30_000)
  assert.equal(runtimeConfig.report.pdfParseTimeoutMs, 30_000)
  assert.equal(runtimeConfig.model.callsPerMinute, 30)
  assert.equal(runtimeConfig.jobEventsRetentionDays, 90)
})

test('values destined for Node timers must stay within the 32-bit setTimeout range', () => {
  process.env.REPORT_UPLOAD_TOTAL_TIMEOUT_MS = '2147483647'
  assert.equal(runtimeConfig.report.uploadTotalTimeoutMs, 2147483647)
  process.env.REPORT_UPLOAD_TOTAL_TIMEOUT_MS = '2147483648'
  assert.equal(runtimeConfig.report.uploadTotalTimeoutMs, 10 * 60_000)
  process.env.YANXING_WORKER_POLL_MS = '2147483648'
  assert.equal(runtimeConfig.worker.pollMs, 1_000)
})

test('session duration still accepts positive finite decimals', () => {
  process.env.YANXING_SESSION_HOURS = '0.5'
  assert.equal(runtimeConfig.sessionHours, 0.5)
  process.env.YANXING_SESSION_HOURS = '12.25'
  assert.equal(runtimeConfig.sessionHours, 12.25)
})

test('worker concurrency defaults to three when unset or blank', () => {
  delete process.env.YANXING_WORKER_CONCURRENCY
  assert.equal(runtimeConfig.worker.concurrency, 3)

  for (const value of ['', '   ']) {
    process.env.YANXING_WORKER_CONCURRENCY = value
    assert.equal(runtimeConfig.worker.concurrency, 3)
  }
})

test('worker concurrency accepts one through three tasks', () => {
  for (const concurrency of [1, 2, 3]) {
    process.env.YANXING_WORKER_CONCURRENCY = String(concurrency)
    assert.equal(runtimeConfig.worker.concurrency, concurrency)
  }
})

test('worker concurrency rejects out-of-range and non-integer values', () => {
  for (const value of ['0', '-1', '4', '1.5', 'NaN', 'Infinity', 'invalid']) {
    process.env.YANXING_WORKER_CONCURRENCY = value
    assert.throws(
      () => runtimeConfig.worker.concurrency,
      /YANXING_WORKER_CONCURRENCY 必须是 1-3 的整数。/,
      `Expected rejection for ${value}`,
    )
  }
})

test('valid integer overrides still apply', () => {
  process.env.REPORT_MAX_UPLOAD_BYTES = String(30 * 1024 * 1024)
  process.env.KNOWLEDGE_UPLOAD_CONCURRENCY = '3'
  process.env.YANXING_AI_GLOBAL_QUEUE_LIMIT = '8'
  assert.equal(runtimeConfig.report.maxUploadBytes, 30 * 1024 * 1024)
  assert.equal(runtimeConfig.knowledgeUpload.concurrency, 3)
  assert.equal(runtimeConfig.ai.globalQueueLimit, 8)
})

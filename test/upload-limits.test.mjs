import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getCloneableBody } from 'next/dist/server/body-streams.js'
import {
  knowledgeMaxUploadBytes,
  knowledgeMultipartOverheadBytes,
  parseReportMaxUploadBytes,
  reportMaxUploadBytes,
  resolveProxyClientMaxBodySize,
} from '../lib/upload-limits.mjs'
import { persistReportStream, ReportUploadError } from '../lib/documents/report-storage'

const mebibyte = 1024 * 1024
const defaultProxyLimit = resolveProxyClientMaxBodySize()
const configPath = fileURLToPath(new URL('../next.config.mjs', import.meta.url))

async function cloneBody(bytes, sizeLimit = defaultProxyLimit) {
  const payload = Buffer.alloc(bytes, 7)
  const readable = Readable.from([payload])
  readable.url = '/api/projects/demo/reports'
  const cloneable = getCloneableBody(readable, sizeLimit)
  const cloned = cloneable.cloneBodyStream()
  const chunks = []
  for await (const chunk of cloned) chunks.push(Buffer.from(chunk))
  return { sent: payload, received: Buffer.concat(chunks) }
}

test('proxy client max body size keeps a probe byte above the effective upload budget', () => {
  assert.equal(defaultProxyLimit, reportMaxUploadBytes + 1)
  assert.equal(knowledgeMaxUploadBytes + knowledgeMultipartOverheadBytes, 21 * mebibyte)
  assert.equal(parseReportMaxUploadBytes('0.5'), reportMaxUploadBytes)
  assert.equal(parseReportMaxUploadBytes('-1'), reportMaxUploadBytes)
  assert.equal(parseReportMaxUploadBytes('Infinity'), reportMaxUploadBytes)
  assert.equal(parseReportMaxUploadBytes('not-a-number'), reportMaxUploadBytes)
  assert.equal(parseReportMaxUploadBytes(''), reportMaxUploadBytes)
  assert.equal(parseReportMaxUploadBytes(String(30 * mebibyte)), 30 * mebibyte)
  assert.equal(resolveProxyClientMaxBodySize({ reportBytes: 9 * mebibyte }), 21 * mebibyte + 1)
})

test('next.config.mjs uses the shared proxy body size, including REPORT_MAX_UPLOAD_BYTES overrides', () => {
  const defaults = spawnSync(process.execPath, ['--input-type=module', '-e', "import config from " + JSON.stringify(configPath) + "; console.log(config.experimental.proxyClientMaxBodySize)"], { encoding: 'utf8' })
  assert.equal(defaults.status, 0, defaults.stderr)
  assert.equal(Number(defaults.stdout.trim()), defaultProxyLimit)

  const override = spawnSync(process.execPath, ['--input-type=module', '-e', "import config from " + JSON.stringify(configPath) + "; console.log(config.experimental.proxyClientMaxBodySize)"], {
    encoding: 'utf8',
    env: { ...process.env, REPORT_MAX_UPLOAD_BYTES: String(30 * mebibyte) },
  })
  assert.equal(override.status, 0, override.stderr)
  assert.equal(Number(override.stdout.trim()), 30 * mebibyte + 1)
})

test('Next body clone keeps 9/11/20/25MiB and the probe byte, truncating only beyond the configured cap', async () => {
  for (const bytes of [9 * mebibyte, 11 * mebibyte, 20 * mebibyte, 21 * mebibyte - 1, 21 * mebibyte + 1, 25 * mebibyte, 25 * mebibyte + 1]) {
    const { sent, received } = await cloneBody(bytes)
    assert.equal(received.length, sent.length)
    assert.equal(createHash('sha256').update(received).digest('hex'), createHash('sha256').update(sent).digest('hex'))
  }

  const overflow = await cloneBody(25 * mebibyte + 2)
  assert.ok(overflow.received.length <= defaultProxyLimit)
  assert.notEqual(overflow.received.length, overflow.sent.length)

  const noLength = Readable.from([Buffer.alloc(11 * mebibyte, 3)])
  const cloneable = getCloneableBody(noLength, defaultProxyLimit)
  const chunks = []
  for await (const chunk of cloneable.cloneBodyStream()) chunks.push(Buffer.from(chunk))
  assert.equal(Buffer.concat(chunks).length, 11 * mebibyte)
})

test('bodies that survive the proxy probe byte still fail the report upload limit', async () => {
  const { received } = await cloneBody(reportMaxUploadBytes + 1)
  assert.equal(received.length, reportMaxUploadBytes + 1)
  await assert.rejects(
    () => persistReportStream({
      reportId: 'rpt-overflow-probe',
      fileName: 'overflow.pdf',
      body: Readable.toWeb(Readable.from([received])),
      contentLength: received.length,
    }),
    (error) => error instanceof ReportUploadError && error.status === 413,
  )
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'

const directory = await mkdtemp(`${tmpdir()}/yanxing-proxy-unavail-`)
process.env.YANXING_DATABASE_PATH = path.join(directory, 'proxy-unavailable.sqlite')

const { getDatabase } = await import('../lib/db/client')
const { proxy } = await import('../proxy')

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

test('proxy maps an unavailable rate limiter to 503', () => {
  getDatabase().close()
  const response = proxy(new NextRequest('http://localhost/api/auth/login', { method: 'POST', headers: { host: 'localhost' } }))
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('Retry-After'), '5')
})

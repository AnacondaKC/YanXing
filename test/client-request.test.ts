import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchAllPages } from '../lib/client-request'

test('fetchAllPages follows canonical hasMore even when total matches the first page', async () => {
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://workspace.local')
    requests.push(url.search)
    const offset = Number(url.searchParams.get('offset'))
    if (offset === 0) {
      return new Response(JSON.stringify({ reports: [{ id: 'r1' }, { id: 'r2' }], total: 2, hasMore: true, limit: 2, offset: 0 }), { status: 200 })
    }
    return new Response(JSON.stringify({ reports: [{ id: 'r3' }], total: 3, hasMore: false, limit: 2, offset: 2 }), { status: 200 })
  }) as typeof fetch
  try {
    const result = await fetchAllPages<{ id: string }>('/api/reports', 'reports', { cache: 'no-store' }, 2)
    assert.deepEqual(result.items.map((item) => item.id), ['r1', 'r2', 'r3'])
    assert.equal(result.total, 3)
    assert.equal(requests.length, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchAllPages stops on hasMore false and honors abort', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ projects: [{ id: 'p1' }], total: 100, hasMore: false, limit: 1, offset: 0 }), { status: 200 })) as typeof fetch
  try {
    const result = await fetchAllPages<{ id: string }>('/api/projects', 'projects', { cache: 'no-store' }, 1)
    assert.deepEqual(result.items.map((item) => item.id), ['p1'])
  } finally {
    globalThis.fetch = originalFetch
  }
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => fetchAllPages('/api/projects', 'projects', { signal: controller.signal }), /aborted/i)
})

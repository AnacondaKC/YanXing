import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const directory = await mkdtemp(path.join(tmpdir(), 'yanxing-chat-endpoints-'))
const environment = process.env as Record<string, string | undefined>
const originalEnvironment = {
  NODE_ENV: environment.NODE_ENV,
  YANXING_DATABASE_PATH: environment.YANXING_DATABASE_PATH,
  YANXING_SETTINGS_ENCRYPTION_KEY: environment.YANXING_SETTINGS_ENCRYPTION_KEY,
}
environment.NODE_ENV = 'production'
environment.YANXING_DATABASE_PATH = path.join(directory, 'endpoints.sqlite')
environment.YANXING_SETTINGS_ENCRYPTION_KEY = 'endpoints-test-encryption-key'

const { createOrUpdateUser, createSession, sessionCookieName } = await import('../lib/auth/session')
const { getPublicAiModelSettings } = await import('../lib/db/settings-repository')
const { POST: fetchModels, PUT: saveChannel } = await import('../app/api/admin/ai-settings/route')
const { runStructuredJson, runText } = await import('../lib/ai/execute')

const admin = createOrUpdateUser({
  username: 'endpoints-admin',
  displayName: 'Endpoints administrator',
  password: 'endpoints-admin-test-password',
  role: 'admin',
})
const session = createSession(admin.id)

interface RecordedRequest {
  method?: string
  url?: string
  authorization?: string
  body: string
}

let server: Server
let origin: string
const requests: RecordedRequest[] = []

test.before(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      if (request.url?.startsWith('/redirect/')) {
        response.writeHead(307, { Location: request.url.replace('/redirect/', '/v1/') })
        response.end()
        return
      }
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/v1/models') {
        response.end(JSON.stringify({ data: [{ id: 'local-model' }, { id: ' local-model ' }] }))
        return
      }
      if (request.url === '/v1/chat/completions') {
        response.end(JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        }))
        return
      }
      response.writeHead(404)
      response.end(JSON.stringify({ error: 'Unknown endpoint' }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  origin = 'http://127.0.0.1:' + address.port
})

test.after(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }
  await rm(directory, { recursive: true, force: true })
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete environment[name]
    else environment[name] = value
  }
})

function settingsRequest(method: string, body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/admin/ai-settings', {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: sessionCookieName + '=' + encodeURIComponent(session.token),
    },
    body: JSON.stringify(body),
  })
}

test('production settings save arbitrary endpoints without DNS resolution or upstream requests', async (context) => {
  const fetchMock = context.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Saving settings must not contact the upstream service')
  })
  for (const baseUrl of [
    'https://cpa.luelue.vip/v1',
    'https://unresolved.invalid/v1',
    'http://localhost:11434/v1',
    'http://192.168.1.10:8080/v1',
    'http://[fd00::1]:8080/v1',
  ]) {
    const response = await saveChannel(settingsRequest('PUT', {
      action: 'save_channel',
      revision: getPublicAiModelSettings().revision,
      channel: {
        name: baseUrl,
        baseUrl: baseUrl + '/chat/completions/',
        apiKey: 'local-test-key',
        models: [{ modelName: 'local-model', maxContextCharacters: 120_000, maxOutputTokens: 4096, reasoningEffort: 'auto' }],
      },
    }))
    const body = await response.json() as { error?: string; settings?: { channels: { baseUrl: string }[] } }
    assert.equal(response.status, 200, body.error)
    assert.ok(body.settings?.channels.some((channel) => channel.baseUrl === baseUrl))
  }
  assert.equal(fetchMock.mock.callCount(), 0)
})

test('production model discovery reaches local HTTP endpoints and follows redirects', async () => {
  for (const prefix of ['/v1', '/redirect']) {
    const firstRequest = requests.length
    const response = await fetchModels(settingsRequest('POST', {
      action: 'fetch_models',
      baseUrl: origin + prefix + '/chat/completions/',
      apiKey: 'local-test-key',
    }))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { models: ['local-model'] })
    const received = requests.slice(firstRequest)
    assert.deepEqual(received.map((request) => request.url), prefix === '/v1'
      ? ['/v1/models']
      : ['/redirect/models', '/v1/models'])
    for (const request of received) {
      assert.equal(request.method, 'GET')
      assert.equal(request.authorization, 'Bearer local-test-key')
    }
  }
})

test('production structured and text calls reach local HTTP endpoints and preserve redirected POST bodies', async () => {
  for (const prefix of ['/v1', '/redirect']) {
    const firstRequest = requests.length
    const input = {
      model: { id: 'local-model', provider: 'chat_completions' as const, baseUrl: origin + prefix },
      apiKey: 'local-test-key',
      systemPrompt: 'Return the requested output.',
      prompt: 'Return an ok result.',
      timeoutMs: 2_000,
    }
    const structured = await runStructuredJson({
      ...input,
      output: { name: 'local_output', description: 'Return a result', schema: { type: 'object' } },
    })
    assert.deepEqual(structured.value, { ok: true })
    assert.equal(structured.usage.totalTokens, 5)
    const text = await runText({ ...input, outputLabel: 'local output' })
    assert.equal(text.content, '{"ok":true}')
    const received = requests.slice(firstRequest)
    assert.deepEqual(received.map((request) => request.url), prefix === '/v1'
      ? ['/v1/chat/completions', '/v1/chat/completions']
      : ['/redirect/chat/completions', '/v1/chat/completions', '/redirect/chat/completions', '/v1/chat/completions'])
    for (const request of received) {
      assert.equal(request.method, 'POST')
      assert.equal(request.authorization, 'Bearer local-test-key')
      assert.equal((JSON.parse(request.body) as { model: string }).model, 'local-model')
    }
    if (prefix === '/redirect') {
      assert.equal(received[0].body, received[1].body)
      assert.equal(received[2].body, received[3].body)
    }
  }
})

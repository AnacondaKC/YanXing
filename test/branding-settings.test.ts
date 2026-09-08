import assert from 'node:assert/strict'
import { validateHeaderValue } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DEFAULT_HEADER_LOGO_URL,
  DEFAULT_LOGIN_WATERMARK_URL,
  normalizeBrandDisplayText,
  type PublicBrandSettings,
} from '../lib/branding'

const directory = await mkdtemp(path.join(tmpdir(), 'yanxing-brand-settings-'))
process.env.YANXING_DATABASE_PATH = path.join(directory, 'branding.sqlite')

const { getDatabase } = await import('../lib/db/client')
const { createSession, sessionCookieName } = await import('../lib/auth/session')
const { getPublicBrandSettings, getStoredBrandAsset } = await import('../lib/db/brand-settings-repository')
const publicRoute = await import('../app/api/branding/route')
const assetRoute = await import('../app/api/branding/assets/[kind]/route')
const adminRoute = await import('../app/api/admin/branding/route')
const database = getDatabase()
const timestamp = new Date().toISOString()
for (const [id, role] of [['brand-admin', 'admin'], ['brand-researcher', 'researcher']]) {
  database.prepare('INSERT INTO users(id, username, display_name, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, id, id, 'unused', role, 'active', timestamp, timestamp)
}
const adminToken = createSession('brand-admin').token
const researcherToken = createSession('brand-researcher').token
const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function adminRequest(input: { body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
  return new Request('http://localhost/api/admin/branding', {
    method: input.body === undefined ? 'GET' : 'PUT',
    headers: { ...(input.token ? { cookie: sessionCookieName + '=' + input.token } : {}), ...input.headers },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  })
}

async function readSettings(response: Response) {
  const body = await response.json() as { settings: PublicBrandSettings }
  return body.settings
}

test('default brand image URLs are safe for HTTP preload headers', () => {
  for (const url of [DEFAULT_HEADER_LOGO_URL, DEFAULT_LOGIN_WATERMARK_URL]) {
    assert.doesNotThrow(() => validateHeaderValue('Link', '<' + url + '>; rel=preload; as=image'))
    assert.equal(decodeURI(url), '/研行LOGO-完整矢量平滑版.svg')
    assert.equal(new URL(url, 'http://localhost').pathname, url)
  }
})

test('brand display text normalization enforces non-empty text and two lines', () => {
  assert.equal(normalizeBrandDisplayText(' 研行产业政策 \r\n 研究团队 '), '研行产业政策\n研究团队')
  assert.equal(normalizeBrandDisplayText('第一行\n\n第二行'), '第一行\n第二行')
  assert.equal(normalizeBrandDisplayText('第一行\n第二行\n第三行'), null)
  assert.equal(normalizeBrandDisplayText(' '.repeat(20)), null)
  assert.equal(normalizeBrandDisplayText('字'.repeat(61)), null)
})

test('public branding starts with generic defaults and does not require authentication', async () => {
  assert.deepEqual(getPublicBrandSettings(), {
    displayText: '研行致远\n产业政策研究团队',
    headerLogoUrl: DEFAULT_HEADER_LOGO_URL,
    loginWatermarkUrl: DEFAULT_LOGIN_WATERMARK_URL,
    revision: 1,
    updatedAt: null,
    updatedBy: null,
  })
  const response = publicRoute.GET(new Request('http://localhost/api/branding'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('etag'), '"branding-1"')
  assert.equal((await readSettings(response)).displayText, '研行致远\n产业政策研究团队')
})

test('admin branding API requires administrators and validates revisions and images', async () => {
  assert.equal(adminRoute.GET(adminRequest()).status, 401)
  assert.equal(adminRoute.GET(adminRequest({ token: researcherToken })).status, 403)
  assert.equal((await adminRoute.PUT(adminRequest({ token: researcherToken, body: { revision: 1, settings: { displayText: '研究团队' } } }))).status, 403)
  assert.equal((await adminRoute.PUT(adminRequest({ token: adminToken, body: { settings: { displayText: '研究团队' } } }))).status, 428)
  assert.equal((await adminRoute.PUT(adminRequest({ token: adminToken, body: { revision: 1, settings: { displayText: '' } } }))).status, 400)
  assert.equal((await adminRoute.PUT(adminRequest({
    token: adminToken,
    body: { revision: 1, settings: { displayText: '研究团队', headerLogo: { mimeType: 'image/png', dataBase64: Buffer.from('not-png').toString('base64') } } },
  }))).status, 400)
  assert.equal(getPublicBrandSettings().revision, 1)
})

test('saving updates all brand surfaces, serves assets, handles conflicts, and resets defaults', async () => {
  const image = { mimeType: 'image/png', dataBase64: onePixelPng.toString('base64') }
  const first = await adminRoute.PUT(adminRequest({
    token: adminToken,
    body: { revision: 1, settings: { displayText: '研行产业政策\n研究团队', headerLogo: image, loginWatermark: image } },
  }))
  assert.equal(first.status, 200)
  const saved = await readSettings(first)
  assert.equal(saved.revision, 2)
  assert.equal(saved.displayText, '研行产业政策\n研究团队')
  assert.match(saved.headerLogoUrl, /^\/api\/branding\/assets\/header-logo\?v=2$/)
  assert.match(saved.loginWatermarkUrl, /^\/api\/branding\/assets\/login-watermark\?v=2$/)

  const asset = await assetRoute.GET(
    new Request('http://localhost' + saved.headerLogoUrl),
    { params: Promise.resolve({ kind: 'header-logo' }) },
  )
  assert.equal(asset.status, 200)
  assert.equal(asset.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await asset.arrayBuffer()), onePixelPng)
  assert.ok(getStoredBrandAsset('login-watermark'))

  const stale = await adminRoute.PUT(adminRequest({
    token: adminToken,
    body: { revision: 1, settings: { displayText: '过期草稿' } },
  }))
  assert.equal(stale.status, 409)
  assert.equal(getPublicBrandSettings().displayText, saved.displayText)

  const reset = await adminRoute.PUT(adminRequest({
    token: adminToken,
    body: { revision: 2, settings: { displayText: '研行致远\n产业政策研究团队', headerLogo: null, loginWatermark: null } },
  }))
  assert.equal(reset.status, 200)
  const defaults = await readSettings(reset)
  assert.equal(defaults.revision, 3)
  assert.equal(defaults.headerLogoUrl, DEFAULT_HEADER_LOGO_URL)
  assert.equal(defaults.loginWatermarkUrl, DEFAULT_LOGIN_WATERMARK_URL)
  assert.equal(getStoredBrandAsset('header-logo'), null)
})

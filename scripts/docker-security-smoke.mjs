import assert from 'node:assert/strict'
import { accessSync, constants, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout } from 'node:timers/promises'

const writableDirectories = new Set(['/app/storage', '/app/.next/cache'])
const baseUrl = 'http://127.0.0.1:3000'

function assertProtectedCode(entry) {
  if (writableDirectories.has(entry)) return
  const stat = lstatSync(entry)
  assert.equal(stat.uid, 0, entry + ' must be root-owned')
  assert.throws(() => accessSync(entry, constants.W_OK), { code: 'EACCES' }, entry + ' must not be writable')
  if (stat.isDirectory()) {
    for (const child of readdirSync(entry)) assertProtectedCode(path.join(entry, child))
  }
}

function assertRuntimePermissions() {
  assert.notEqual(process.getuid(), 0)
  assertProtectedCode('/app')
  for (const directory of writableDirectories) {
    assert.equal(statSync(directory).uid, process.getuid(), directory)
    assert.equal(statSync(directory).mode & 0o777, 0o700, directory)
  }
  for (const directory of [...writableDirectories, '/tmp']) {
    const temporary = mkdtempSync(path.join(directory, '.permission-check-'))
    try { writeFileSync(path.join(temporary, 'probe'), 'ok') }
    finally { rmSync(temporary, { recursive: true, force: true }) }
  }
  console.log('[docker-security-smoke] code protected; data/cache/tmp writable')
}

async function request(route) {
  return fetch(baseUrl + route, { signal: AbortSignal.timeout(10_000) })
}

async function assertBrandingFallback(database) {
  const original = database.prepare('SELECT display_text FROM brand_settings WHERE id = 1').get()
  const response = await request('/api/branding')
  assert.equal(response.status, 200)
  const { settings } = await response.json()
  try {
    database.prepare('UPDATE brand_settings SET display_text = ? WHERE id = 1').run('一\n二\n三')
    assert.equal((await request('/api/branding')).status, 500)
    const login = await request('/login')
    assert.equal(login.status, 200)
    const html = await login.text()
    assert.ok(html.includes('id="login-username"'), 'login must still render when branding is invalid')
    assert.ok(html.includes(settings.headerLogoUrl), 'login must retain default branding')
  } finally {
    database.prepare('UPDATE brand_settings SET display_text = ? WHERE id = 1').run(original.display_text)
  }
  assert.equal((await request('/api/branding')).status, 200)
  console.log('[docker-security-smoke] invalid branding preserves login and strict API errors')
}

async function assertImageCacheWritable(database) {
  const original = database.prepare('SELECT header_logo, header_logo_mime FROM brand_settings WHERE id = 1').get()
  const sharp = createRequire(import.meta.resolve('next/package.json'))('sharp')
  const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } }).png().toBuffer()
  try {
    database.prepare('UPDATE brand_settings SET header_logo = ?, header_logo_mime = ? WHERE id = 1').run(image, 'image/png')
    const asset = '/api/branding/assets/header-logo'
    const response = await request('/_next/image?url=' + encodeURIComponent(asset) + '&w=64&q=75')
    assert.equal(response.status, 200, await response.clone().text())
    assert.match(response.headers.get('content-type') ?? '', /^image\//)
    assert.ok((await response.arrayBuffer()).byteLength > 0)
    await assertImageCachePopulated()
  } finally {
    database.prepare('UPDATE brand_settings SET header_logo = ?, header_logo_mime = ? WHERE id = 1')
      .run(original.header_logo, original.header_logo_mime)
  }
  console.log('[docker-security-smoke] Next image optimizer writes cache with protected server code')
}

async function assertImageCachePopulated() {
  const directory = '/app/.next/cache/images'
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (existsSync(directory) && readdirSync(directory, { recursive: true, withFileTypes: true }).some((entry) => entry.isFile())) return
    await setTimeout(50)
  }
  assert.fail('Next image cache was not written')
}

if (process.env.YANXING_SMOKE_ALLOW_MUTATIONS !== 'true') {
  throw new Error('Run only through the isolated Docker smoke project with YANXING_SMOKE_ALLOW_MUTATIONS=true')
}
assertRuntimePermissions()
const database = new DatabaseSync(process.env.YANXING_DATABASE_PATH)
try {
  await assertBrandingFallback(database)
  await assertImageCacheWritable(database)
} finally {
  database.close()
}

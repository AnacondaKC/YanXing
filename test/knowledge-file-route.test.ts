import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { NextRequest } from 'next/server'

const directory = await mkdtemp(path.join(tmpdir(), 'yanxing-knowledge-file-'))
const knowledgeRoot = path.join(directory, 'knowledge')
process.env.YANXING_DATABASE_PATH = path.join(directory, 'knowledge-file.sqlite')
process.env.YANXING_KNOWLEDGE_STORAGE_ROOT = knowledgeRoot
process.env.YANXING_SETTINGS_ENCRYPTION_KEY = 'knowledge-file-encryption-key'

const { createOrUpdateUser, createSession, deleteSession, sessionCookieName } = await import('../lib/auth/session')
const { getDatabase } = await import('../lib/db/client')
const { createKnowledgeItem } = await import('../lib/db/knowledge-repository')
const { GET: knowledgeFile } = await import('../app/api/knowledge/[knowledgeId]/file/route')

await mkdir(knowledgeRoot, { recursive: true })

const owner = createOrUpdateUser({ username: 'knowledge-file-owner', displayName: '知识库上传者', password: 'password-file-123', role: 'researcher' })
const outsider = createOrUpdateUser({ username: 'knowledge-file-reader', displayName: '其他登录用户', password: 'password-file-123', role: 'researcher' })

test.after(async () => {
  try { getDatabase().close() } catch { /* already closed */ }
  await rm(directory, { recursive: true, force: true })
})

function cookie(token: string) {
  return sessionCookieName + '=' + encodeURIComponent(token)
}

function fileRequest(knowledgeId: string, token?: string) {
  return knowledgeFile(new NextRequest('http://localhost/api/knowledge/' + knowledgeId + '/file', {
    headers: token ? { cookie: cookie(token) } : {},
  }), { params: Promise.resolve({ knowledgeId }) })
}

async function insertItem(input: { id?: string; fileName?: string; sourcePath: string; fileSize?: number }) {
  const id = input.id ?? 'knowledge-' + randomUUID()
  createKnowledgeItem({
    id,
    title: '知识库文件',
    fileName: input.fileName ?? '报告.pdf',
    fileSize: input.fileSize ?? 13,
    category: '行业研报',
    description: '',
    tags: [],
    sourcePath: input.sourcePath,
    fileHash: id.replace(/-/g, '').padEnd(64, 'a').slice(0, 64),
    uploadedBy: owner.displayName,
    uploadedByUserId: owner.id,
  })
  return id
}

test.describe('knowledge file route', { concurrency: false }, () => {
test('unauthenticated and missing knowledge files are 401 and 404', async () => {
  const unauthenticated = await fileRequest('missing')
  assert.equal(unauthenticated.status, 401)
  assert.equal(((await unauthenticated.json()) as { error?: string }).error, '未登录。')

  const missing = await fileRequest('missing', createSession(owner.id).token)
  assert.equal(missing.status, 404)
  assert.equal(((await missing.json()) as { error?: string }).error, '文件不存在。')
})

test('paths outside the storage root and missing or directory targets are 404', async () => {
  const secretPath = path.join(directory, 'secret.pdf')
  const secret = Buffer.from('%PDF-1.4 outside')
  await writeFile(secretPath, secret)
  const token = createSession(owner.id).token

  const outsideId = await insertItem({ sourcePath: secretPath, fileSize: secret.length })
  const outside = await fileRequest(outsideId, token)
  assert.equal(outside.status, 404)
  assert.notEqual(Buffer.from(await outside.arrayBuffer()).toString(), secret.toString())

  const missingId = await insertItem({ sourcePath: path.join(knowledgeRoot, 'missing-id', 'source.pdf') })
  const missing = await fileRequest(missingId, token)
  assert.equal(missing.status, 404)
  assert.equal(((await missing.json()) as { error?: string }).error, '文件不存在。')

  const dirId = 'knowledge-dir'
  const dirPath = path.join(knowledgeRoot, dirId)
  await mkdir(dirPath, { recursive: true })
  await insertItem({ id: dirId, sourcePath: dirPath })
  const directoryResponse = await fileRequest(dirId, token)
  assert.equal(directoryResponse.status, 404)
})

test('leaf and parent symlinks cannot serve files outside the storage root', async () => {
  const token = createSession(owner.id).token
  const leaked = 'LEAKED-SECRET'
  const secretPath = path.join(directory, 'leaked.txt')
  await writeFile(secretPath, leaked)

  const leafId = 'knowledge-leaf-link'
  const leafDir = path.join(knowledgeRoot, leafId)
  await mkdir(leafDir, { recursive: true })
  const leafPath = path.join(leafDir, 'source.pdf')
  await symlink(secretPath, leafPath)
  await insertItem({ id: leafId, sourcePath: leafPath, fileName: 'a.pdf', fileSize: leaked.length })
  const leaf = await fileRequest(leafId, token)
  assert.equal(leaf.status, 404)
  assert.notEqual(Buffer.from(await leaf.arrayBuffer()).toString(), leaked)

  const parentId = 'knowledge-parent-link'
  const outsideDir = path.join(directory, 'outside-parent')
  await mkdir(outsideDir, { recursive: true })
  await writeFile(path.join(outsideDir, 'source.pdf'), leaked)
  await symlink(outsideDir, path.join(knowledgeRoot, parentId))
  await insertItem({ id: parentId, sourcePath: path.join(knowledgeRoot, parentId, 'source.pdf'), fileSize: leaked.length })
  const parent = await fileRequest(parentId, token)
  assert.equal(parent.status, 404)
  assert.notEqual(Buffer.from(await parent.arrayBuffer()).toString(), leaked)
})

test('any logged-in user receives disk bytes and download headers, revoked sessions do not', async () => {
  const id = 'knowledge-bytes'
  const itemDir = path.join(knowledgeRoot, id)
  await mkdir(itemDir, { recursive: true })
  const bytes = Buffer.from('%PDF-1.4\nfixture-bytes\n%%EOF')
  const sourcePath = path.join(itemDir, 'source.pdf')
  await writeFile(sourcePath, bytes)
  await insertItem({ id, sourcePath, fileName: '阶段报告.pdf', fileSize: 9999 })

  const reader = createSession(outsider.id)
  const response = await fileRequest(id, reader.token)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Content-Type'), 'application/pdf')
  assert.equal(response.headers.get('Content-Length'), String(bytes.length))
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.match(response.headers.get('Content-Disposition') ?? '', /^attachment; filename\*=UTF-8''/)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)

  deleteSession(reader.token)
  const revoked = await fileRequest(id, reader.token)
  assert.equal(revoked.status, 401)
})
})

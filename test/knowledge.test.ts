import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'

const directory = await mkdtemp(tmpdir() + '/yanxing-knowledge-')
const storageRoot = path.join(directory, 'knowledge')
process.env.YANXING_DATABASE_PATH = path.join(directory, 'knowledge-test.sqlite')
process.env.YANXING_KNOWLEDGE_STORAGE_ROOT = storageRoot

const { createOrUpdateUser, createSession, sessionCookieName } = await import('../lib/auth/session')
const { getKnowledgeItem } = await import('../lib/db/repository')
const { GET: listKnowledge, POST: uploadKnowledge } = await import('../app/api/knowledge/route')
const { DELETE: deleteKnowledge } = await import('../app/api/knowledge/[knowledgeId]/route')

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function request(url: string, token: string, init: ConstructorParameters<typeof NextRequest>[1] = {}) {
  return new NextRequest(url, {
    ...init,
    headers: { ...init.headers, cookie: sessionCookieName + '=' + encodeURIComponent(token) },
  })
}

function pdfFile(name: string, size = 16) {
  return new File([Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(Math.max(0, size - 9)), Buffer.from('%%EOF')])], name, { type: 'application/pdf' })
}

async function streamingMultipart(file: File, title: string) {
  const boundary = '----yanxing-streaming-test'
  const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`
  const titleField = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n${title}\r\n--${boundary}--\r\n`
  const payload = Buffer.concat([Buffer.from(fileHeader), Buffer.from(await file.arrayBuffer()), Buffer.from(titleField)])
  let offset = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= payload.length) {
        controller.close()
        return
      }
      const nextOffset = Math.min(payload.length, offset + 3)
      controller.enqueue(payload.subarray(offset, nextOffset))
      offset = nextOffset
    },
  })
  return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}

test('knowledge upload owns stored paths, bounds files, and hides internals', async () => {
  const uploader = createOrUpdateUser({ username: 'knowledge-uploader', displayName: '上传者', password: 'password-uploader-123', role: 'researcher' })
  const token = createSession(uploader.id).token
  const multipart = await streamingMultipart(pdfFile('../outside.pdf'), '越界文件名')
  const upload = await uploadKnowledge(request('http://localhost/api/knowledge', token, {
    method: 'POST',
    body: multipart.body,
    headers: { 'content-type': multipart.contentType },
  }))
  const body = await upload.json() as { item?: Record<string, unknown> }
  assert.equal(upload.status, 201)
  assert.equal('sourcePath' in (body.item ?? {}), false)
  assert.equal('fileHash' in (body.item ?? {}), false)
  assert.equal(body.item?.canDelete, true)

  const item = getKnowledgeItem(String(body.item?.id))
  assert.ok(item)
  assert.equal(item?.fileName, 'outside.pdf')
  assert.equal(item?.sourcePath, path.join(storageRoot, String(body.item?.id), 'source.pdf'))
  assert.equal(item?.uploadedByUserId, uploader.id)

  const list = await listKnowledge(request('http://localhost/api/knowledge', token))
  const listBody = await list.json() as { items: Array<Record<string, unknown>> }
  assert.equal('sourcePath' in listBody.items[0], false)
  assert.equal('fileHash' in listBody.items[0], false)

  const invalid = new FormData()
  invalid.set('file', new File(['plain text'], 'notes.txt', { type: 'text/plain' }))
  const invalidResponse = await uploadKnowledge(request('http://localhost/api/knowledge', token, { method: 'POST', body: invalid }))
  assert.equal(invalidResponse.status, 415)

  const oversized = new FormData()
  oversized.set('file', pdfFile('large.pdf', 20 * 1024 * 1024 + 1))
  const oversizedResponse = await uploadKnowledge(request('http://localhost/api/knowledge', token, { method: 'POST', body: oversized }))
  assert.equal(oversizedResponse.status, 413)
  assert.equal((await readdir(storageRoot)).length, 1)
})

test('knowledge deletion permits only uploader or administrator', async () => {
  const uploader = createOrUpdateUser({ username: 'knowledge-owner', displayName: '所有者', password: 'password-owner-123', role: 'researcher' })
  const outsider = createOrUpdateUser({ username: 'knowledge-outsider', displayName: '其他用户', password: 'password-outsider-123', role: 'researcher' })
  const admin = createOrUpdateUser({ username: 'knowledge-admin', displayName: '管理员', password: 'password-admin-123', role: 'admin' })
  const uploadForm = new FormData()
  uploadForm.set('file', pdfFile('delete.pdf'))
  const uploaded = await uploadKnowledge(request('http://localhost/api/knowledge', createSession(uploader.id).token, { method: 'POST', body: uploadForm }))
  const uploadedBody = await uploaded.json() as { item: { id: string } }
  const context = { params: Promise.resolve({ knowledgeId: uploadedBody.item.id }) }
  const itemUrl = 'http://localhost/api/knowledge/' + uploadedBody.item.id

  assert.equal((await deleteKnowledge(request(itemUrl, createSession(outsider.id).token, { method: 'DELETE' }), context)).status, 403)
  assert.equal((await deleteKnowledge(request(itemUrl, createSession(admin.id).token, { method: 'DELETE' }), context)).status, 200)
  assert.equal(getKnowledgeItem(uploadedBody.item.id), undefined)
})

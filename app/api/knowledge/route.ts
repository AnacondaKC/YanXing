import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { getKnowledgeStorageRoot } from '@/lib/knowledge-storage'
import { getRequestSession } from '@/lib/auth/request'
import { checkRateLimit } from '@/lib/security/rate-limit'
import { rateLimitFailure } from '@/lib/http/rate-limit-response'
import { pageResult, parsePagination, paginationRangeFailure } from '@/lib/http/pagination'
import { countKnowledgeItems, createKnowledgeItem, listKnowledgeItems, ReportAuthorizationChangedError } from '@/lib/db/repository'
import { releaseStorageReservation, reserveStorageQuota, StorageQuotaError } from '@/lib/storage/quota'
import {
  fieldLimits,
  listRateLimit,
  maxConcurrentUploads,
  maxFileBytes,
  maxMultipartBytes,
  normalizeUploadError,
  parseContentLength,
  parseStreamingMultipart,
  throwIfUploadAborted,
  toPublicItem,
  UploadError,
  uploadRateLimit,
  uploadState,
  validateFileContent,
} from '@/lib/documents/knowledge-upload'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const session = getRequestSession(request)
  if (!session) return NextResponse.json({ error: '未登录。' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const category = searchParams.get('category') || undefined
  const decision = checkRateLimit(`knowledge-list:${session.user.id}`, listRateLimit)
  const limited = rateLimitFailure(decision, { error: '知识库访问过于频繁，请稍后再试。' })
  if (limited) return NextResponse.json(limited.body, { status: limited.status, headers: limited.headers })
  try {
    const pagination = parsePagination(request, { limit: 100, maxLimit: 100 })
    const result = pageResult(
      listKnowledgeItems(category, pagination).map((item) => toPublicItem(item, session.user)),
      countKnowledgeItems(category),
      pagination,
    )
    return NextResponse.json({ items: result.items, total: result.total, limit: result.limit, offset: result.offset, hasMore: result.hasMore })
  } catch (error) {
    const failure = paginationRangeFailure(error)
    if (failure) return NextResponse.json({ error: failure.error }, { status: failure.status })
    console.error('[knowledge] 列表读取失败', error)
    return NextResponse.json({ error: '获取知识库列表失败。' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const session = getRequestSession(request)
  if (!session) return NextResponse.json({ error: '未登录。' }, { status: 401 })

  const decision = checkRateLimit(`knowledge-upload:${session.user.id}`, uploadRateLimit)
  const limited = rateLimitFailure(decision, { error: '上传请求过于频繁，请稍后再试。' })
  if (limited) return NextResponse.json(limited.body, { status: limited.status, headers: limited.headers })

  let contentLength: number | undefined
  try {
    contentLength = parseContentLength(request.headers.get('content-length'))
  } catch (error) {
    if (error instanceof UploadError) return NextResponse.json({ error: error.message }, { status: error.status })
    throw error
  }
  if (contentLength !== undefined && contentLength > maxMultipartBytes) {
    return NextResponse.json({ error: '上传请求过大。' }, { status: 413 })
  }
  if (request.signal.aborted) return NextResponse.json({ error: '上传已取消。' }, { status: 408 })

  if (uploadState.active >= maxConcurrentUploads) {
    return NextResponse.json({ error: '当前上传任务较多，请稍后再试。' }, { status: 503, headers: { 'Retry-After': '2' } })
  }
  uploadState.active += 1
  let itemDirectory: string | undefined
  let itemDirectoryCreated = false
  let storageReservationId: string | undefined
  let committed = false
  try {
    throwIfUploadAborted(request.signal)
    const id = `kb-${randomUUID()}`
    const storageRoot = getKnowledgeStorageRoot()
    itemDirectory = join(storageRoot, id)
    // 先锁定最坏情况的文件预算，再开始向受管目录写入，避免并发上传绕过配额。
    storageReservationId = reserveStorageQuota({ userId: session.user.id, expectedBytes: maxFileBytes, ownerType: 'knowledge' })
    await mkdir(storageRoot, { recursive: true, mode: 0o700 })
    await mkdir(itemDirectory, { recursive: false, mode: 0o700 })
    itemDirectoryCreated = true
    const upload = await parseStreamingMultipart(request, itemDirectory)
    throwIfUploadAborted(request.signal)
    const { fileName, extension, sourcePath, streamedFile } = upload
    if (streamedFile.bytes <= 0) throw new UploadError(400, '上传文件不能为空。')
    if (streamedFile.bytes > maxFileBytes) throw new UploadError(413, '文件大小不能超过 20 MB。')
    validateFileContent(extension, streamedFile.firstBytes, streamedFile.lastBytes)

    const titleInput = upload.fields.get('title')?.trim() ?? ''
    const title = titleInput || fileName.replace(/\.[^/.]+$/, '')
    const categoryInput = upload.fields.get('category')?.trim() ?? ''
    const category = categoryInput || '行业研报'
    const description = upload.fields.get('description')?.trim() ?? ''
    if (title.length > fieldLimits.title) throw new UploadError(400, `标题不能超过 ${fieldLimits.title} 个字。`)
    if (category.length > fieldLimits.category) throw new UploadError(400, `分类不能超过 ${fieldLimits.category} 个字。`)
    if (description.length > fieldLimits.description) throw new UploadError(400, `简介不能超过 ${fieldLimits.description} 个字。`)
    const tagsInput = upload.fields.get('tags')?.trim() ?? ''
    let tags: string[] = []
    if (tagsInput) {
      try {
        const parsed = JSON.parse(tagsInput)
        if (Array.isArray(parsed)) tags = parsed.map(String)
      } catch {
        tags = tagsInput.split(/[,，\s]+/).filter(Boolean)
      }
      tags = tags.map((tag) => tag.trim()).filter(Boolean).slice(0, fieldLimits.tags)
      if (tags.some((tag) => tag.length > fieldLimits.tagLength)) {
        throw new UploadError(400, `单个标签不能超过 ${fieldLimits.tagLength} 个字。`)
      }
    }

    throwIfUploadAborted(request.signal)
    const item = createKnowledgeItem({
      id,
      title,
      fileName,
      fileSize: streamedFile.bytes,
      category,
      description,
      tags,
      sourcePath,
      fileHash: streamedFile.hash,
      uploadedBy: session.user.displayName || session.user.username,
      uploadedByUserId: session.user.id,
    }, session.user, storageReservationId)
    committed = true
    return NextResponse.json({ item: toPublicItem(item, session.user) }, { status: 201 })
  } catch (error) {
    if (itemDirectory && itemDirectoryCreated && !committed) await rm(itemDirectory, { recursive: true, force: true }).catch(() => undefined)
    if (storageReservationId && !committed) {
      try {
        releaseStorageReservation(storageReservationId)
      } catch (cleanupError) {
        console.error('[knowledge] 存储预留清理失败', cleanupError)
      }
    }
    const normalizedError = request.signal.aborted && !committed
      ? new UploadError(408, '上传已取消。', { cause: error })
      : normalizeUploadError(error)
    if (normalizedError instanceof StorageQuotaError) {
      return NextResponse.json({ error: normalizedError.message }, { status: 507, headers: { 'Retry-After': '30' } })
    }
    if (normalizedError instanceof ReportAuthorizationChangedError) {
      return NextResponse.json({ error: normalizedError.message }, { status: 403 })
    }
    if (normalizedError instanceof UploadError) {
      return NextResponse.json({ error: normalizedError.message }, { status: normalizedError.status })
    }
    console.error('[knowledge] 上传失败', normalizedError)
    return NextResponse.json({ error: '上传研报失败，请稍后重试。' }, { status: 500 })
  } finally {
    uploadState.active = Math.max(0, uploadState.active - 1)
  }
}

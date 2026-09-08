import { NextRequest, NextResponse } from 'next/server'
import { getRequestSession } from '@/lib/auth/request'
import { getKnowledgeItem } from '@/lib/db/repository'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { extname } from 'node:path'
import { contentDispositionHeader } from '@/lib/documents/content-disposition'
import { isManagedKnowledgePath } from '@/lib/knowledge-storage'
import { checkRateLimit } from '@/lib/security/rate-limit'
import { rateLimitFailure } from '@/lib/http/rate-limit-response'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ knowledgeId: string }> },
) {
  const session = getRequestSession(request)
  if (!session) return NextResponse.json({ error: '未登录。' }, { status: 401 })

  const { knowledgeId } = await params
  const item = getKnowledgeItem(knowledgeId)
  if (!item || !isManagedKnowledgePath(item.sourcePath)) return NextResponse.json({ error: '文件不存在。' }, { status: 404 })
  const decision = checkRateLimit(`knowledge-download:${session.user.id}`, { limit: 120, windowMs: 15 * 60 * 1000 })
  const limited = rateLimitFailure(decision, { error: '文件下载过于频繁，请稍后再试。' })
  if (limited) return NextResponse.json(limited.body, { status: limited.status, headers: limited.headers })

  try {
    // Content-Length 取磁盘实际大小：DB 记录与文件不一致时避免响应截断。
    const fileStat = await stat(item.sourcePath)
    if (!fileStat.isFile()) return NextResponse.json({ error: '文件不存在。' }, { status: 404 })
    const stream = Readable.toWeb(createReadStream(item.sourcePath)) as ReadableStream<Uint8Array>
    const ext = extname(item.fileName).toLowerCase()
    const contentType = ext === '.pdf'
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    return new Response(stream, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': contentDispositionHeader(item.fileName, true),
        'Content-Length': fileStat.size.toString(),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return NextResponse.json({ error: '读取文件失败。' }, { status: 500 })
  }
}

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isPathWithinRoot } from '@/lib/storage/path-containment'
import { Readable } from 'node:stream'
import { NextResponse } from 'next/server'
import { getRequestUser } from '@/lib/auth/request'
import { getReport, getReportSource } from '@/lib/db/repository'
import { checkRateLimit } from '@/lib/security/rate-limit'
import { rateLimitFailure } from '@/lib/http/rate-limit-response'
import { resolveByteRange } from '@/lib/documents/byte-range'
import { contentDispositionHeader } from '@/lib/documents/content-disposition'
import { reportStorageRoot } from '@/lib/documents/report-storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  context: { params: Promise<{ reportId: string }> },
) {
  return serveReportFile(request, context, true)
}

export async function HEAD(
  request: Request,
  context: { params: Promise<{ reportId: string }> },
) {
  return serveReportFile(request, context, false)
}

async function serveReportFile(
  request: Request,
  context: { params: Promise<{ reportId: string }> },
  includeBody: boolean,
) {
  try {
    const { reportId } = await context.params
    const user = getRequestUser(request)
    if (!user) return NextResponse.json({ error: '未登录。' }, { status: 401 })

    const report = getReport(reportId)
    if (!report) {
      return NextResponse.json({ error: '报告版本不存在。' }, { status: 404 })
    }
    // 下载限流：DOCX 预览会发起多次 Range 请求，阈值需覆盖单次预览的正常用量。
    const downloadDecision = checkRateLimit(`report-file:${user.id}`, { limit: 240, windowMs: 60 * 1000 })
    const limited = rateLimitFailure(downloadDecision, { error: '下载过于频繁，请稍后再试。' })
    if (limited) return NextResponse.json(limited.body, { status: limited.status, headers: limited.headers })
    const source = getReportSource(report.id)
    if (!source) return NextResponse.json({ error: '报告源文件不存在。' }, { status: 404 })
    // 纵深防御：源路径必须仍在报告存储根内（与知识库下载的托管路径校验保持一致）。
    if (!isPathWithinRoot(reportStorageRoot, source.path)) {
      return NextResponse.json({ error: '报告源文件不存在。' }, { status: 404 })
    }

    const fileStat = await stat(source.path)
    if (!fileStat.isFile() || fileStat.size <= 0) {
      return NextResponse.json({ error: '报告源文件不可用。' }, { status: 404 })
    }

    const download = new URL(request.url).searchParams.get('download') === '1'
    const rangeHeader = request.headers.get('range')
    const range = resolveByteRange(rangeHeader, fileStat.size)
    if (!range) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${fileStat.size}` },
      })
    }

    const contentLength = range.end - range.start + 1
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'Content-Disposition': contentDispositionHeader(source.fileName, download),
      'Content-Length': String(contentLength),
      'Content-Security-Policy': "frame-ancestors 'self'",
      'Content-Type': source.mimeType,
      'X-Content-Type-Options': 'nosniff',
    })
    if (range.partial) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${fileStat.size}`)

    const body = includeBody
      ? Readable.toWeb(createReadStream(source.path, { start: range.start, end: range.end })) as ReadableStream<Uint8Array>
      : null
    return new Response(body, { status: range.partial ? 206 : 200, headers })
  } catch (error) {
    console.error('[report-file] 读取失败', error)
    return NextResponse.json({ error: '报告文件读取失败，请稍后重试。' }, { status: 500 })
  }
}



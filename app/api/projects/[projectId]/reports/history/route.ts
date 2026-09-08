import { NextResponse } from 'next/server'
import { countReports, listReportHistory, projectExistsReadable } from '@/lib/db/repository'
import { getRequestUser } from '@/lib/auth/request'
import { pageResult, parsePagination, paginationRangeFailure } from '@/lib/http/pagination'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params
  const user = getRequestUser(request)
  if (!user) return NextResponse.json({ error: '未登录。' }, { status: 401 })
  if (!projectExistsReadable(projectId)) {
    return NextResponse.json({ error: '课题不存在。' }, { status: 404 })
  }

  let pagination
  try {
    pagination = parsePagination(request, { limit: 50, maxLimit: 100 })
  } catch (error) {
    const failure = paginationRangeFailure(error)
    if (failure) return NextResponse.json({ error: failure.error }, { status: failure.status })
    throw error
  }
  const entries = listReportHistory(projectId, pagination)
  const page = pageResult(entries, countReports(projectId), pagination)
  return NextResponse.json({
    latestReportId: pagination.offset === 0 ? entries[0]?.report.id : undefined,
    entries: page.items,
    total: page.total,
    limit: page.limit,
    offset: page.offset,
    hasMore: page.hasMore,
  })
}

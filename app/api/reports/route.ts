import { NextRequest, NextResponse } from 'next/server'
import { getRequestUser } from '@/lib/auth/request'
import { countAllReportsWithProjects, listAllReportsWithProjects } from '@/lib/db/repository'
import { pageResult, parsePagination, paginationRangeFailure } from '@/lib/http/pagination'
import { logUnexpectedError } from '@/lib/http/public-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const user = getRequestUser(request)
  if (!user) return NextResponse.json({ error: '未登录。' }, { status: 401 })

  try {
    const pagination = parsePagination(request, { limit: 100, maxLimit: 100 })
    const result = pageResult(listAllReportsWithProjects(pagination), countAllReportsWithProjects(), pagination)
    return NextResponse.json({ reports: result.items, total: result.total, limit: result.limit, offset: result.offset, hasMore: result.hasMore })
  } catch (error) {
    const failure = paginationRangeFailure(error)
    if (failure) return NextResponse.json({ error: failure.error }, { status: failure.status })
    logUnexpectedError('reports.list', error)
    return NextResponse.json({ error: '获取报告库失败。' }, { status: 500 })
  }
}

import { NextResponse } from 'next/server'
import { getRequestUser } from '@/lib/auth/request'
import { countActiveUsers, listActiveUsers } from '@/lib/auth/session'
import { pageResult, parsePagination, paginationRangeFailure } from '@/lib/http/pagination'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  if (!getRequestUser(request)) return NextResponse.json({ error: '未登录。' }, { status: 401 })
  try {
    const pagination = parsePagination(request, { limit: 100, maxLimit: 100 })
    const result = pageResult(listActiveUsers(pagination), countActiveUsers(), pagination)
    return NextResponse.json({ users: result.items, total: result.total, limit: result.limit, offset: result.offset, hasMore: result.hasMore })
  } catch (error) {
    const failure = paginationRangeFailure(error)
    if (failure) return NextResponse.json({ error: failure.error }, { status: failure.status })
    throw error
  }
}

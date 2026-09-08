import { NextResponse } from 'next/server'
import { getOverviewStats, listAllReportsWithProjects, listKnowledgeItems, listOverviewActivityReports, userCanDeleteKnowledgeItem } from '@/lib/db/repository'
import { getRequestUser } from '@/lib/auth/request'
import { checkRateLimit } from '@/lib/security/rate-limit'
import { rateLimitFailure } from '@/lib/http/rate-limit-response'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const user = getRequestUser(request)
  if (!user) return NextResponse.json({ error: '未登录。' }, { status: 401 })
  const decision = checkRateLimit(`overview-stats:${user.id}`, { limit: 60, windowMs: 60_000 })
  const limited = rateLimitFailure(decision, { error: '概览刷新过于频繁，请稍后再试。' })
  if (limited) return NextResponse.json(limited.body, { status: limited.status, headers: limited.headers })
  return NextResponse.json({
    stats: getOverviewStats(),
    recentReports: listAllReportsWithProjects({ limit: 4, offset: 0 }),
    activityReports: listOverviewActivityReports(20),
    recentKnowledge: listKnowledgeItems(undefined, { limit: 4, offset: 0 }).map((item) => ({
      id: item.id,
      title: item.title,
      fileName: item.fileName,
      fileSize: item.fileSize,
      category: item.category,
      description: item.description,
      tags: item.tags,
      uploadedBy: item.uploadedBy,
      canDelete: userCanDeleteKnowledgeItem(item, user),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })),
  })
}

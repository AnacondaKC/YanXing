import { NextRequest, NextResponse } from 'next/server'
import { getRequestSession } from '@/lib/auth/request'
import { deleteKnowledgeItem, getKnowledgeItem, ReportAuthorizationChangedError, userCanDeleteKnowledgeItem } from '@/lib/db/repository'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ knowledgeId: string }> },
) {
  const session = getRequestSession(request)
  if (!session) return NextResponse.json({ error: '未登录。' }, { status: 401 })

  const { knowledgeId } = await params
  const item = getKnowledgeItem(knowledgeId)
  if (!item) return NextResponse.json({ error: '参考研报不存在。' }, { status: 404 })
  if (!userCanDeleteKnowledgeItem(item, session.user)) {
    return NextResponse.json({ error: '仅上传者或管理员可以删除该研报。' }, { status: 403 })
  }

  try {
    const success = await deleteKnowledgeItem(knowledgeId, session.user)
    if (!success) return NextResponse.json({ error: '删除失败。' }, { status: 400 })
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof ReportAuthorizationChangedError) return NextResponse.json({ error: error.message }, { status: 403 })
    console.error('[knowledge] 删除失败', error)
    return NextResponse.json({ error: '删除失败，请稍后重试。' }, { status: 500 })
  }
}

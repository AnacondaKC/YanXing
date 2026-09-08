import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/request'
import { getManagedUserById } from '@/lib/auth/session'
import { getProjectMembersSnapshot, isProjectMemberRole, ProjectCollaboratorLimitError, ProjectMembershipConflictError, replaceProjectMembers } from '@/lib/db/repository'
import { PROJECT_FIELD_LIMITS } from '@/modules/projects/validation'
import { jsonBodyFailureResponse } from '@/lib/http/json-body-response'
import { readJsonBodyOrTooLarge } from '@/lib/http/request-body'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type MemberInput = {
  userId?: unknown
  role?: unknown
}

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const access = requireAdmin(request)
  if (access instanceof NextResponse) return access
  const { projectId } = await context.params
  const snapshot = getProjectMembersSnapshot(projectId)
  if (!snapshot) return NextResponse.json({ error: '课题不存在。' }, { status: 404 })
  return NextResponse.json(snapshot)
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const access = requireAdmin(request)
  if (access instanceof NextResponse) return access
  const { projectId } = await context.params
  const parsed = await readJsonBodyOrTooLarge<{ members?: unknown; revision?: unknown }>(request, 16 * 1024)
  if (!parsed.ok) return jsonBodyFailureResponse(parsed.status)
  const body = parsed.body
  if (!body || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0) {
    return NextResponse.json({ error: '缺少有效的成员版本号，请刷新后重试。' }, { status: 400 })
  }
  if (!Array.isArray(body?.members) || !body.members.length) {
    return NextResponse.json({ error: '至少需要配置一名课题成员。' }, { status: 400 })
  }

  const members: Array<{ userId: string; role: 'owner' | 'editor' }> = []
  const seen = new Set<string>()
  for (const item of body.members as MemberInput[]) {
    const userId = typeof item?.userId === 'string' ? item.userId.trim() : ''
    const role = typeof item?.role === 'string' ? item.role : undefined
    if (!userId || seen.has(userId) || !isProjectMemberRole(role)) {
      return NextResponse.json({ error: '课题成员配置无效。' }, { status: 400 })
    }
    if (!getManagedUserById(userId)) {
      return NextResponse.json({ error: '课题成员必须来自现有用户。' }, { status: 400 })
    }
    seen.add(userId)
    members.push({ userId, role })
  }
  if (members.filter((member) => member.role === 'owner').length !== 1) {
    return NextResponse.json({ error: '课题必须有且仅有一名负责人。' }, { status: 400 })
  }
  if (members.length - 1 > PROJECT_FIELD_LIMITS.collaborators) {
    return NextResponse.json({ error: `课题协作者不能超过 ${PROJECT_FIELD_LIMITS.collaborators} 人。` }, { status: 400 })
  }

  try {
    const updated = replaceProjectMembers(projectId, members, Number(body.revision), access.id)
    return updated
      ? NextResponse.json(updated)
      : NextResponse.json({ error: '课题不存在。' }, { status: 404 })
  } catch (error) {
    if (error instanceof ProjectMembershipConflictError) {
      return NextResponse.json({ error: error.message, code: 'MEMBERSHIP_CONFLICT' }, { status: 409 })
    }
    if (error instanceof ProjectCollaboratorLimitError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : '课题权限保存失败。' }, { status: 400 })
  }
}

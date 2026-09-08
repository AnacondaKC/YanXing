import { NextResponse } from 'next/server'
import { countProjectsForUser, createProjectForUser, getProjectForUser, listProjectsForUser, ProjectMemberInvalidError, ReportAuthorizationChangedError } from '@/lib/db/repository'
import { pageResult, parsePagination, paginationRangeFailure } from '@/lib/http/pagination'
import { jsonBodyFailureResponse } from '@/lib/http/json-body-response'
import { readJsonBodyOrTooLarge } from '@/lib/http/request-body'
import { getActiveUserById, getActiveUsersByIds } from '@/lib/auth/session'
import { getRequestUser } from '@/lib/auth/request'
import { recordActivity } from '@/lib/notifications'
import { notificationActions } from '@/modules/notifications/domain'
import type { Milestone } from '@/modules/projects/domain'
import { PROJECT_FIELD_LIMITS, validateProjectConfiguration } from '@/modules/projects/validation'

export const runtime = 'nodejs'

function sanitizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
}

function resolveActiveUsers(ids: string[]) {
  const users = getActiveUsersByIds(ids)
  return users.some((user) => !user) ? null : users.filter((user): user is NonNullable<typeof user> => Boolean(user))
}

function sanitizeMilestones(value: unknown): Milestone[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > PROJECT_FIELD_LIMITS.milestones) return null
  const milestones: Milestone[] = []
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'object' || item === null) return null
    const raw = item as Record<string, unknown>
    const title = typeof raw.title === 'string' ? raw.title.trim() : ''
    const targetDate = typeof raw.targetDate === 'string' ? raw.targetDate.trim() : ''
    const description = typeof raw.description === 'string' ? raw.description.trim() : ''
    if (Array.isArray(raw.reportIds) && raw.reportIds.length > 0) return null
    milestones.push({
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `stage-${index + 1}`,
      title,
      targetDate: targetDate || undefined,
      description: description || undefined,
      status: 'not_started',
      reportIds: [],
    })
  }
  return milestones
}

export async function GET(request: Request) {
  const user = getRequestUser(request)
  if (!user) return NextResponse.json({ error: '未登录。' }, { status: 401 })
  try {
    const pagination = parsePagination(request, { limit: 100, maxLimit: 100 })
    const result = pageResult(listProjectsForUser(user, pagination), countProjectsForUser(user), pagination)
    return NextResponse.json({ projects: result.items, total: result.total, limit: result.limit, offset: result.offset, hasMore: result.hasMore })
  } catch (error) {
    const failure = paginationRangeFailure(error)
    if (failure) return NextResponse.json({ error: failure.error }, { status: failure.status })
    throw error
  }
}

export async function POST(request: Request) {
  const user = getRequestUser(request)
  if (!user) return NextResponse.json({ error: '未登录。' }, { status: 401 })
  let body: Partial<{
    title: string
    objective: string
    description: string
    ownerId: string
    collaboratorIds: string[]
    milestones: unknown[]
  }> | null
  const parsed = await readJsonBodyOrTooLarge<typeof body>(request, 256 * 1024)
  if (!parsed.ok) return jsonBodyFailureResponse(parsed.status)
  body = parsed.body
  const title = typeof body?.title === 'string' ? body.title.trim() : ''
  if (!title) {
    return NextResponse.json({ error: '课题标题不能为空。' }, { status: 400 })
  }
  const objective = typeof body?.objective === 'string' ? body.objective.trim() : ''
  const description = typeof body?.description === 'string' ? body.description.trim() : ''

  // 负责人默认为创建者本人；研究员不能指定他人，管理员可以。
  const requestedOwnerId = typeof body?.ownerId === 'string' ? body.ownerId.trim() : ''
  const ownerId = requestedOwnerId || user.id
  if (requestedOwnerId && requestedOwnerId !== user.id && user.role !== 'admin') {
    return NextResponse.json({ error: '只有管理员可以指定其他人为课题负责人。' }, { status: 403 })
  }
  const owner = getActiveUserById(ownerId)
  if (!owner) {
    return NextResponse.json({ error: '请选择一名有效的课题负责人。' }, { status: 400 })
  }
  const collaboratorIds = sanitizeIdList(body?.collaboratorIds).filter((id) => id !== ownerId)
  if (collaboratorIds.length > PROJECT_FIELD_LIMITS.collaborators) {
    return NextResponse.json({ error: `课题协作者不能超过 ${PROJECT_FIELD_LIMITS.collaborators} 人。` }, { status: 400 })
  }
  if (!resolveActiveUsers(collaboratorIds)) {
    return NextResponse.json({ error: '存在无效的协作者，请刷新后重试。' }, { status: 400 })
  }
  if (title.length > 160 || objective.length > 2_000 || description.length > 5_000) {
    return NextResponse.json({ error: '课题字段长度超过限制。' }, { status: 400 })
  }
  const milestones = sanitizeMilestones(body?.milestones)
  if (!milestones) {
    return NextResponse.json({ error: '研究计划格式不正确。' }, { status: 400 })
  }
  const configurationError = validateProjectConfiguration({ title, objective, description, milestones })
  if (configurationError) return NextResponse.json({ error: configurationError }, { status: 400 })

  let project
  try {
    project = createProjectForUser({
      title,
      objective,
      description,
      ownerName: owner.displayName,
      milestones,
    }, ownerId, user.id, collaboratorIds)
  } catch (error) {
    if (error instanceof ReportAuthorizationChangedError) return NextResponse.json({ error: error.message }, { status: 403 })
    if (error instanceof ProjectMemberInvalidError) return NextResponse.json({ error: error.message }, { status: 400 })
    throw error
  }
  const visibleProject = getProjectForUser(user, project.id)
  recordActivity({
    action: notificationActions.projectCreated,
    actor: user,
    projectId: project.id,
    projectTitle: project.title,
    summary: '新建课题「' + project.title + '」',
    detail: user.displayName + ' 新建课题「' + project.title + '」，负责人：' + owner.displayName + '，已配置 ' + project.milestones.length + ' 个研究阶段。',
  })
  return NextResponse.json({ project: visibleProject ?? project }, { status: 201 })
}

import { getDatabase, inImmediateTransaction } from '@/lib/db/client'
import { ReportAuthorizationChangedError } from '@/lib/auth/authorization-changed'
import { nextMonotonicIsoTimestamp } from '@/lib/monotonic-iso-timestamp'
import type { ProjectMemberRole } from '@/modules/projects/domain'
import { PROJECT_FIELD_LIMITS } from '@/modules/projects/validation'

export interface ManagedProjectMember {
  userId: string
  username: string
  displayName: string
  role: ProjectMemberRole
  status: 'active' | 'disabled'
}


export class ProjectMemberInvalidError extends Error {
  constructor() {
    super('课题负责人或协作者状态已变化，请刷新后重试。')
    this.name = 'ProjectMemberInvalidError'
  }
}

export function isProjectMemberRole(value: string | undefined): value is ProjectMemberRole {
  return value === 'owner' || value === 'editor'
}
function listProjectMembersInDatabase(database: ReturnType<typeof getDatabase>, projectId: string): ManagedProjectMember[] {
  return (database.prepare(`
    SELECT project_members.user_id, users.username, users.display_name, project_members.role, users.status
    FROM project_members
    INNER JOIN users ON users.id = project_members.user_id
    WHERE project_members.project_id = ?
    ORDER BY CASE project_members.role WHEN 'owner' THEN 0 ELSE 1 END, users.display_name COLLATE NOCASE, users.username COLLATE NOCASE
  `).all(projectId) as Record<string, unknown>[]).map((row) => ({
    userId: text(row.user_id),
    username: text(row.username),
    displayName: text(row.display_name),
    role: text(row.role) as ProjectMemberRole,
    status: text(row.status) as 'active' | 'disabled',
  }))
}

export function getProjectMembersSnapshot(projectId: string): { members: ManagedProjectMember[]; revision: number } | undefined {
  const rows = getDatabase().prepare(`
    SELECT projects.membership_revision, project_members.user_id, users.username, users.display_name, project_members.role, users.status
    FROM projects
    LEFT JOIN project_members ON project_members.project_id = projects.id
    LEFT JOIN users ON users.id = project_members.user_id
    WHERE projects.id = ?
    ORDER BY CASE project_members.role WHEN 'owner' THEN 0 ELSE 1 END, users.display_name COLLATE NOCASE, users.username COLLATE NOCASE
  `).all(projectId) as Record<string, unknown>[]
  if (!rows.length) return undefined
  return {
    revision: integer(rows[0].membership_revision),
    members: rows.filter((row) => row.user_id !== null).map((row) => ({
      userId: text(row.user_id),
      username: text(row.username),
      displayName: text(row.display_name),
      role: text(row.role) as ProjectMemberRole,
      status: text(row.status) as 'active' | 'disabled',
    })),
  }
}

export class ProjectMembershipConflictError extends Error {
  constructor() {
    super('课题成员信息已被其他管理员更新，请刷新后重试。')
    this.name = 'ProjectMembershipConflictError'
  }
}

export class ProjectCollaboratorLimitError extends Error {
  constructor() {
    super('课题协作者不能超过 3 人，请先移出部分协作者。')
    this.name = 'ProjectCollaboratorLimitError'
  }
}

export function replaceProjectMembers(input: {
  projectId: string
  members: Array<{ userId: string; role: ProjectMemberRole }>
  expectedRevision: number
  actorId: string
}): { members: ManagedProjectMember[]; revision: number } | undefined {
  const {projectId,members,expectedRevision,actorId}=input
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new ProjectMembershipConflictError()
  const normalizedMembers = [...new Map(members.map((member) => [member.userId, member])).values()]
  if (normalizedMembers.length !== members.length) throw new ProjectMemberInvalidError()
  const ownerMembers = normalizedMembers.filter((member) => member.role === 'owner')
  if (ownerMembers.length !== 1) throw new Error('课题必须有且仅有一名负责人。')
  if (normalizedMembers.length - 1 > PROJECT_FIELD_LIMITS.collaborators) throw new ProjectCollaboratorLimitError()
  const userPlaceholders = normalizedMembers.map(() => '?').join(', ')
  const updated = inImmediateTransaction((database) => {
    const project = database.prepare('SELECT id, membership_revision, updated_at FROM projects WHERE id = ?').get(projectId) as { id?: string; membership_revision?: unknown; updated_at?: string } | undefined
    if (!project) return undefined
    const actor = database.prepare("SELECT 1 FROM users WHERE id = ? AND status = 'active' AND role = 'admin'").get(actorId)
    if (!actor) throw new ReportAuthorizationChangedError()
    if (project.membership_revision !== expectedRevision) {
      throw new ProjectMembershipConflictError()
    }
    const activeMemberCount = (database.prepare(`SELECT COUNT(*) AS count FROM users WHERE status = 'active' AND id IN (${userPlaceholders})`)
      .get(...normalizedMembers.map((member) => member.userId)) as { count: number }).count
    if (activeMemberCount !== normalizedMembers.length) throw new ProjectMemberInvalidError()
    database.prepare(`
      DELETE FROM project_members
      WHERE project_id = ? AND user_id NOT IN (${userPlaceholders})
    `).run(projectId, ...normalizedMembers.map((member) => member.userId))
    // 先降级全部负责人再写入最终角色，避免触碰单负责人唯一索引。
    database.prepare("UPDATE project_members SET role = 'editor' WHERE project_id = ? AND role = 'owner'").run(projectId)
    for (const member of normalizedMembers) {
      database.prepare(`
        INSERT INTO project_members(project_id, user_id, role, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role
      `).run(projectId, member.userId, member.role, now())
    }
    const ownerName = (database.prepare('SELECT display_name FROM users WHERE id = ?').get(ownerMembers[0]!.userId) as { display_name?: string } | undefined)?.display_name ?? ''
    database.prepare('UPDATE projects SET owner_name = ?, membership_revision = membership_revision + 1, updated_at = ? WHERE id = ?').run(ownerName, nextMonotonicIsoTimestamp(project.updated_at), projectId)
    return {
      members: listProjectMembersInDatabase(database, projectId),
      revision: integer(project.membership_revision) + 1,
    }
  })
  return updated
}


function now() { return new Date().toISOString() }
function text(value: unknown): string { return String(value ?? '') }
function integer(value: unknown): number { return typeof value === 'number' ? Math.trunc(value) : Number(value ?? 0) }

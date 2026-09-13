import type { ProjectMemberRole } from '@/modules/projects/domain'
import type { UserRole, UserStatus } from '@/modules/users/domain'

export interface ProjectConfigurationEditContext {
  projectId: string
  actor?: { id: string; role: UserRole; status: UserStatus }
  membership?: { projectId: string; userId: string; role: ProjectMemberRole }
}

export function canEditProjectConfiguration(context: ProjectConfigurationEditContext): boolean {
  const { actor, membership, projectId } = context
  if (!projectId || !actor?.id || actor.status !== 'active') return false
  if (actor.role === 'admin') return true
  return actor.role === 'researcher'
    && membership?.userId === actor.id
    && membership.projectId === projectId
    && (membership.role === 'owner' || membership.role === 'editor')
}

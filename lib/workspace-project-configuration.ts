import { apiFetch, fetchAllPages, mutationHeaders } from '@/lib/client-request'
import { editWorkspaceProject, editWorkspaceStages, fetchWorkspaceProject, WorkspaceRequestError } from '@/lib/workspace-submission-client'
import type { WorkspaceProjectDetail, WorkspaceProjectSafeEdit } from '@/modules/contracts/submission-workspace'
import type { StagePlanEdit } from '@/modules/projects/stage-project-contract'
import { planIsFrozen } from '@/lib/workspace-submission'
import { PROJECT_FIELD_LIMITS } from '@/modules/projects/validation'
import { assertValidStagePlan } from '@/modules/projects/stage-domain'
import type { SessionUser } from '@/modules/users/domain'

export type ConfigurationTab = 'info' | 'team' | 'plan'
export type ConfigurationStage = StagePlanEdit['nextStages'][number]
export interface ConfigurationDraft {
  metadata: { title: string; objective: string; description: string }
  stages: ConfigurationStage[]
  ownerId: string
}
export interface ConfigurationMembers {
  members: { userId: string; role: 'owner' | 'editor'; displayName?: string }[]
  revision: number
}
export const CONFIGURATION_LABELS = { info: '课题信息', plan: '计划与排期', team: '研究团队' } as const

export function configurationDraft(detail: WorkspaceProjectDetail): ConfigurationDraft {
  const { title, objective, description, ownerId } = detail.project
  return { metadata: { title, objective, description }, ownerId, stages: detail.stages.map(({ stage }) => ({
    id: stage.id, title: stage.title, description: stage.description ?? '',
    plannedStartAt: stage.plannedStartAt ?? '', plannedEndAt: stage.plannedEndAt ?? '',
  })) }
}

function normalizedDraft(draft: ConfigurationDraft): ConfigurationDraft {
  return { ...draft, metadata: {
    title: draft.metadata.title.trim(), objective: draft.metadata.objective.trim(), description: draft.metadata.description.trim(),
  }, stages: draft.stages.map(stage => ({ id: stage.id, title: stage.title.trim(), description: stage.description?.trim() || '',
    plannedStartAt: stage.plannedStartAt || '', plannedEndAt: stage.plannedEndAt || '',
  })) }
}

export function configurationIsFrozen(detail: WorkspaceProjectDetail) {
  return planIsFrozen(detail.stages) || detail.workflow.nextSubmissionSequence > 1
}

export function changedConfiguration(baseline: ConfigurationDraft, draft: ConfigurationDraft, isAdmin: boolean): ConfigurationTab[] {
  const before = normalizedDraft(baseline)
  const after = normalizedDraft(draft)
  const changed: ConfigurationTab[] = []
  if (JSON.stringify(before.metadata) !== JSON.stringify(after.metadata)) changed.push('info')
  if (JSON.stringify(before.stages) !== JSON.stringify(after.stages)) changed.push('plan')
  if (isAdmin && before.ownerId !== after.ownerId) changed.push('team')
  return changed
}

export function validateConfiguration(input: { draft: ConfigurationDraft; baseline: ConfigurationDraft; frozen: boolean; isAdmin: boolean }): { tab: ConfigurationTab; message: string } | undefined {
  const { draft, baseline, frozen, isAdmin } = input
  const changed = changedConfiguration(baseline, draft, isAdmin)
  const { title, objective, description } = normalizedDraft(draft).metadata
  if (!title) return { tab: 'info', message: '课题标题不能为空。' }
  if (!objective) return { tab: 'info', message: '研究目标与核心问题不能为空。' }
  if (!description) return { tab: 'info', message: '研究背景与说明不能为空。' }
  if (title.length > PROJECT_FIELD_LIMITS.title || objective.length > PROJECT_FIELD_LIMITS.objective || description.length > PROJECT_FIELD_LIMITS.description) return { tab: 'info', message: '课题字段长度超过限制。' }
  if (changed.includes('team') && !draft.ownerId) return { tab: 'team', message: '请选择课题负责人。' }
  if (!changed.includes('plan')) return
  if (frozen && JSON.stringify(baseline.stages.map(stage => stage.id)) !== JSON.stringify(draft.stages.map(stage => stage.id))) {
    return { tab: 'plan', message: '正式提交后阶段结构已冻结，不能新增、删除或调整顺序。' }
  }
  try { assertValidStagePlan(draft.stages) }
  catch (error) { return { tab: 'plan', message: error instanceof Error ? error.message : '阶段计划无效。' } }
}

export function membersWithOwner(snapshot: ConfigurationMembers, ownerId: string): ConfigurationMembers {
  return { revision: snapshot.revision, members: [
    { userId: ownerId, role: 'owner' },
    ...snapshot.members.filter(member => member.role === 'editor' && member.userId !== ownerId).map(member => ({ userId: member.userId, role: member.role })),
  ] }
}

async function readMembersResponse(response: Response): Promise<ConfigurationMembers> {
  const body = await response.json() as ConfigurationMembers & { error?: string }
  if (!response.ok) throw new WorkspaceRequestError({ status: response.status, error: body.error || '团队配置请求失败。' })
  if (!Array.isArray(body.members) || !Number.isSafeInteger(body.revision) || body.revision < 0 || body.members.filter(member => member.role === 'owner').length !== 1) throw new Error('团队配置响应无效。')
  return body
}

export async function fetchConfigurationTeam(projectId: string, signal?: AbortSignal) {
  const [users, snapshot] = await Promise.all([
    fetchAllPages<SessionUser>('/api/users', 'users', { cache: 'no-store', signal }),
    apiFetch('/api/admin/projects/' + encodeURIComponent(projectId) + '/members', { cache: 'no-store', signal }).then(readMembersResponse),
  ])
  return { users: users.items, snapshot }
}

async function saveMembers(projectId: string, snapshot: ConfigurationMembers) {
  return readMembersResponse(await apiFetch('/api/admin/projects/' + encodeURIComponent(projectId) + '/members', {
    method: 'PUT', headers: mutationHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(snapshot),
  }))
}

export interface ConfigurationTransport {
  metadata: (projectId: string, edit: WorkspaceProjectSafeEdit) => Promise<Record<string, unknown>>
  plan: (projectId: string, edit: StagePlanEdit) => Promise<Record<string, unknown>>
  members: (projectId: string, snapshot: ConfigurationMembers) => Promise<ConfigurationMembers>
  read: (projectId: string) => Promise<WorkspaceProjectDetail>
}
const defaultTransport: ConfigurationTransport = { metadata: editWorkspaceProject, plan: editWorkspaceStages, members: saveMembers, read: fetchWorkspaceProject }

export class ConfigurationSaveError extends Error {
  constructor(message: string, readonly tab?: ConfigurationTab) { super(message) }
}

/** A write receipt advances only its own baseline. Never refresh tokens to retry a stale draft. */
export class ConfigurationSaveSession {
  baseline: ConfigurationDraft
  members?: ConfigurationMembers
  readonly saved = new Set<ConfigurationTab>()
  blocked = false
  writesComplete = false
  private busy = false
  private updatedAt: string
  private planRevision: number
  readonly frozen: boolean

  constructor(readonly detail: WorkspaceProjectDetail, readonly isAdmin: boolean, private readonly transport = defaultTransport) {
    this.baseline = configurationDraft(detail)
    this.updatedAt = detail.project.updatedAt
    this.planRevision = detail.workflow.planRevision
    this.frozen = configurationIsFrozen(detail)
  }

  async save(draft: ConfigurationDraft): Promise<WorkspaceProjectDetail> {
    if (this.busy) throw new ConfigurationSaveError('正在保存，请稍候。')
    if (this.blocked) throw new ConfigurationSaveError('请先重新载入最新配置；重新载入会丢弃未保存草稿。')
    this.busy = true
    try {
      if (!this.writesComplete) await this.writeChanges(normalizedDraft(draft))
      try { return await this.transport.read(this.detail.project.id) }
      catch { throw new ConfigurationSaveError('所有修改已保存，但刷新课题失败。请点击「仅重新读取」，不会重复写入。') }
    } finally { this.busy = false }
  }

  private async writeChanges(draft: ConfigurationDraft) {
    const invalid = validateConfiguration({ draft, baseline: this.baseline, frozen: this.frozen, isAdmin: this.isAdmin })
    if (invalid) throw new ConfigurationSaveError(invalid.message, invalid.tab)
    const changed = changedConfiguration(this.baseline, draft, this.isAdmin)
    if (this.saved.has('plan') && changed.includes('info')) {
      this.blocked = true
      throw new ConfigurationSaveError('计划已保存并更新课题版本。新增的课题信息修改尚未保存；请重新载入最新配置后编辑，这会丢弃未保存草稿。', 'info')
    }
    if (changed.includes('team') && !this.members) throw new ConfigurationSaveError('请先重试读取团队配置，再保存负责人变更。', 'team')
    for (const tab of changed) {
      try { await this.writeSection(tab, draft); this.saved.add(tab) }
      catch (error) {
        this.blocked = !(error instanceof WorkspaceRequestError) || error.payload.status === 409 || error.payload.status >= 500 || error.payload.status === 408
        const saved = [...this.saved].map(key => CONFIGURATION_LABELS[key]).join('、') || '无'
        const pending = changedConfiguration(this.baseline, draft, this.isAdmin).map(key => CONFIGURATION_LABELS[key]).join('、')
        const reason = error instanceof Error ? error.message : '请求失败。'
        throw new ConfigurationSaveError('已保存：' + saved + '；未保存或结果未确认：' + pending + '。' + reason + (this.blocked ? ' 请重新载入最新配置后核对；这会丢弃未保存草稿，禁止直接重试覆盖。' : ' 草稿已保留，可重试未保存分区。'), tab)
      }
    }
    this.writesComplete = true
  }

  private async writeSection(tab: ConfigurationTab, draft: ConfigurationDraft) {
    const projectId = this.detail.project.id
    if (tab === 'info') {
      const result = await this.transport.metadata(projectId, { expectedUpdatedAt: this.updatedAt, ...draft.metadata })
      const project = result.project as WorkspaceProjectDetail['project'] | undefined
      if (!project?.updatedAt) throw new Error('课题保存回执缺少版本号，结果需重新核对。')
      this.updatedAt = project.updatedAt
      this.baseline = { ...this.baseline, metadata: { title: project.title, objective: project.objective, description: project.description } }
    } else if (tab === 'plan') {
      const result = await this.transport.plan(projectId, { expectedPlanRevision: this.planRevision, nextStages: draft.stages })
      const workflow = result.workflow as WorkspaceProjectDetail['workflow'] | undefined
      if (!workflow || !Number.isSafeInteger(workflow.planRevision)) throw new Error('计划保存回执缺少版本号，结果需重新核对。')
      this.planRevision = workflow.planRevision
      this.baseline = { ...this.baseline, stages: structuredClone(draft.stages) }
    } else {
      this.members = await this.transport.members(projectId, membersWithOwner(this.members!, draft.ownerId))
      this.baseline = { ...this.baseline, ownerId: draft.ownerId }
    }
  }
}

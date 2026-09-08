import { randomUUID } from 'node:crypto'
import { Value } from 'typebox/value'
import { dirname, resolve } from 'node:path'
import { rm } from 'node:fs/promises'
import { pageAnalysisModule } from '@/modules/analysis/modules'
import { evaluationContextsEqual, parseReportEvaluationContext, resolveReportEvaluationContext } from '@/modules/analysis/evaluation-context'
import { validatePageAnalysisOutput } from '@/modules/analysis/gates'
import type { AnalysisCallCheckpoint, AnalysisFinalization, AnalysisSnapshotWrite } from '@/modules/analysis/ports'
import { ANALYSIS_SNAPSHOT_SCHEMA_VERSION, AnalysisStages, MAX_INSIGHT_REGENERATIONS } from '@/modules/contracts/analysis'
import type { AnalysisJob, AnalysisSnapshot } from '@/modules/analysis/domain'
import type { AuthUser } from '@/lib/auth/session'
import { nextMonotonicIsoTimestamp } from '@/lib/monotonic-iso-timestamp'
import {
  AnalysisArtifactSchemas,
  type AnalysisArtifactRecord,
  type AnalysisJobEventType,
  type AnalysisPromptConfig,
  type AnalysisModuleState,
  type AnalysisSnapshotPayload,
  type AnalysisStage,
  type AnalysisTrackedModuleId,
  type GateError,
  type ReportEvaluationContext,
  type ReportFacts,
} from '@/modules/contracts/analysis'
import type { Milestone, Project, ProjectMemberRole, ProjectProgressStatus, ProjectReportSummary, ProjectStage, ProjectWithCapabilities } from '@/modules/projects/domain'
import { PROJECT_FIELD_LIMITS } from '@/modules/projects/validation'
import { applyReportDeliveryToMilestones, completeMilestonesWhenFinalRemains, reconcileMilestonesAfterReportDeletion, resolveDeliveryMilestoneId } from '@/modules/projects/progress'
import type { ReportDeliveryType, ReportHistoryEntry, ReportSource, ReportVersion } from '@/modules/reports/domain'
import { canDeleteReportFromHistory, canReplaceReportFromHistory } from '@/modules/reports/history-policy'
import type { ReportInsight } from '@/modules/insights/domain'
import { getDatabase, inImmediateTransaction } from '@/lib/db/client'
import { runtimeConfig } from '@/lib/config/environment'
import { getAiModelRuntimeSnapshot, getAiPromptConfiguration, getAiPromptSettingsSnapshot, type AiModelRuntimeSnapshot } from '@/lib/db/settings-repository'
import { isAiPromptTarget } from '@/lib/ai/prompt-defaults'
import { getKnowledgeCleanupTarget } from '@/lib/knowledge-storage'
import { isPathWithinRoot } from '@/lib/storage/path-containment'
import { lastDayKeys } from '@/lib/overview-trends'
import { consumeStorageReservationInDatabase, releaseStorageAllocationInDatabase } from '@/lib/storage/quota'
import { estimateAnalysisBudget, estimateInsightBudget, markAiBudgetCallStartedForJobInDatabase, markAiBudgetUncertainForJobInDatabase, reconcileAiBudgetForJobInDatabase, recordAiBudgetCallCompletedForJobInDatabase, reserveAiBudgetInDatabase, settleAiBudgetForJobInDatabase, touchAiBudgetReservationForJobInDatabase } from '@/lib/ai/budget'
import { reportStorageRoot } from '@/lib/documents/report-storage'
const terminalJobStatuses = new Set<AnalysisJob['status']>(['completed', 'failed', 'cancelled'])
const maxJobAutoRecoveries = runtimeConfig.worker.maxAttempts
const queueRetryBaseMs = runtimeConfig.worker.retryBaseMs
const queueRetryMaxMs = runtimeConfig.worker.retryMaxMs
const analysisSnapshotSchemaVersion = ANALYSIS_SNAPSHOT_SCHEMA_VERSION
const insightCheckpointPromptVersion = 'report-insight-checkpoint-v1'

export interface JobEvent {
  id: number
  jobId: string
  type: AnalysisJobEventType
  stage?: AnalysisStage
  moduleId?: AnalysisTrackedModuleId
  errors?: GateError[]
  message: string
  createdAt: string
}

export interface ManagedProjectMember {
  userId: string
  username: string
  displayName: string
  role: ProjectMemberRole
  status: 'active' | 'disabled'
}

export class DuplicateReportError extends Error {
  constructor(readonly report: ReportVersion) {
    super('相同内容的报告版本已存在。')
    this.name = 'DuplicateReportError'
  }
}

export class ReportReplacementBusyError extends Error {
  constructor() {
    super('报告正在分析，暂时不能替换。')
    this.name = 'ReportReplacementBusyError'
  }
}

export class ReportInsightInProgressError extends Error {
  constructor() {
    super('报告洞察正在生成，请稍后再删除。')
    this.name = 'ReportInsightInProgressError'
  }
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

export function replaceProjectMembers(
  projectId: string,
  members: Array<{ userId: string; role: ProjectMemberRole }>,
  expectedRevision?: number,
  actorId?: string,
): { members: ManagedProjectMember[]; revision: number } | undefined {
  const normalizedMembers = [...new Map(members.map((member) => [member.userId, member])).values()]
  const ownerMembers = normalizedMembers.filter((member) => member.role === 'owner')
  if (ownerMembers.length !== 1) throw new Error('课题必须有且仅有一名负责人。')
  if (normalizedMembers.length - 1 > PROJECT_FIELD_LIMITS.collaborators) throw new ProjectCollaboratorLimitError()
  const userPlaceholders = normalizedMembers.map(() => '?').join(', ')
  const updated = inImmediateTransaction((database) => {
    const project = database.prepare('SELECT id, membership_revision, updated_at FROM projects WHERE id = ?').get(projectId) as { id?: string; membership_revision?: unknown; updated_at?: string } | undefined
    if (!project) return undefined
    if (actorId) {
      const actor = database.prepare("SELECT 1 FROM users WHERE id = ? AND status = 'active' AND role = 'admin'").get(actorId)
      if (!actor) throw new ReportAuthorizationChangedError()
    }
    if (expectedRevision !== undefined && project.membership_revision !== expectedRevision) {
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

export type ListPagination = { limit: number; offset: number }

/** 全员可见：所有启用账号都能查看全部课题，非成员以只读方式访问。 */
export function listProjectsForUser(user: AuthUser, pagination?: ListPagination): ProjectWithCapabilities[] {
  return selectProjectsForUser(user, { pagination })
}

export function getProjectForUser(user: AuthUser, projectId: string): ProjectWithCapabilities | undefined {
  return selectProjectsForUser(user, { projectId })[0]
}

function selectProjectsForUser(
  user: AuthUser,
  options: { pagination?: ListPagination; projectId?: string },
): ProjectWithCapabilities[] {
  const admin = user.role === 'admin' ? 1 : 0
  const where = options.projectId ? ' WHERE projects.id = ?' : ''
  const suffix = options.pagination ? ' LIMIT ? OFFSET ?' : ''
  const parameters: Array<string | number> = [admin, user.id]
  if (options.projectId) parameters.push(options.projectId)
  if (options.pagination) parameters.push(options.pagination.limit, options.pagination.offset)
  return rows(`
    SELECT projects.*,
      (
        SELECT owner_members.user_id
        FROM project_members owner_members
        WHERE owner_members.project_id = projects.id AND owner_members.role = 'owner'
        LIMIT 1
      ) AS owner_id,
      (
        SELECT GROUP_CONCAT(collaborator_users.display_name, '、')
        FROM project_members collaborator_members
        INNER JOIN users collaborator_users ON collaborator_users.id = collaborator_members.user_id
        WHERE collaborator_members.project_id = projects.id AND collaborator_members.role != 'owner'
      ) AS collaborator_names,
      CASE WHEN ? = 1 THEN 'owner' ELSE project_members.role END AS member_role,
      latest_report.version AS latest_report_version,
      latest_report.character_count AS latest_report_character_count,
      latest_report.parse_status AS latest_report_parse_status,
      ${publishedMetricSql('latest_snapshot.payload_json', '$.aiScore')} AS latest_ai_score,
      ${publishedMetricSql('latest_snapshot.payload_json', '$.reportCompleteness')} AS latest_completeness
    FROM projects
    LEFT JOIN project_members
      ON project_members.project_id = projects.id
      AND project_members.user_id = ?
    LEFT JOIN report_versions latest_report
      ON latest_report.id = (
        SELECT report.id
        FROM report_versions report
        WHERE report.project_id = projects.id
        ORDER BY report.version DESC, report.created_at DESC
        LIMIT 1
      )
    ${canonicalCurrentSnapshotJoin('latest_snapshot', 'latest_report')}
    ${where}
    ORDER BY projects.updated_at DESC, projects.id DESC${suffix}
  `, ...parameters).map((row) => {
    const memberRole = text(row.member_role)
    const role = isProjectMemberRole(memberRole) ? memberRole : undefined
    return projectWithCapabilities(projectFromRow(row), role, projectReportSummaryFromRow(row))
  })
}

export function countProjectsForUser(_user: AuthUser): number {
  const row = getDatabase().prepare('SELECT COUNT(*) AS count FROM projects').get() as { count?: unknown } | undefined
  return integer(row?.count)
}

export function getProject(projectId: string): Project | undefined {
  return optionalRow(`
    SELECT projects.*,
      (
        SELECT owner_members.user_id
        FROM project_members owner_members
        WHERE owner_members.project_id = projects.id AND owner_members.role = 'owner'
        LIMIT 1
      ) AS owner_id,
      (
        SELECT GROUP_CONCAT(collaborator_users.display_name, '、')
        FROM project_members collaborator_members
        INNER JOIN users collaborator_users ON collaborator_users.id = collaborator_members.user_id
        WHERE collaborator_members.project_id = projects.id AND collaborator_members.role != 'owner'
      ) AS collaborator_names
    FROM projects
    WHERE projects.id = ?
  `, projectId, projectFromRow)
}

export class ProjectMemberInvalidError extends Error {
  constructor() {
    super('课题负责人或协作者状态已变化，请刷新后重试。')
    this.name = 'ProjectMemberInvalidError'
  }
}

export type CreateProjectInput = Pick<Project, 'title' | 'objective' | 'description' | 'ownerName'> & {
  milestones?: Milestone[]
}

export function createProjectForUser(
  input: CreateProjectInput,
  ownerId: string,
  creatorId = ownerId,
  collaboratorIds: string[] = [],
): ProjectWithCapabilities {
  if (!ownerId) throw new Error('课题至少需要一名负责人。')
  const collaboratorIdSet = new Set(collaboratorIds.filter((id) => id && id !== ownerId))
  if (collaboratorIdSet.size > PROJECT_FIELD_LIMITS.collaborators) throw new ProjectCollaboratorLimitError()
  return inImmediateTransaction((database) => {
    const memberIds = [ownerId, ...collaboratorIdSet]
    const placeholders = memberIds.map(() => '?').join(', ')
    const activeMembers = database.prepare(`SELECT id, display_name FROM users WHERE status = 'active' AND id IN (${placeholders})`)
      .all(...memberIds) as Array<{ id: string; display_name: string }>
    if (activeMembers.length !== memberIds.length) throw new ProjectMemberInvalidError()
    const creator = database.prepare("SELECT role FROM users WHERE id = ? AND status = 'active'").get(creatorId) as { role?: string } | undefined
    if (!creator || (ownerId !== creatorId && creator.role !== 'admin')) throw new ReportAuthorizationChangedError()
    const owner = activeMembers.find((member) => member.id === ownerId)
    const project = createProjectRecord({ ...input, ownerName: owner?.display_name ?? input.ownerName }, ownerId)
    insertProject(database, project)
    database.prepare(
      'INSERT INTO project_members(project_id, user_id, role, created_at) VALUES (?, ?, \'owner\', ?)',
    ).run(project.id, ownerId, project.createdAt)
    for (const collaboratorId of collaboratorIdSet) {
      database.prepare(
        'INSERT INTO project_members(project_id, user_id, role, created_at) VALUES (?, ?, \'editor\', ?)',
      ).run(project.id, collaboratorId, project.createdAt)
    }
    const creatorRole = creatorId === ownerId ? 'owner' : undefined
    return projectWithCapabilities(project, creatorRole)
  })
}

export interface UpdateProjectInput {
  title?: string
  objective?: string
  description?: string
  ownerName?: string
  ownerId?: string
  collaboratorIds?: string[]
  milestones?: Milestone[]
}

export class ProjectUpdateConflictError extends Error {
  constructor() {
    super('课题已被其他操作更新，请刷新后重试。')
    this.name = 'ProjectUpdateConflictError'
  }
}

export class ProjectAnalysisBusyError extends Error {
  constructor() {
    super('课题报告正在分析，请稍后再试。')
    this.name = 'ProjectAnalysisBusyError'
  }
}

function readPersistedProjectOwnerId(database: ReturnType<typeof getDatabase>, projectId: string) {
  const row = database.prepare(
    "SELECT user_id FROM project_members WHERE project_id = ? AND role = 'owner' LIMIT 1",
  ).get(projectId) as { user_id?: unknown } | undefined
  return typeof row?.user_id === 'string' && row.user_id ? row.user_id : ''
}

function assertExactlyOneProjectOwner(database: ReturnType<typeof getDatabase>, projectId: string) {
  const row = database.prepare(
    "SELECT COUNT(*) AS count FROM project_members WHERE project_id = ? AND role = 'owner'",
  ).get(projectId) as { count: number }
  if (row.count !== 1) throw new Error('课题必须有且仅有一名负责人。')
}

export function updateProject(
  projectId: string,
  input: UpdateProjectInput,
  options?: { requireNoActiveAnalysis?: boolean; actor?: AuthUser; requireOwner?: boolean; expectedUpdatedAt?: string; invalidateAnalysis?: boolean },
): Project | undefined {
  const updated = inImmediateTransaction((database): boolean => {
    const currentRow = database.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, unknown> | undefined
    if (!currentRow) return false
    if (options?.expectedUpdatedAt && text(currentRow.updated_at) !== options.expectedUpdatedAt) throw new ProjectUpdateConflictError()
    if (options?.actor) {
      const authorized = options.requireOwner
        ? userCanDeleteProjectInDatabase(database, projectId, options.actor)
        : userCanManageProjectInDatabase(database, projectId, options.actor)
      if (!authorized) throw new ReportAuthorizationChangedError()
    }
    const current = projectFromRow(currentRow)
    const persistedOwnerId = readPersistedProjectOwnerId(database, projectId)
    if (options?.requireNoActiveAnalysis) {
      // 评价基准（阶段/目标等）必须在无活动分析时变更：检查与写入同事务，避免 TOCTOU。
      const active = database.prepare(`
        SELECT 1
        FROM analysis_jobs job
        INNER JOIN report_versions report ON report.id = job.report_version_id
        WHERE report.project_id = ?
          AND job.type IN ('initial', 'rerun')
          AND job.status IN ('queued', 'running')
        LIMIT 1
      `).get(projectId)
      if (active) throw new ProjectAnalysisBusyError()
    }

    const nextTitle = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : current.title
    const nextObjective = typeof input.objective === 'string' ? input.objective.trim() : current.objective
    const nextDescription = typeof input.description === 'string' ? input.description.trim() : current.description
    const nextOwnerId = typeof input.ownerId === 'string' && input.ownerId ? input.ownerId : persistedOwnerId
    const nextOwnerName = typeof input.ownerName === 'string' ? input.ownerName : current.ownerName
    const nextMilestones = input.milestones ?? current.milestones
    const { stage: nextStage, status: nextStatus } = deriveProjectState(nextMilestones)
    const membershipChanged = input.ownerId !== undefined || input.collaboratorIds !== undefined
    if (membershipChanged) {
      const targetMemberIds = [...new Set([nextOwnerId, ...(input.collaboratorIds ?? [])].filter(Boolean))]
      const placeholders = targetMemberIds.map(() => '?').join(', ')
      const activeCount = (database.prepare(`SELECT COUNT(*) AS count FROM users WHERE status = 'active' AND id IN (${placeholders})`)
        .get(...targetMemberIds) as { count: number }).count
      if (activeCount !== targetMemberIds.length) throw new ProjectMemberInvalidError()
    }

    const result = database.prepare(
      'UPDATE projects SET title = ?, objective = ?, description = ?, owner_name = ?, stage = ?, status = ?, milestones_json = ?, membership_revision = membership_revision + ?, updated_at = ? WHERE id = ?'
    ).run(nextTitle, nextObjective, nextDescription, nextOwnerName, nextStage, nextStatus, json(nextMilestones), membershipChanged ? 1 : 0, nextMonotonicIsoTimestamp(text(currentRow.updated_at)), projectId)
    if (!result.changes) return false

    if (input.milestones) {
      const reportAssignments = new Map<string, string>()
      const lastMilestoneId = input.milestones.at(-1)?.id
      const reportExists = database.prepare('SELECT delivery_type FROM report_versions WHERE id = ? AND project_id = ?')
      for (const milestone of input.milestones) {
        for (const reportId of milestone.reportIds ?? []) {
          if (reportAssignments.has(reportId)) throw new Error('同一报告不能关联多个研究阶段。')
          const report = reportExists.get(reportId, projectId) as { delivery_type?: string | null } | undefined
          if (!report) throw new Error('研究阶段包含不存在或不属于该课题的报告。')
          if (report.delivery_type === 'final' && milestone.id !== lastMilestoneId) throw new Error('最终交付报告只能关联到最后一个研究阶段。')
          reportAssignments.set(reportId, milestone.id)
        }
      }
      const finalReports = database.prepare("SELECT id FROM report_versions WHERE project_id = ? AND delivery_type = 'final'").all(projectId) as Array<{ id: string }>
      if (finalReports.some((report) => reportAssignments.get(report.id) !== lastMilestoneId)) {
        throw new Error('最终交付报告必须保留在最后一个研究阶段。')
      }
      database.prepare('UPDATE report_versions SET milestone_id = NULL WHERE project_id = ?').run(projectId)
      const assignReport = database.prepare('UPDATE report_versions SET milestone_id = ? WHERE id = ? AND project_id = ?')
      for (const [reportId, milestoneId] of reportAssignments) assignReport.run(milestoneId, reportId, projectId)
    }

    if (input.ownerId !== undefined) {
      // 先降级原负责人再提升新负责人，避免触碰单负责人唯一索引。
      database.prepare(`
        UPDATE project_members
        SET role = 'editor'
        WHERE project_id = ? AND role = 'owner' AND user_id != ?
      `).run(projectId, nextOwnerId)
      database.prepare(`
        INSERT INTO project_members(project_id, user_id, role, created_at)
        VALUES (?, ?, 'owner', ?)
        ON CONFLICT(project_id, user_id) DO UPDATE SET role = 'owner'
      `).run(projectId, nextOwnerId, now())
    }

    if (Array.isArray(input.collaboratorIds)) {
      const nextCollabIds = [...new Set(input.collaboratorIds)].filter((id) => id && id !== nextOwnerId)
      // The current PATCH contract treats collaboratorIds as the complete editor set.
      if (nextCollabIds.length) {
        const placeholders = nextCollabIds.map(() => '?').join(', ')
        database.prepare(`DELETE FROM project_members WHERE project_id = ? AND role = 'editor' AND user_id NOT IN (${placeholders})`).run(projectId, ...nextCollabIds)
      } else {
        database.prepare("DELETE FROM project_members WHERE project_id = ? AND role = 'editor'").run(projectId)
      }
      for (const collabId of nextCollabIds) {
        database.prepare(
          "INSERT INTO project_members(project_id, user_id, role, created_at) VALUES (?, ?, 'editor', ?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = 'editor'",
        ).run(projectId, collabId, now())
      }
    }

    if (membershipChanged) {
      const row = database.prepare(
        "SELECT COUNT(*) AS count FROM project_members WHERE project_id = ? AND role = 'editor'"
      ).get(projectId) as { count: number }
      if (row.count > PROJECT_FIELD_LIMITS.collaborators) throw new ProjectCollaboratorLimitError()
      assertExactlyOneProjectOwner(database, projectId)
    }

    if (options?.invalidateAnalysis) {
      database.prepare('UPDATE report_versions SET current_analysis_id = NULL WHERE project_id = ?').run(projectId)
    }
    return true
  })
  // owner_id 是列表 SQL 的计算列，回读统一走 getProject。
  return updated ? getProject(projectId) : undefined
}

const manageProjectRoles = new Set<ProjectMemberRole>(['owner', 'editor'])

/** 只从快照 JSON 取列表所需标量，避免把完整分析结果复制到 Node 再 JSON.parse。 */
function publishedMetricSql(jsonColumn: string, path: string) {
  return `CASE WHEN json_valid(${jsonColumn}) THEN CASE
    WHEN json_type(${jsonColumn}, '${path}.overall') IN ('integer', 'real')
      AND COALESCE(json_array_length(${jsonColumn}, '${path}.dimensions'), 0) > 0
      AND CAST(json_extract(${jsonColumn}, '${path}.overall') AS REAL) BETWEEN 0 AND 100
    THEN CAST(json_extract(${jsonColumn}, '${path}.overall') AS REAL)
  END END`
}

function publishedSectionCountSql(jsonColumn: string) {
  return `CASE WHEN json_valid(${jsonColumn}) THEN json_array_length(${jsonColumn}, '$.reportDetails.sections') END`
}

function latestFullJobStatusSql(reportIdExpr = 'report_versions.id') {
  return `(
      SELECT status
      FROM analysis_jobs
      WHERE report_version_id = ${reportIdExpr}
        AND type IN ('initial', 'rerun')
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    )`
}

function canonicalCurrentSnapshotJoin(snapshotAlias: string, reportAlias: string, joinType: 'LEFT' | 'INNER' = 'LEFT') {
  return `${joinType} JOIN analysis_snapshots ${snapshotAlias}
      ON ${snapshotAlias}.id = ${reportAlias}.current_analysis_id
      AND ${snapshotAlias}.report_version_id = ${reportAlias}.id
      AND ${snapshotAlias}.kind = 'final'
      AND ${snapshotAlias}.schema_version = ${analysisSnapshotSchemaVersion}
      AND json_valid(${snapshotAlias}.payload_json)
      AND json_valid(${snapshotAlias}.module_states_json)
      AND json_valid(${snapshotAlias}.artifacts_json)
      AND EXISTS (
        SELECT 1 FROM analysis_jobs canonical_job
        WHERE canonical_job.id = ${snapshotAlias}.job_id
          AND canonical_job.report_version_id = ${reportAlias}.id
          AND canonical_job.type IN ('initial', 'rerun')
          AND canonical_job.status IN ('completed')
      )
      AND (
        SELECT COUNT(*) FROM json_each(${snapshotAlias}.module_states_json) state
        WHERE json_extract(state.value, '$.status') = 'accepted'
          AND json_extract(state.value, '$.moduleId') = 'page_analysis'
          AND EXISTS (
            SELECT 1 FROM analysis_artifacts state_artifact
            WHERE state_artifact.id = json_extract(state.value, '$.artifactId')
              AND state_artifact.job_id = ${snapshotAlias}.job_id
              AND state_artifact.module_id = 'page_analysis'
              AND state_artifact.schema_version = 1
              AND state_artifact.status = 'accepted'
          )
      ) = 1
      AND EXISTS (
        SELECT 1 FROM analysis_artifacts canonical_artifact
        WHERE canonical_artifact.job_id = ${snapshotAlias}.job_id
          AND canonical_artifact.report_version_id = ${reportAlias}.id
          AND canonical_artifact.module_id = 'page_analysis'
          AND canonical_artifact.schema_version = 1
          AND canonical_artifact.status = 'accepted'
          AND json_valid(canonical_artifact.payload_json)
      )`
}

function projectWithCapabilities(project: Project, memberRole: ProjectMemberRole | undefined, latestReport?: ProjectReportSummary): ProjectWithCapabilities {
  return {
    ...project,
    memberRole,
    canManage: memberRole !== undefined && manageProjectRoles.has(memberRole),
    canDelete: memberRole === 'owner',
    latestReport,
  }
}

function projectReportSummaryFromRow(row: Record<string, unknown>): ProjectReportSummary | undefined {
  if (row.latest_report_version === null || row.latest_report_version === undefined) return undefined
  return {
    version: integer(row.latest_report_version),
    aiScore: readPublishedOverallValue(row.latest_ai_score),
    completeness: readPublishedOverallValue(row.latest_completeness),
    characterCount: text(row.latest_report_parse_status) === 'ready'
      ? integer(row.latest_report_character_count)
      : undefined,
  }
}

export function getUserProjectRole(projectId: string, user: AuthUser): ProjectMemberRole | undefined {
  if (user.role === 'admin') return 'owner'
  const row = getDatabase().prepare(`
    SELECT role FROM project_members
    WHERE project_id = ? AND user_id = ?
  `).get(projectId, user.id) as { role?: string } | undefined
  return row && isProjectMemberRole(row.role) ? row.role : undefined
}

export function isProjectMemberRole(value: string | undefined): value is ProjectMemberRole {
  return value === 'owner' || value === 'editor'
}

/**
 * 全员只读是产品有意设计（非成员以只读方式访问全部课题）：这里只校验资源存在且可读，
 * 不做成员过滤；写操作由 userCanManageProject / userCanDeleteProject 等函数另行校验。
 */
export function projectExistsReadable(projectId: string): boolean {
  return Boolean(getDatabase().prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId))
}

/** 编辑类操作（上传报告、取消/重试任务）：负责人、协作者或管理员。 */
export function userCanManageProject(projectId: string, user: AuthUser): boolean {
  const role = getUserProjectRole(projectId, user)
  return role !== undefined && manageProjectRoles.has(role)
}

/** 删除课题：仅负责人或管理员。 */
export function userCanDeleteProject(projectId: string, user: AuthUser): boolean {
  return getUserProjectRole(projectId, user) === 'owner'
}

export interface OverviewStats {
  totalReportVersions: number
  totalCharacters: number
  knowledgeCount: number
  knowledgeCategoryCount: number
  weeklyNewReports: number
  weeklyNewKnowledge: number
  jobStats: { completed: number; failed: number; cancelled: number; running: number; queued: number }
  trends: {
    versions: number[]
    characters: number[]
    successRate: number[]
    knowledge: number[]
    averageScore: number[]
    analyzedProjects: number[]
  }
}

type ReportTrendBucket = { day: string; versions: number; characters: number; score_count: number; score_total: number }
type JobTrendBucket = { day: string; successes: number; total: number }
type CountTrendBucket = { day: string; count: number }

export function getOverviewStats(): OverviewStats {
  const database = getDatabase()
  const dayKeys = lastDayKeys()
  const [year, month, day] = dayKeys[0]!.split('-').map(Number)
  const windowStart = new Date(year!, month! - 1, day!).toISOString()
  const scoreExpression = "json_extract(current_snapshot.payload_json, '$.aiScore.overall')"
  const scoreDimensionsExpression = "json_extract(current_snapshot.payload_json, '$.aiScore.dimensions')"
  const publishedScoreExpression = `typeof(${scoreExpression}) IN ('integer', 'real') AND COALESCE(json_array_length(${scoreDimensionsExpression}), 0) > 0`
  const reportRow = database.prepare(`
    SELECT COUNT(*) AS total_versions,
      COALESCE(SUM(report_versions.character_count), 0) AS total_chars,
      COALESCE(SUM(CASE WHEN ${publishedScoreExpression} THEN 1 ELSE 0 END), 0) AS score_count,
      COALESCE(SUM(CASE WHEN ${publishedScoreExpression} THEN CAST(${scoreExpression} AS REAL) ELSE 0 END), 0) AS score_total,
      COUNT(DISTINCT CASE WHEN ${publishedScoreExpression} THEN report_versions.project_id END) AS analyzed_projects
    FROM report_versions
    ${canonicalCurrentSnapshotJoin('current_snapshot', 'report_versions')}
  `).get() as { total_versions: number; total_chars: number; score_count: number; score_total: number; analyzed_projects: number }

  const reportBuckets = database.prepare(`
    SELECT strftime('%Y-%m-%d', report_versions.created_at, 'localtime') AS day,
      COUNT(*) AS versions,
      COALESCE(SUM(report_versions.character_count), 0) AS characters,
      COALESCE(SUM(CASE WHEN ${publishedScoreExpression} THEN 1 ELSE 0 END), 0) AS score_count,
      COALESCE(SUM(CASE WHEN ${publishedScoreExpression} THEN CAST(${scoreExpression} AS REAL) ELSE 0 END), 0) AS score_total
    FROM report_versions
    ${canonicalCurrentSnapshotJoin('current_snapshot', 'report_versions')}
    WHERE report_versions.created_at >= ?
    GROUP BY day
  `).all(windowStart) as ReportTrendBucket[]

  // 洞察兜底会插入无模块状态的合成 completed 任务，统计时排除，避免虚增完成量与成功率。
  const jobRows = database.prepare(`
    SELECT aj.status, COUNT(*) AS count
    FROM analysis_jobs aj
    WHERE aj.status IN ('completed', 'failed', 'cancelled', 'running', 'queued')
      AND EXISTS (SELECT 1 FROM analysis_module_states state WHERE state.job_id = aj.id)
    GROUP BY aj.status
  `).all() as Array<{ status: string; count: number }>

  const jobStats = { completed: 0, failed: 0, cancelled: 0, running: 0, queued: 0 }
  for (const row of jobRows) {
    if (row.status === 'completed') jobStats.completed += row.count
    else if (row.status === 'failed') jobStats.failed += row.count
    else if (row.status === 'cancelled') jobStats.cancelled += row.count
    else if (row.status === 'queued') jobStats.queued += row.count
    else jobStats.running += row.count
  }

  const jobBuckets = database.prepare(`
    SELECT strftime('%Y-%m-%d', aj.updated_at, 'localtime') AS day,
      SUM(CASE WHEN aj.status IN ('completed') THEN 1 ELSE 0 END) AS successes,
      COUNT(*) AS total
    FROM analysis_jobs aj
    WHERE aj.updated_at >= ?
      AND aj.status IN ('completed', 'failed', 'cancelled')
      AND EXISTS (SELECT 1 FROM analysis_module_states state WHERE state.job_id = aj.id)
    GROUP BY day
  `).all(windowStart) as JobTrendBucket[]

  const knowledgeRow = database.prepare(`
    SELECT COUNT(*) AS count,
      COUNT(DISTINCT NULLIF(TRIM(category), '')) AS category_count
    FROM knowledge_items
  `).get() as { count?: unknown; category_count?: unknown }
  const knowledgeCount = integer(knowledgeRow?.count)
  const knowledgeBuckets = database.prepare(`
    SELECT strftime('%Y-%m-%d', created_at, 'localtime') AS day, COUNT(*) AS count
    FROM knowledge_items
    WHERE created_at >= ?
    GROUP BY day
  `).all(windowStart) as CountTrendBucket[]

  const analyzedProjectBuckets = database.prepare(`
    WITH first_scored AS (
      SELECT report_versions.project_id, MIN(report_versions.created_at) AS at
      FROM report_versions
      ${canonicalCurrentSnapshotJoin('current_snapshot', 'report_versions', 'INNER')}
      WHERE ${publishedScoreExpression}
      GROUP BY report_versions.project_id
    )
    SELECT strftime('%Y-%m-%d', at, 'localtime') AS day, COUNT(*) AS count
    FROM first_scored
    WHERE at >= ?
    GROUP BY day
  `).all(windowStart) as CountTrendBucket[]

  const weeklyNewReports = sumBuckets(dayKeys, reportBuckets, (bucket) => bucket.versions)
  const weeklyNewKnowledge = sumBuckets(dayKeys, knowledgeBuckets, (bucket) => bucket.count)
  const terminalJobCount = jobStats.completed + jobStats.failed + jobStats.cancelled

  return {
    totalReportVersions: integer(reportRow.total_versions),
    totalCharacters: integer(reportRow.total_chars),
    knowledgeCount,
    knowledgeCategoryCount: integer(knowledgeRow?.category_count),
    weeklyNewReports,
    weeklyNewKnowledge,
    jobStats,
    trends: {
      versions: cumulativeBucketTrend(dayKeys, integer(reportRow.total_versions), reportBuckets, (bucket) => bucket.versions),
      characters: cumulativeBucketTrend(dayKeys, integer(reportRow.total_chars), reportBuckets, (bucket) => bucket.characters),
      successRate: rateBucketTrend(dayKeys, jobStats.completed, terminalJobCount, jobBuckets),
      knowledge: cumulativeBucketTrend(dayKeys, knowledgeCount, knowledgeBuckets, (bucket) => bucket.count),
      averageScore: averageBucketTrend(dayKeys, Number(reportRow.score_total) || 0, integer(reportRow.score_count), reportBuckets),
      analyzedProjects: cumulativeBucketTrend(dayKeys, integer(reportRow.analyzed_projects), analyzedProjectBuckets, (bucket) => bucket.count),
    },
  }
}

function bucketMap<T extends { day: string }>(dayKeys: string[], buckets: T[]) {
  const validDays = new Set(dayKeys)
  return new Map(buckets.filter((bucket) => validDays.has(bucket.day)).map((bucket) => [bucket.day, bucket]))
}

function sumBuckets<T extends { day: string }>(dayKeys: string[], buckets: T[], valueOf: (bucket: T) => number) {
  const byDay = bucketMap(dayKeys, buckets)
  return dayKeys.reduce((total, day) => {
    const bucket = byDay.get(day)
    return total + (bucket ? Number(valueOf(bucket)) || 0 : 0)
  }, 0)
}

function cumulativeBucketTrend<T extends { day: string }>(
  dayKeys: string[],
  total: number,
  buckets: T[],
  valueOf: (bucket: T) => number,
) {
  const byDay = bucketMap(dayKeys, buckets)
  const windowTotal = dayKeys.reduce((sum, day) => sum + (byDay.has(day) ? Number(valueOf(byDay.get(day)!)) || 0 : 0), 0)
  let running = Math.max(0, total - windowTotal)
  return dayKeys.map((day) => {
    if (byDay.has(day)) running += Number(valueOf(byDay.get(day)!)) || 0
    return running
  })
}

function rateBucketTrend(dayKeys: string[], totalSuccesses: number, totalJobs: number, buckets: JobTrendBucket[]) {
  const byDay = bucketMap(dayKeys, buckets)
  let successes = Math.max(0, totalSuccesses - sumBuckets(dayKeys, buckets, (bucket) => bucket.successes))
  let jobs = Math.max(0, totalJobs - sumBuckets(dayKeys, buckets, (bucket) => bucket.total))
  return dayKeys.map((day) => {
    const bucket = byDay.get(day)
    successes += bucket ? Number(bucket.successes) || 0 : 0
    jobs += bucket ? Number(bucket.total) || 0 : 0
    return jobs ? Math.round((successes / jobs) * 100) : 0
  })
}

function averageBucketTrend(
  dayKeys: string[],
  totalScore: number,
  totalCount: number,
  buckets: ReportTrendBucket[],
) {
  const byDay = bucketMap(dayKeys, buckets)
  let score = totalScore - sumBuckets(dayKeys, buckets, (bucket) => Number(bucket.score_total) || 0)
  let count = totalCount - sumBuckets(dayKeys, buckets, (bucket) => Number(bucket.score_count) || 0)
  return dayKeys.map((day) => {
    const bucket = byDay.get(day)
    score += bucket ? Number(bucket.score_total) || 0 : 0
    count += bucket ? Number(bucket.score_count) || 0 : 0
    return count ? Math.round(score / count) : 0
  })
}

export function userCanManageJob(jobId: string, user: AuthUser): boolean {
  if (user.role === 'admin') return jobExistsReadable(jobId)
  const row = getDatabase().prepare(`
    SELECT project_members.role AS role
    FROM analysis_jobs
    INNER JOIN report_versions ON report_versions.id = analysis_jobs.report_version_id
    LEFT JOIN project_members ON project_members.project_id = report_versions.project_id AND project_members.user_id = ?
    WHERE analysis_jobs.id = ?
  `).get(user.id, jobId) as { role?: string } | undefined
  return row ? manageProjectRoles.has(row.role as ProjectMemberRole) : false
}

/** 全员只读设计：报告存在即可读，写操作走 userCanManageProject。 */
export function reportExistsReadable(reportId: string): boolean {
  return Boolean(getDatabase().prepare('SELECT 1 FROM report_versions WHERE id = ?').get(reportId))
}

export function jobExistsReadable(jobId: string): boolean {
  return Boolean(getDatabase().prepare('SELECT 1 FROM analysis_jobs WHERE id = ?').get(jobId))
}

/** 规范化创建课题时附带的初始里程碑，丢弃空标题并补齐默认状态。 */
function normalizeInitialMilestones(milestones?: Milestone[]): Milestone[] {
  if (!Array.isArray(milestones)) return []
  return milestones
    .map((milestone, index) => ({
      ...milestone,
      id: typeof milestone.id === 'string' && milestone.id.trim() ? milestone.id : `stage-${index + 1}`,
      title: typeof milestone.title === 'string' ? milestone.title.trim() : '',
      status: 'not_started' as const,
    }))
    .filter((milestone) => milestone.title.length > 0)
}

function parseMilestones(value: string): Milestone[] {
  const parsed = parseJson<unknown>(value)
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((item): Milestone[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const raw = item as Record<string, unknown>
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    const title = typeof raw.title === 'string' ? raw.title.trim() : ''
    if (!id || !title) return []
    const status: ProjectProgressStatus = raw.status === 'in_progress' || raw.status === 'at_risk' || raw.status === 'completed'
      ? raw.status
      : 'not_started'
    const reportIds = Array.isArray(raw.reportIds)
      ? [...new Set(raw.reportIds.filter((reportId): reportId is string => typeof reportId === 'string' && Boolean(reportId.trim())).map((reportId) => reportId.trim()))]
      : undefined
    return [{
      id,
      title,
      targetDate: typeof raw.targetDate === 'string' ? raw.targetDate : undefined,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      status,
      reportIds,
    }]
  })
}

function deriveProjectState(milestones: Milestone[]): { status: ProjectProgressStatus; stage: ProjectStage } {
  if (!milestones.length) return { status: 'not_started', stage: '开题中' }
  if (milestones.every((milestone) => milestone.status === 'completed')) return { status: 'completed', stage: '已完成' }

  const currentMilestone = milestones.find((milestone) => milestone.status === 'in_progress' || milestone.status === 'at_risk')
    ?? milestones.find((milestone) => milestone.status !== 'completed')
  const status: ProjectProgressStatus = milestones.some((milestone) => milestone.status === 'at_risk')
    ? 'at_risk'
    : milestones.some((milestone) => milestone.status === 'in_progress' || milestone.status === 'completed')
      ? 'in_progress'
      : 'not_started'
  const title = currentMilestone?.title ?? ''
  const stage: ProjectStage = title.includes('开题') || title.includes('立项')
    ? '开题中'
    : title.includes('调研')
      ? '调研中'
      : '推进中'
  return { status, stage }
}

function createProjectRecord(input: CreateProjectInput, ownerId: string): Project {
  const timestamp = now()
  const { milestones, ...rest } = input
  const normalizedMilestones = normalizeInitialMilestones(milestones)
  const projectState = deriveProjectState(normalizedMilestones)
  const id = newId('project')
  return {
    ...rest,
    ownerId,
    id,
    status: projectState.status,
    stage: projectState.stage,
    milestones: normalizedMilestones,
    isExample: isExplicitExampleProject(id),
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function insertProject(database: ReturnType<typeof getDatabase>, project: Project) {
  database.prepare(`
    INSERT INTO projects (
      id, title, objective, description, owner_name, status, stage, milestones_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    project.id,
    project.title,
    project.objective,
    project.description,
    project.ownerName,
    project.status,
    project.stage ?? '开题中',
    json(project.milestones),
    project.createdAt,
    project.updatedAt,
  )
}

export async function deleteProject(projectId: string, actor?: AuthUser) {
  const paths = inImmediateTransaction((database) => {
    const project = database.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)
    if (!project) return undefined
    if (actor && !userCanDeleteProjectInDatabase(database, projectId, actor)) throw new ReportAuthorizationChangedError()
    const timestamp = now()
    const sourcePaths = (database.prepare('SELECT source_path FROM report_versions WHERE project_id = ?').all(projectId) as Array<{ source_path: string }>).map((row) => row.source_path)
    const reportIds = database.prepare('SELECT id FROM report_versions WHERE project_id = ?').all(projectId) as Array<{ id: string }>
    for (const report of reportIds) releaseStorageAllocationInDatabase(database, 'report', report.id)
    const reportJobs = database.prepare('SELECT id FROM analysis_jobs WHERE report_version_id IN (SELECT id FROM report_versions WHERE project_id = ?)').all(projectId) as Array<{ id: string }>
    for (const reportJob of reportJobs) reconcileAiBudgetForJobInDatabase(database, reportJob.id, 'project_deleted')
    database.prepare(`
      UPDATE ai_budget_ledger
      SET state = 'uncertain', uncertain_at = COALESCE(uncertain_at, ?), reconciliation_reason = 'project_deleted_insight', updated_at = ?
      WHERE report_version_id IN (SELECT id FROM report_versions WHERE project_id = ?) AND job_id IS NULL AND state = 'reserved'
    `).run(timestamp, timestamp, projectId)
    database.prepare(`
      UPDATE analysis_jobs
      SET cancel_requested = 1,
          status = CASE WHEN status IN ('queued', 'running') THEN 'cancelled' ELSE status END,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ?
      WHERE report_version_id IN (SELECT id FROM report_versions WHERE project_id = ?)
    `).run(timestamp, projectId)
    database.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
    return sourcePaths
  })
  if (!paths) return false
  const cleanupTargets = Array.from(new Set(paths.map(reportCleanupTarget).filter((target): target is string => Boolean(target))))
  const cleanupResults = await Promise.allSettled(cleanupTargets.map((target) => rm(target, { recursive: true, force: true })))
  for (const [index, outcome] of cleanupResults.entries()) {
    if (outcome.status === 'rejected') {
      console.error('课题文件清理失败：', cleanupTargets[index], outcome.reason)
    }
  }
  return true
}

function reportCleanupTarget(sourcePath: string) {
  const path = resolve(sourcePath)
  if (!isPathWithinRoot(reportStorageRoot, path)) return undefined

  const directory = dirname(path)
  return directory === reportStorageRoot ? path : directory
}

export class ReportHistoryPolicyConflictError extends Error {
  constructor(readonly action: 'delete' | 'replace') {
    super(action === 'delete'
      ? '仅最新办结阶段的报告可以删除；历史办结阶段请使用替换报告。'
      : '仅历史办结阶段的报告可以替换。')
    this.name = 'ReportHistoryPolicyConflictError'
  }
}

function reportHistoryPolicyAllows(
  database: ReturnType<typeof getDatabase>,
  reportId: string,
  action: 'delete' | 'replace',
) {
  const reportRow = database.prepare('SELECT * FROM report_versions WHERE id = ?').get(reportId) as Record<string, unknown> | undefined
  if (!reportRow) return false
  const projectRow = database.prepare('SELECT milestones_json FROM projects WHERE id = ?').get(text(reportRow.project_id)) as { milestones_json?: string } | undefined
  if (!projectRow) return false
  const report = reportFromRow(reportRow)
  const reports = (database.prepare('SELECT * FROM report_versions WHERE project_id = ? ORDER BY version DESC').all(report.projectId) as Array<Record<string, unknown>>)
    .map((row) => reportFromRow(row))
  const milestones = projectRow.milestones_json ? parseMilestones(projectRow.milestones_json) : []
  return action === 'delete'
    ? canDeleteReportFromHistory(report, milestones, reports)
    : canReplaceReportFromHistory(report, milestones, reports)
}

export async function deleteReportVersion(reportId: string, options: { enforceHistoryPolicy?: boolean; actor?: AuthUser } = {}) {
  const deleted = inImmediateTransaction((database) => {
    const report = database.prepare(`
      SELECT id, project_id, version, source_path
      FROM report_versions
      WHERE id = ?
    `).get(reportId) as { id: string; project_id: string; version: number; source_path: string } | undefined
    if (!report) return undefined
    if (options.actor && !userCanDeleteProjectInDatabase(database, report.project_id, options.actor)) throw new ReportAuthorizationChangedError()
    if (options.enforceHistoryPolicy && !reportHistoryPolicyAllows(database, reportId, 'delete')) {
      throw new ReportHistoryPolicyConflictError('delete')
    }

    const timestamp = now()
    database.prepare('DELETE FROM report_insight_reservations WHERE lease_expires_at <= ?').run(timestamp)
    const activeInsight = database.prepare(`
      SELECT 1
      FROM report_insight_reservations
      WHERE report_version_id = ? AND lease_expires_at > ?
      LIMIT 1
    `).get(reportId, timestamp)
    const activeInsightJob = database.prepare(`
      SELECT 1
      FROM analysis_jobs
      WHERE report_version_id = ? AND type = 'insight' AND status IN ('queued', 'running')
      LIMIT 1
    `).get(reportId)
    if (activeInsight || activeInsightJob) throw new ReportInsightInProgressError()

    const previous = database.prepare(`
      SELECT id, character_count
      FROM report_versions
      WHERE project_id = ? AND version < ?
      ORDER BY version DESC
      LIMIT 1
    `).get(report.project_id, report.version) as { id: string; character_count: number } | undefined
    const reportJobs = database.prepare('SELECT id FROM analysis_jobs WHERE report_version_id = ?').all(reportId) as Array<{ id: string }>
    for (const reportJob of reportJobs) reconcileAiBudgetForJobInDatabase(database, reportJob.id, 'report_deleted')
    database.prepare(`
      UPDATE ai_budget_ledger
      SET state = 'uncertain', uncertain_at = COALESCE(uncertain_at, ?), reconciliation_reason = 'report_deleted_insight', updated_at = ?
      WHERE report_version_id = ? AND job_id IS NULL AND state = 'reserved'
    `).run(timestamp, timestamp, reportId)

    database.prepare(`
      UPDATE analysis_jobs
      SET cancel_requested = 1,
          status = CASE WHEN status IN ('queued', 'running') THEN 'cancelled' ELSE status END,
          last_error_code = CASE WHEN status IN ('queued', 'running') THEN 'report_deleted' ELSE last_error_code END,
          last_error_at = CASE WHEN status IN ('queued', 'running') THEN ? ELSE last_error_at END,
          terminal_reason = CASE WHEN status IN ('queued', 'running') THEN 'report_deleted' ELSE terminal_reason END,
          terminal_at = CASE WHEN status IN ('queued', 'running') THEN ? ELSE terminal_at END,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ?
      WHERE report_version_id = ?
    `).run(timestamp, timestamp, timestamp, reportId)
    database.prepare(`
      UPDATE report_versions
      SET previous_version_id = ?, previous_character_count = ?
      WHERE project_id = ? AND previous_version_id = ?
    `).run(previous?.id ?? null, previous?.character_count ?? null, report.project_id, reportId)
    releaseStorageAllocationInDatabase(database, 'report', reportId)
    database.prepare('DELETE FROM report_versions WHERE id = ?').run(reportId)
    const projectRow = database.prepare('SELECT milestones_json FROM projects WHERE id = ?').get(report.project_id) as { milestones_json?: string } | undefined
    const milestones = projectRow?.milestones_json ? parseMilestones(projectRow.milestones_json) : []
    const cleanedMilestones = milestones.map((milestone) => ({
      ...milestone,
      reportIds: (milestone.reportIds ?? []).filter((id) => id !== reportId),
    }))
    const remainingReports = database.prepare(
      'SELECT milestone_id AS milestoneId, delivery_type AS deliveryType FROM report_versions WHERE project_id = ?',
    ).all(report.project_id) as Array<{ milestoneId?: string | null; deliveryType?: ReportDeliveryType | null }>
    const reconciledMilestones = reconcileMilestonesAfterReportDeletion(cleanedMilestones, remainingReports)
    const projectState = deriveProjectState(reconciledMilestones)
    database.prepare('UPDATE projects SET milestones_json = ?, stage = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(json(reconciledMilestones), projectState.stage, projectState.status, timestamp, report.project_id)

    return { projectId: report.project_id, sourcePath: report.source_path }
  })
  if (!deleted) return false
  const cleanupTarget = reportCleanupTarget(deleted.sourcePath)
  if (cleanupTarget) await rm(cleanupTarget, { recursive: true, force: true }).catch((error: unknown) => {
    console.error('报告文件清理失败：', cleanupTarget, error)
  })
  return true
}

export async function replaceReportVersionSource(
  reportId: string,
  fileName: string,
  source: ReportSource,
  options: { enforceHistoryPolicy?: boolean; actor?: AuthUser; storageReservationId?: string } = {},
) {
  const promptSettings = getAiPromptSettingsSnapshot()
  const replaced = inImmediateTransaction((database) => {
    const row = database.prepare('SELECT * FROM report_versions WHERE id = ?').get(reportId) as Record<string, unknown> | undefined
    if (!row) return undefined
    if (options.actor && !userCanManageProjectInDatabase(database, text(row.project_id), options.actor)) throw new ReportAuthorizationChangedError()
    if (options.enforceHistoryPolicy && !reportHistoryPolicyAllows(database, reportId, 'replace')) {
      throw new ReportHistoryPolicyConflictError('replace')
    }

    if (text(row.file_hash) === source.sha256) throw new DuplicateReportError(reportFromRow(row))
    const duplicateRow = database.prepare('SELECT * FROM report_versions WHERE project_id = ? AND file_hash = ? AND id != ?')
      .get(text(row.project_id), source.sha256, reportId) as Record<string, unknown> | undefined
    if (duplicateRow) throw new DuplicateReportError(reportFromRow(duplicateRow))

    const activeJob = database.prepare("SELECT 1 FROM analysis_jobs WHERE report_version_id = ? AND status IN ('queued', 'running') LIMIT 1").get(reportId)
    const activeInsight = database.prepare('SELECT 1 FROM report_insight_reservations WHERE report_version_id = ? AND lease_expires_at > ? LIMIT 1').get(reportId, now())
    if (activeJob || activeInsight) throw new ReportReplacementBusyError()

    // 正文内容已经变化；洞察属于旧正文，不能沿用到新的报告内容。
    database.prepare('DELETE FROM report_insights WHERE report_version_id = ?').run(reportId)
    database.prepare('DELETE FROM report_insight_reservations WHERE report_version_id = ?').run(reportId)

    const evaluationContextResolution = resolveStoredReportEvaluationContext(reportId)
    if (evaluationContextResolution.issue) throw new Error(evaluationContextResolution.issue.message)
    const previousSourcePath = text(row.source_path)
    const timestamp = now()
    // 替换正文会使无 job 绑定的报告洞察预留失效；
    // 其 provider 结果未知时必须保留为 uncertain，不能让旧账本无限期占用 reserved。
    database.prepare(`
      UPDATE ai_budget_ledger
      SET state = 'uncertain', uncertain_at = COALESCE(uncertain_at, ?),
          reconciliation_reason = 'report_replaced_insight', updated_at = ?
      WHERE report_version_id = ? AND operation = 'insight' AND job_id IS NULL AND state = 'reserved'
    `).run(timestamp, timestamp, reportId)
    database.prepare(`
      UPDATE report_versions
      SET title = ?, file_name = ?, file_hash = ?, source_path = ?, mime_type = ?, source_size = ?,
          paragraph_count = 0, character_count = 0, parse_status = 'uploaded', current_analysis_id = NULL,
          parse_error = NULL, source_updated_at = ?
      WHERE id = ?
    `).run(
      fileName.replace(/\.(docx|pdf)$/i, '') || '未命名研究报告',
      fileName,
      source.sha256,
      source.path,
      source.mimeType,
      source.size,
      timestamp,
      reportId,
    )
    const oldJobs = database.prepare('SELECT id FROM analysis_jobs WHERE report_version_id = ?').all(reportId) as Array<{ id: string }>
    for (const oldJob of oldJobs) reconcileAiBudgetForJobInDatabase(database, oldJob.id, 'report_replaced')
    database.prepare('DELETE FROM analysis_jobs WHERE report_version_id = ?').run(reportId)

    if (options.storageReservationId) {
      if (!options.actor) throw new Error('存储预留缺少上传者。')
      releaseStorageAllocationInDatabase(database, 'report', reportId)
      consumeStorageReservationInDatabase(database, options.storageReservationId, {
        ownerType: 'report', ownerId: reportId, userId: options.actor.id, projectId: text(row.project_id),
        sizeBytes: source.size, fileHash: source.sha256, sourcePath: source.path, mimeType: source.mimeType,
      })
    }
    const updatedRow = database.prepare('SELECT * FROM report_versions WHERE id = ?').get(reportId) as Record<string, unknown>
    const report = reportFromRow(updatedRow)
    database.prepare('INSERT OR REPLACE INTO report_facts(report_version_id, payload_json, updated_at) VALUES (?, ?, ?)')
      .run(reportId, json(createReportFacts(report)), timestamp)
    const job = createJobRecord(reportId, 'initial', timestamp, undefined, options.actor)
    insertJob(database, job, promptSettings, evaluationContextResolution.context)
    insertInitialModuleStates(database, job.id, timestamp)
    insertJobEvent(database, job.id, { type: 'info', message: '替换文件已归档，任务进入持久化队列。' }, timestamp)

    return { previousSourcePath, job, report }
  })
  if (!replaced) return undefined

  const cleanupTarget = reportCleanupTarget(replaced.previousSourcePath)
  if (cleanupTarget && cleanupTarget !== reportCleanupTarget(source.path)) {
    await rm(cleanupTarget, { recursive: true, force: true }).catch(() => undefined)
  }
  return { report: replaced.report, job: replaced.job }
}

export function listProjectReportStageRefs(projectId: string): Array<{
  id: string
  milestoneId?: string
  deliveryType?: ReportDeliveryType
}> {
  return rows(`
    SELECT id, milestone_id, delivery_type
    FROM report_versions
    WHERE project_id = ?
    ORDER BY version DESC
  `, projectId).map((row) => ({
    id: text(row.id),
    milestoneId: nullableText(row.milestone_id),
    deliveryType: nullableText(row.delivery_type) as ReportDeliveryType | undefined,
  }))
}

export function listReports(projectId: string, pagination?: ListPagination): ReportVersion[] {
  const suffix = pagination ? ' LIMIT ? OFFSET ?' : ''
  const parameters: Array<string | number> = [projectId]
  if (pagination) parameters.push(pagination.limit, pagination.offset)
  const result = rows(`
    SELECT report_versions.*, ${latestFullJobStatusSql()} AS latest_job_status
    FROM report_versions
    WHERE project_id = ?
    ORDER BY version DESC${suffix}
  `, ...parameters)
  const decorations = loadReportDecorations(result.map((row) => text(row.id)))
  return result.map((row) => reportFromRow(row, decorations))
}

export function countReports(projectId: string): number {
  const row = getDatabase().prepare('SELECT COUNT(*) AS count FROM report_versions WHERE project_id = ?').get(projectId)
  return integer((row as { count?: unknown } | undefined)?.count)
}

export function listReportHistory(projectId: string, pagination: ListPagination): ReportHistoryEntry[] {
  const historyRows = rows(`
    SELECT report_versions.*,
      ${publishedMetricSql('current_snapshot.payload_json', '$.aiScore')} AS analysis_ai_score,
      ${publishedMetricSql('current_snapshot.payload_json', '$.reportCompleteness')} AS analysis_completeness,
      ${latestFullJobStatusSql()} AS latest_job_status
    FROM report_versions
    ${canonicalCurrentSnapshotJoin('current_snapshot', 'report_versions')}
    WHERE report_versions.project_id = ?
    ORDER BY report_versions.version DESC
    LIMIT ? OFFSET ?
  `, projectId, pagination.limit, pagination.offset)
  const decorations = loadReportDecorations(historyRows.map((row) => text(row.id)))
  return historyRows.map((row) => {
    return {
      report: reportFromRow(row, decorations),
      aiScore: readPublishedOverallValue(row.analysis_ai_score),
      completeness: readPublishedOverallValue(row.analysis_completeness),
    }
  })
}

function assertLatestReportVersionInDatabase(database: ReturnType<typeof getDatabase>, reportId: string) {
  const row = database.prepare(`SELECT report_versions.id, report_versions.project_id, report_versions.version = (SELECT MAX(latest.version) FROM report_versions latest WHERE latest.project_id = report_versions.project_id) AS is_latest FROM report_versions WHERE report_versions.id = ?`).get(reportId) as { id?: string; project_id?: string; is_latest?: number } | undefined
  if (!row) throw new Error('报告版本不存在。')
  if (!row.is_latest) throw new Error('历史报告版本不可执行此操作。')
  return row
}

export function getReport(reportId: string): ReportVersion | undefined {
  return optionalRow(`
    SELECT report_versions.*
    FROM report_versions
    WHERE id = ?
  `, reportId, reportFromRow)
}

export function getReportDetail(reportId: string): { report: ReportVersion; snapshot: ReturnType<typeof getCurrentSnapshot> } | undefined {
  const row = getDatabase().prepare('SELECT * FROM report_versions WHERE id = ?').get(reportId) as Record<string, unknown> | undefined
  if (!row) return undefined
  const snapshot = getCurrentSnapshot(reportId)
  const decorations: ReportRowDecorations = { fullAnalysisDone: snapshot ? new Set([reportId]) : new Set() }
  return { report: reportFromRow(row, decorations), snapshot }
}

/** 洞察入队/Worker只需正文版本身份，避免为洞察路径读取完整分析快照。 */
export function getReportIdentity(reportId: string): { id: string; projectId: string } | undefined {
  const row = getDatabase().prepare('SELECT id, project_id FROM report_versions WHERE id = ?').get(reportId) as { id?: unknown; project_id?: unknown } | undefined
  if (!row?.id || !row.project_id) return undefined
  return { id: String(row.id), projectId: String(row.project_id) }
}

export function resolveStoredReportEvaluationContext(reportVersionId: string) {
  const report = getReport(reportVersionId)
  const project = report ? getProject(report.projectId) : undefined
  return resolveReportEvaluationContext(project, report)
}

function persistProjectMilestonesFromDeliveries(
  database: ReturnType<typeof getDatabase>,
  projectId: string,
  milestones: Milestone[],
  timestamp: string,
) {
  const remaining = database.prepare(
    'SELECT milestone_id, delivery_type FROM report_versions WHERE project_id = ?',
  ).all(projectId) as Array<{ milestone_id?: string | null; delivery_type?: string | null }>
  const nextMilestones = completeMilestonesWhenFinalRemains(
    milestones,
    remaining.map((row) => ({
      milestoneId: row.milestone_id,
      deliveryType: row.delivery_type === 'final' || row.delivery_type === 'stage' ? row.delivery_type : undefined,
    })),
  )
  const projectState = deriveProjectState(nextMilestones)
  database.prepare('UPDATE projects SET milestones_json = ?, stage = ?, status = ?, updated_at = ? WHERE id = ?')
    .run(json(nextMilestones), projectState.stage, projectState.status, timestamp, projectId)
}

export function assignReportMilestone(
  reportId: string,
  milestoneId: string,
  deliveryType: ReportDeliveryType = 'stage',
  actor?: AuthUser,
): ReportVersion | undefined {
  const updated = inImmediateTransaction((database) => {
    const reportRow = database.prepare('SELECT project_id, milestone_id, delivery_type FROM report_versions WHERE id = ?').get(reportId) as { project_id?: string; milestone_id?: string | null; delivery_type?: string | null } | undefined
    if (!reportRow?.project_id) return false
    if (actor && !userCanManageProjectInDatabase(database, reportRow.project_id, actor)) throw new ReportAuthorizationChangedError()
    if (findActiveAnalysisJobForReport(database, reportId)) throw new ReportAnalysisInProgressError()
    const timestamp = now()
    const projectRow = database.prepare('SELECT milestones_json FROM projects WHERE id = ?').get(reportRow.project_id) as { milestones_json?: string } | undefined
    const milestones = projectRow?.milestones_json ? parseMilestones(projectRow.milestones_json) : []
    const { milestones: normalizedMilestones, targetMilestoneId } = applyReportDeliveryToMilestones(
      milestones,
      reportId,
      milestoneId,
      deliveryType,
    )
    const contextChanged = reportRow.milestone_id !== targetMilestoneId || reportRow.delivery_type !== deliveryType
    database.prepare('UPDATE report_versions SET milestone_id = ?, delivery_type = ?, current_analysis_id = CASE WHEN ? THEN NULL ELSE current_analysis_id END WHERE id = ?')
      .run(targetMilestoneId, deliveryType, contextChanged ? 1 : 0, reportId)
    persistProjectMilestonesFromDeliveries(database, reportRow.project_id, normalizedMilestones, timestamp)
    return true
  })
  return updated ? getReport(reportId) : undefined
}

export function getReportSource(reportVersionId: string): ReportSource | undefined {
  const row = getDatabase().prepare(`
    SELECT source_path, file_name, mime_type, source_size, file_hash
    FROM report_versions
    WHERE id = ?
  `).get(reportVersionId) as Record<string, unknown> | undefined
  if (!row) return undefined
  return {
    path: text(row.source_path),
    fileName: text(row.file_name),
    mimeType: text(row.mime_type),
    size: integer(row.source_size),
    sha256: text(row.file_hash),
  }
}

export class ReportAuthorizationChangedError extends Error {
  constructor() {
    super('项目权限已变更，请刷新后重试。')
    this.name = 'ReportAuthorizationChangedError'
  }
}

export class ReportEvaluationContextChangedError extends Error {
  constructor() {
    super('课题评价背景已变化，请刷新后重试。')
    this.name = 'ReportEvaluationContextChangedError'
  }
}

function userCanDeleteProjectInDatabase(database: ReturnType<typeof getDatabase>, projectId: string, user: AuthUser) {
  return Boolean(database.prepare(`
    SELECT 1
    FROM users
    INNER JOIN projects ON projects.id = ?
    WHERE users.id = ? AND users.status = 'active'
      AND (users.role = 'admin' OR EXISTS (
        SELECT 1 FROM project_members
        WHERE project_members.project_id = projects.id
          AND project_members.user_id = users.id
          AND project_members.role = 'owner'
      ))
    LIMIT 1
  `).get(projectId, user.id))
}

function userCanManageProjectInDatabase(database: ReturnType<typeof getDatabase>, projectId: string, user: AuthUser) {
  return Boolean(database.prepare(`
    SELECT 1
    FROM users
    INNER JOIN projects ON projects.id = ?
    LEFT JOIN project_members ON project_members.project_id = projects.id AND project_members.user_id = users.id
    WHERE users.id = ? AND users.status = 'active'
      AND (users.role = 'admin' OR project_members.role IN ('owner', 'editor'))
    LIMIT 1
  `).get(projectId, user.id))
}

export interface CreateReportJobInput {
  projectId: string
  fileName: string
  source: ReportSource
  reportId?: string
  milestoneId?: string
  autoAnalyze?: boolean
  deliveryType?: ReportDeliveryType
  actor?: AuthUser
  storageReservationId?: string
}

type CreateReportJobWithAnalysis = Omit<CreateReportJobInput, 'autoAnalyze'> & { autoAnalyze?: true }
type CreateReportJobWithoutAnalysis = Omit<CreateReportJobInput, 'autoAnalyze'> & { autoAnalyze: false }

export function createReportJob(input: CreateReportJobWithAnalysis): { report: ReportVersion; job: AnalysisJob }
export function createReportJob(input: CreateReportJobWithoutAnalysis): { report: ReportVersion; job: undefined }
export function createReportJob(input: CreateReportJobInput): { report: ReportVersion; job?: AnalysisJob }
export function createReportJob({
  projectId,
  fileName,
  source,
  reportId = newId('report'),
  milestoneId,
  autoAnalyze = true,
  deliveryType,
  actor,
  storageReservationId,
}: CreateReportJobInput): { report: ReportVersion; job?: AnalysisJob } {
  return inImmediateTransaction((database) => {
    const projectRow = database.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, unknown> | undefined
    if (!projectRow) throw new Error('Project not found')
    if (actor && !userCanManageProjectInDatabase(database, projectId, actor)) throw new ReportAuthorizationChangedError()

    const duplicateRow = database.prepare('SELECT * FROM report_versions WHERE project_id = ? AND file_hash = ?').get(projectId, source.sha256) as Record<string, unknown> | undefined
    if (duplicateRow) throw new DuplicateReportError(reportFromRow(duplicateRow))

    const rawMilestones = parseMilestones(text(projectRow.milestones_json))
    const delivery = milestoneId ? (deliveryType === 'final' ? 'final' : 'stage') : undefined
    const selectedMilestoneId = milestoneId && delivery
      ? resolveDeliveryMilestoneId(rawMilestones, milestoneId, delivery)
      : undefined

    const previousRow = database.prepare('SELECT * FROM report_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(projectId) as Record<string, unknown> | undefined
    const previous = previousRow ? reportFromRow(previousRow) : undefined
    const timestamp = now()
    const report: ReportVersion = {
      id: reportId,
      projectId,
      milestoneId: selectedMilestoneId,
      deliveryType: delivery,
      version: (previous?.version ?? 0) + 1,
      title: fileName.replace(/\.(docx|pdf)$/i, '') || '未命名研究报告',
      fileName,
      fileHash: source.sha256,
      paragraphCount: 0,
      characterCount: 0,
      parseStatus: 'uploaded',
      createdAt: timestamp,
      sourceUpdatedAt: timestamp,
      previousVersionId: previous?.id,
      previousCharacterCount: previous?.characterCount,
    }

    database.prepare(`
      INSERT INTO report_versions (
        id, project_id, milestone_id, delivery_type, version, title, file_name, file_hash, source_path, mime_type, source_size,
        paragraph_count, character_count, previous_character_count, parse_status, current_analysis_id,
        previous_version_id, parse_error, created_at, source_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'uploaded', NULL, ?, NULL, ?, ?)
    `).run(
      report.id,
      projectId,
      report.milestoneId ?? null,
      report.deliveryType ?? null,
      report.version,
      report.title,
      report.fileName,
      report.fileHash,
      source.path,
      source.mimeType,
      source.size,
      report.previousCharacterCount ?? null,
      report.previousVersionId ?? null,
      timestamp,
      timestamp,
    )
    if (storageReservationId) {
      if (!actor) throw new Error('存储预留缺少上传者。')
      consumeStorageReservationInDatabase(database, storageReservationId, {
        ownerType: 'report', ownerId: report.id, userId: actor.id, projectId,
        sizeBytes: source.size, fileHash: source.sha256, sourcePath: source.path, mimeType: source.mimeType,
      })
    }

    let jobRecord: ReturnType<typeof createJobRecord> | undefined = undefined
    if (autoAnalyze) {
      jobRecord = createJobRecord(report.id, 'initial', timestamp, undefined, actor)
      const evaluationContextResolution = resolveStoredReportEvaluationContext(report.id)
      if (evaluationContextResolution.issue) throw new Error(evaluationContextResolution.issue.message)
      const promptSettings = getAiPromptSettingsSnapshot()
      insertJob(database, jobRecord, promptSettings, evaluationContextResolution.context)
      insertInitialModuleStates(database, jobRecord.id, timestamp)
      insertJobEvent(database, jobRecord.id, { type: 'info', message: '任务已进入持久化队列，等待 Worker 领取。' }, timestamp)
    }

    const facts = createReportFacts(report)
    database.prepare('INSERT INTO report_facts(report_version_id, payload_json, updated_at) VALUES (?, ?, ?)').run(report.id, json(facts), timestamp)

    if (selectedMilestoneId && delivery) {
      const { milestones: updatedMilestones } = applyReportDeliveryToMilestones(
        rawMilestones,
        report.id,
        selectedMilestoneId,
        delivery,
      )
      persistProjectMilestonesFromDeliveries(database, projectId, updatedMilestones, timestamp)
    }

    return { report, job: jobRecord }
  })
}

function reportHasCompletedFullAnalysis(reportVersionId: string): boolean {
  return Boolean(getCurrentSnapshot(reportVersionId))
}

export function startReportAnalysis(reportId: string, actor?: AuthUser): { job: AnalysisJob; moduleStates: AnalysisModuleState[] } | undefined {
  const latestJob = getLatestJobForReport(reportId)
  // 有 actor 时跳过事务外的 active-job 快路径，统一在下面的事务内重验授权。
  if (latestJob && ['queued', 'running'].includes(latestJob.status) && !actor) {
    return {
      job: latestJob,
      moduleStates: listModuleStates(latestJob.id),
    }
  }

  const latestFullJobRow = getDatabase().prepare(`
    SELECT analysis_jobs.*
    FROM analysis_jobs
    WHERE report_version_id = ?
      AND type IN ('initial', 'rerun')
      AND EXISTS (SELECT 1 FROM analysis_module_states state WHERE state.job_id = analysis_jobs.id)
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(reportId) as Record<string, unknown> | undefined
  const latestFullJob = latestFullJobRow ? jobFromRow(latestFullJobRow) : undefined
  const latestEvaluationContext = latestFullJob
    ? parseReportEvaluationContext(latestFullJobRow?.evaluation_context_json)
    : undefined
  const currentEvaluationContext = latestFullJob ? resolveStoredReportEvaluationContext(reportId).context : undefined
  // 没有旧完整任务时允许新建；有旧任务但冻结背景损坏/缺失时必须开启新 epoch，不能复用旧快照。
  const latestJobMatchesCurrentEpoch = !latestFullJob
    || Boolean(latestEvaluationContext && currentEvaluationContext
      && evaluationContextsEqual(latestEvaluationContext, currentEvaluationContext))
  const hasValidCurrentFinalSnapshot = reportHasCompletedFullAnalysis(reportId)
  const startsNewEvaluationEpoch = !hasValidCurrentFinalSnapshot || !latestJobMatchesCurrentEpoch
  if (!startsNewEvaluationEpoch && latestFullJob && terminalJobStatuses.has(latestFullJob.status)) {
    const retryJob = createRetryJob(latestFullJob.id, actor)
    return retryJob
      ? { job: retryJob, moduleStates: listModuleStates(retryJob.id) }
      : undefined
  }

  // 没有可用 final snapshot 时必须创建新的分析 epoch；不要把旧终态任务的评价背景
  // 当成新任务的冻结背景，事务内会重新读取当前课题背景。
  const evaluationContext = startsNewEvaluationEpoch
    ? undefined
    : currentEvaluationContext ?? resolveStoredReportEvaluationContext(reportId).context
  return inImmediateTransaction((database) => {
    const reportRow = database.prepare('SELECT * FROM report_versions WHERE id = ?').get(reportId) as Record<string, unknown> | undefined
    if (!reportRow) return undefined
    assertLatestReportVersionInDatabase(database, reportId)
    if (actor && !userCanManageProjectInDatabase(database, text(reportRow.project_id), actor)) throw new ReportAuthorizationChangedError()
    const active = findActiveAnalysisJobForReport(database, reportId)
    if (active) return { job: active, moduleStates: listModuleStates(active.id) }

    const transactionalEvaluationContext = resolveStoredReportEvaluationContext(reportId).context
    if (evaluationContext && transactionalEvaluationContext
      && !evaluationContextsEqual(evaluationContext, transactionalEvaluationContext)) {
      throw new ReportEvaluationContextChangedError()
    }
    const timestamp = now()
    const jobRecord = createJobRecord(reportId, 'initial', timestamp, undefined, actor)
    const promptSettings = getAiPromptSettingsSnapshot()
    insertJob(database, jobRecord, promptSettings, transactionalEvaluationContext ?? evaluationContext)
    insertInitialModuleStates(database, jobRecord.id, timestamp)
    insertJobEvent(database, jobRecord.id, { type: 'info', message: '任务已进入持久化队列，等待 Worker 领取。' }, timestamp)
    return {
      job: jobRecord,
      moduleStates: listModuleStates(jobRecord.id),
    }
  })
}

export async function removeStoredReportFile(source: ReportSource) {
  const cleanupTarget = reportCleanupTarget(source.path)
  if (cleanupTarget) await rm(cleanupTarget, { recursive: true, force: true })
}

function saveAiReportFactsInDatabase(
  database: ReturnType<typeof getDatabase>,
  reportVersionId: string,
  facts: ReportFacts,
  leaseOwner?: string,
) {
  const reportRow = database.prepare('SELECT * FROM report_versions WHERE id = ?').get(reportVersionId) as Record<string, unknown> | undefined
  if (!reportRow) return undefined
  const report = reportFromRow(reportRow)
  if (leaseOwner && !hasActiveJobLease(database, reportVersionId, leaseOwner)) return undefined
  const updatedAt = now()
  const updatedFacts: ReportFacts = {
    title: facts.title,
    paragraphCount: facts.paragraphCount,
    characterCount: facts.characterCount,
  }
  database.prepare('UPDATE report_facts SET payload_json = ?, updated_at = ? WHERE report_version_id = ?').run(json(updatedFacts), updatedAt, reportVersionId)
  database.prepare(`
    UPDATE report_versions
    SET title = ?, paragraph_count = ?, character_count = ?, parse_status = 'ready', parse_error = NULL
    WHERE id = ?
  `).run(updatedFacts.title, updatedFacts.paragraphCount, updatedFacts.characterCount, reportVersionId)
  return { ...report, title: updatedFacts.title, paragraphCount: updatedFacts.paragraphCount, characterCount: updatedFacts.characterCount, parseStatus: 'ready' as const, parseError: undefined }
}

export function saveAiReportFacts(reportVersionId: string, facts: ReportFacts, leaseOwner?: string) {
  return inImmediateTransaction((database) => saveAiReportFactsInDatabase(database, reportVersionId, facts, leaseOwner))
}

export function markReportParsingFailed(reportVersionId: string, message: string, leaseOwner?: string) {
  const database = getDatabase()
  const result = database.prepare(`
    UPDATE report_versions
    SET parse_status = 'failed', parse_error = ?
    WHERE id = ?
      AND EXISTS (
        SELECT 1 FROM analysis_jobs
        WHERE report_version_id = report_versions.id
          AND type IN ('initial', 'rerun')
      )
      AND (
        ? IS NULL
        OR EXISTS (
          SELECT 1 FROM analysis_jobs
          WHERE report_version_id = report_versions.id
            AND type IN ('initial', 'rerun')
            AND lease_owner = ?
            AND status = 'running'
            AND cancel_requested = 0
            AND lease_expires_at > ?
        )
      )
  `).run(message, reportVersionId, leaseOwner ?? null, leaseOwner ?? null, now())
  return Number(result.changes) === 1 ? getReport(reportVersionId) : undefined
}

export function getReportFacts(reportVersionId: string): ReportFacts {
  const report = getReport(reportVersionId)
  if (!report) throw new Error('Report not found')
  const row = getDatabase().prepare('SELECT payload_json FROM report_facts WHERE report_version_id = ?').get(reportVersionId) as { payload_json: string } | undefined
  if (row) {
    const stored = parseJson<Partial<ReportFacts>>(row.payload_json)
    return {
      title: typeof stored.title === 'string' ? stored.title : report.title,
      paragraphCount: typeof stored.paragraphCount === 'number' ? stored.paragraphCount : report.paragraphCount,
      characterCount: typeof stored.characterCount === 'number' ? stored.characterCount : report.characterCount,
    }
  }
  const facts = createReportFacts(report)
  inImmediateTransaction((database) => {
    database.prepare('INSERT OR REPLACE INTO report_facts(report_version_id, payload_json, updated_at) VALUES (?, ?, ?)').run(reportVersionId, json(facts), now())
  })
  return facts
}

export function getSnapshot(snapshotId: string): AnalysisSnapshot | undefined {
  return optionalRow(`SELECT * FROM analysis_snapshots WHERE id = ? AND schema_version = ${analysisSnapshotSchemaVersion}`, snapshotId, snapshotFromRow)
}

export function getCurrentSnapshot(reportVersionId: string) {
  const row = getDatabase().prepare(`
    SELECT snapshot.*
    FROM report_versions report
    INNER JOIN analysis_snapshots snapshot
      ON snapshot.id = report.current_analysis_id
      AND snapshot.report_version_id = report.id
    INNER JOIN analysis_jobs job ON job.id = snapshot.job_id
    WHERE report.id = ?
      AND snapshot.kind = 'final'
      AND snapshot.schema_version = ${analysisSnapshotSchemaVersion}
      AND job.type IN ('initial', 'rerun')
      AND job.status IN ('completed')
      AND json_valid(snapshot.payload_json)
      AND json_valid(snapshot.module_states_json)
      AND json_valid(snapshot.artifacts_json)
      AND (
        SELECT COUNT(*)
        FROM json_each(snapshot.module_states_json) state
        WHERE json_extract(state.value, '$.status') = 'accepted'
          AND json_extract(state.value, '$.moduleId') = 'page_analysis'
          AND EXISTS (
            SELECT 1 FROM analysis_artifacts state_artifact
            WHERE state_artifact.id = json_extract(state.value, '$.artifactId')
              AND state_artifact.job_id = snapshot.job_id
              AND state_artifact.module_id = 'page_analysis'
              AND state_artifact.schema_version = 1
              AND state_artifact.status = 'accepted'
          )
      ) = 1
      AND EXISTS (
        SELECT 1
        FROM analysis_artifacts artifact
        WHERE artifact.job_id = job.id
          AND artifact.report_version_id = report.id
          AND artifact.module_id = 'page_analysis'
          AND artifact.schema_version = 1
          AND artifact.status = 'accepted'
          AND json_valid(artifact.payload_json)
      )
  `).get(reportVersionId) as Record<string, unknown> | undefined
  if (!row) return undefined
  try {
    const snapshot = snapshotFromRow(row)
    if (!isCanonicalPageAnalysisPayload(snapshot.payload)) return undefined
    const acceptedStates = (snapshot.moduleStates ?? []).filter((state) => state.moduleId === 'page_analysis' && state.status === 'accepted')
    if (acceptedStates.length !== 1) return undefined
    const referencedArtifact = (snapshot.artifacts ?? []).find((artifact) => artifact.id === acceptedStates[0]?.artifactId)
    if (!referencedArtifact
      || referencedArtifact.jobId !== text(row.job_id)
      || referencedArtifact.reportVersionId !== reportVersionId
      || referencedArtifact.moduleId !== 'page_analysis'
      || referencedArtifact.schemaVersion !== 1
      || referencedArtifact.status !== 'accepted') return undefined
    if (!Value.Check(AnalysisArtifactSchemas.page_analysis, referencedArtifact.payload)) return undefined
    if (validatePageAnalysisOutput(referencedArtifact.payload).length) return undefined
    return { id: snapshot.id, payload: snapshot.payload }
  } catch {
    return undefined
  }
}

export function getLatestPartialSnapshotForJob(jobId: string) {
  const row = getDatabase().prepare(`
    SELECT snapshot.*
    FROM analysis_jobs job
    INNER JOIN analysis_snapshots snapshot
      ON snapshot.id = job.latest_partial_snapshot_id
      AND snapshot.job_id = job.id
      AND snapshot.report_version_id = job.report_version_id
    WHERE job.id = ? AND snapshot.kind = 'partial' AND snapshot.schema_version = ${analysisSnapshotSchemaVersion}
  `).get(jobId) as Record<string, unknown> | undefined
  return row ? snapshotFromRow(row) : undefined
}

export function saveAnalysisSnapshot(input: AnalysisSnapshotWrite) {
  inImmediateTransaction((database) => saveAnalysisSnapshotInDatabase(database, input))
}

function saveAnalysisSnapshotInDatabase(database: ReturnType<typeof getDatabase>, input: AnalysisSnapshotWrite) {
  // 插入与指针更新必须在同一事务：取消竞态导致 UPDATE 落空时，
  // 回滚刚插入的 partial 快照，避免产生无人引用的孤儿行。
  insertActiveAnalysisSnapshot(database, input)
  if (input.kind !== 'partial') return
  const timestamp = now()
  const result = database.prepare("UPDATE analysis_jobs SET latest_partial_snapshot_id = ?, updated_at = ? WHERE id = ? AND status = 'running' AND cancel_requested = 0 AND (? IS NULL OR (lease_owner = ? AND lease_expires_at > ?))").run(input.id, timestamp, input.jobId, input.leaseOwner ?? null, input.leaseOwner ?? null, timestamp)
  if (Number(result.changes) !== 1) throw new Error('任务已停止，不能发布部分快照。')
}

/**
 * 最终发布必须是一个事务：取消要么先提交并阻止发布，要么在发布后看到已完成任务。
 * 不能让 current_analysis_id 指向一个随后被标记为 cancelled 的任务。
 */
export function publishFinalAnalysis(input: AnalysisSnapshotWrite, finalization: AnalysisFinalization) {
  publishFinalAnalysisTransaction(input, finalization)
}

function publishFinalAnalysisTransaction(
  input: AnalysisSnapshotWrite,
  finalization: AnalysisFinalization,
) {
  if (input.kind !== 'final') throw new Error('最终发布只能写入 final 快照。')

  inImmediateTransaction((database) => {
    if (input.leaseOwner && !hasActiveJobLease(database, input.reportVersionId, input.leaseOwner)) throw new Error('任务租约已失效，不能发布分析结果。')
    insertActiveAnalysisSnapshot(database, input)
    if (finalization.publishAsCurrent) {
      const currentResult = database.prepare(`
        UPDATE report_versions
        SET current_analysis_id = ?
        WHERE id = ? AND EXISTS (
          SELECT 1
          FROM analysis_snapshots snapshot
          JOIN analysis_jobs job ON job.id = snapshot.job_id
          WHERE snapshot.id = ?
            AND snapshot.report_version_id = ?
            AND snapshot.kind = 'final'
            AND job.status = 'running'
            AND job.cancel_requested = 0
            AND ( ? IS NULL OR (job.lease_owner = ? AND job.lease_expires_at > ?) )
        )
      `).run(input.id, input.reportVersionId, input.id, input.reportVersionId, input.leaseOwner ?? null, input.leaseOwner ?? null, now())
      if (Number(currentResult.changes) !== 1) throw new Error('任务已停止，不能切换当前分析快照。')
    }

    const jobResult = database.prepare(`
      UPDATE analysis_jobs
      SET status = ?,
          current_stage = ?,
          stage_index = ?,
          error_message = ?,
          terminal_reason = ?,
          terminal_at = ?,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ?
      WHERE id = ?
        AND report_version_id = ?
        AND status = 'running'
        AND cancel_requested = 0
        AND (? IS NULL OR (lease_owner = ? AND lease_expires_at > ?))
    `).run(
      finalization.status,
      finalization.stage,
      finalization.stageIndex,
      finalization.errorMessage ?? null,
      finalization.status,
      now(),
      now(),
      input.jobId,
      input.reportVersionId,
      input.leaseOwner ?? null,
      input.leaseOwner ?? null,
      now(),
    )
    if (Number(jobResult.changes) !== 1) throw new Error('任务已停止，不能完成最终分析发布。')
    const actualTokens = sumModelCallTokens(input.modelCalls)
    const budgetBefore = database.prepare('SELECT state, model_calls_started, model_calls_completed FROM ai_budget_ledger WHERE job_id = ?').get(input.jobId) as { state?: string; model_calls_started?: number; model_calls_completed?: number } | undefined
    const hasRecordedProviderCall = Number(budgetBefore?.model_calls_started ?? 0) > 0 || Number(budgetBefore?.model_calls_completed ?? 0) > 0
    if (budgetBefore?.state === 'reserved' && !hasRecordedProviderCall && actualTokens === 0) {
      reconcileAiBudgetForJobInDatabase(database, input.jobId, 'finalization_before_provider_call')
    } else {
      const settled = settleAiBudgetForJobInDatabase(database, input.jobId, actualTokens)
      const budgetRow = database.prepare('SELECT state FROM ai_budget_ledger WHERE job_id = ?').get(input.jobId) as { state?: string } | undefined
      if (budgetRow && ['reserved', 'uncertain'].includes(String(budgetRow.state)) && !settled) {
        markAiBudgetUncertainForJobInDatabase(database, input.jobId, 'finalization_with_unknown_ai_call')
      }
    }
    // 终态事件与状态切换在同一事务落库；此时任务已非 running，
    // 事后经 publishAnalysisEvent 的 running 守卫会被丢弃。
    insertRequiredJobEvent(database, input.jobId, {
      type: finalization.status === 'failed' ? 'failed' : 'completed',
      stage: 'completed',
      message: finalization.status === 'completed'
        ? '分析完成，已生成不可变分析快照。'
        : finalization.errorMessage ?? '分析已结束。',
    }, now())
  })
}

function sumModelCallTokens(modelCalls: AnalysisSnapshotWrite['modelCalls']) {
  return modelCalls.reduce((total, call) => total + Math.max(0, Number.isSafeInteger(call.tokens) ? call.tokens : 0), 0)
}

function insertActiveAnalysisSnapshot(database: ReturnType<typeof getDatabase>, input: AnalysisSnapshotWrite) {
  const result = database.prepare(`
    INSERT INTO analysis_snapshots (
      id, job_id, report_version_id, kind, schema_version, prompt_version, pipeline_version,
      model_calls_json, artifacts_json, module_states_json, payload_json, created_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM analysis_jobs
      WHERE id = ? AND report_version_id = ? AND status = 'running' AND cancel_requested = 0
        AND (? IS NULL OR (lease_owner = ? AND lease_expires_at > ?))
    )
  `).run(
    input.id,
    input.jobId,
    input.reportVersionId,
    input.kind,
    input.schemaVersion,
    input.promptVersion,
    input.pipelineVersion,
    json(input.modelCalls),
    json(input.artifacts),
    json(input.moduleStates),
    json(input.payload),
    input.createdAt,
    input.jobId,
    input.reportVersionId,
    input.leaseOwner ?? null,
    input.leaseOwner ?? null,
    now(),
  )
  if (Number(result.changes) !== 1) throw new Error('任务已停止，不能发布分析快照。')
}

export function listModuleStates(jobId: string): AnalysisModuleState[] {
  return (getDatabase().prepare('SELECT * FROM analysis_module_states WHERE job_id = ? ORDER BY rowid ASC').all(jobId) as Record<string, unknown>[]).map(moduleStateFromRow)
}

function canResetAcceptedModuleState(database: ReturnType<typeof getDatabase>, jobId: string) {
  const current = database.prepare('SELECT status, artifact_id FROM analysis_module_states WHERE job_id = ? AND module_id = ?').get(jobId, 'page_analysis') as { status?: unknown; artifact_id?: string | null } | undefined
  if (text(current?.status) !== 'accepted' || !current?.artifact_id) return false
  const artifact = database.prepare('SELECT prompt_version, schema_version FROM analysis_artifacts WHERE id = ? AND job_id = ?').get(current.artifact_id, jobId) as { prompt_version?: unknown; schema_version?: unknown } | undefined
  const job = database.prepare('SELECT prompt_config_json FROM analysis_jobs WHERE id = ?').get(jobId) as { prompt_config_json?: unknown } | undefined
  const prompt = parseStoredPromptSettings(job?.prompt_config_json)?.find((candidate) => candidate.target === 'page_analysis')
  if (!artifact || !prompt) return false
  const expectedPromptVersion = pageAnalysisModule.promptVersion + ':settings-' + String(prompt.version)
  return artifact.prompt_version !== expectedPromptVersion || Number(artifact.schema_version) !== pageAnalysisModule.schemaVersion
}

function saveModuleStateInDatabase(database: ReturnType<typeof getDatabase>, jobId: string, state: AnalysisModuleState, leaseOwner?: string) {
  const allowAcceptedReset = canResetAcceptedModuleState(database, jobId)
  const result = database.prepare(`
    INSERT INTO analysis_module_states (
      job_id, module_id, status, attempt, max_attempts, artifact_id, gate_errors_json, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM analysis_jobs WHERE id = ? AND status = 'running' AND cancel_requested = 0 AND (? IS NULL OR (lease_owner = ? AND lease_expires_at > ?)))
    ON CONFLICT(job_id, module_id) DO UPDATE SET
      status = excluded.status,
      attempt = excluded.attempt,
      max_attempts = excluded.max_attempts,
      artifact_id = excluded.artifact_id,
      gate_errors_json = excluded.gate_errors_json,
      updated_at = excluded.updated_at
    WHERE analysis_module_states.status != 'accepted' OR excluded.status = 'accepted' OR ? = 1
  `).run(
    jobId,
    state.moduleId,
    state.status,
    state.attempt,
    state.maxAttempts,
    state.artifactId ?? null,
    json(state.gateErrors),
    state.updatedAt,
    jobId,
    leaseOwner ?? null,
    leaseOwner ?? null,
    now(),
    allowAcceptedReset ? 1 : 0,
  )
  if (Number(result.changes) !== 1) throw new Error('任务已停止，不能保存模块状态。')
}

export function saveModuleState(jobId: string, state: AnalysisModuleState, leaseOwner?: string) {
  saveModuleStateInDatabase(getDatabase(), jobId, state, leaseOwner)
}

export function listAcceptedArtifacts(jobId: string): AnalysisArtifactRecord[] {
  return listArtifacts(jobId).filter((artifact) => artifact.status === 'accepted')
}

export function listArtifacts(jobId: string): AnalysisArtifactRecord[] {
  return (getDatabase().prepare('SELECT * FROM analysis_artifacts WHERE job_id = ? ORDER BY created_at ASC').all(jobId) as Record<string, unknown>[]).map(artifactFromRow)
}

function saveArtifactInDatabase(database: ReturnType<typeof getDatabase>, jobId: string, artifact: AnalysisArtifactRecord, leaseOwner?: string) {
  const result = database.prepare(`
    INSERT INTO analysis_artifacts (
      id, job_id, report_version_id, module_id, schema_version, prompt_version, attempt,
      status, payload_json, gate_errors_json, provider, model, created_at, accepted_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM analysis_jobs WHERE id = ? AND report_version_id = ? AND status = 'running' AND cancel_requested = 0 AND (? IS NULL OR (lease_owner = ? AND lease_expires_at > ?)))
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      payload_json = excluded.payload_json,
      gate_errors_json = excluded.gate_errors_json,
      provider = excluded.provider,
      model = excluded.model,
      accepted_at = excluded.accepted_at
    WHERE analysis_artifacts.job_id = excluded.job_id
      AND analysis_artifacts.report_version_id = excluded.report_version_id
      AND analysis_artifacts.module_id = excluded.module_id
      AND analysis_artifacts.schema_version = excluded.schema_version
      AND analysis_artifacts.prompt_version = excluded.prompt_version
      AND analysis_artifacts.attempt = excluded.attempt
      AND (analysis_artifacts.status != 'accepted' OR excluded.status = 'accepted')
  `).run(
    artifact.id,
    jobId,
    artifact.reportVersionId,
    artifact.moduleId,
    artifact.schemaVersion,
    artifact.promptVersion,
    artifact.attempt,
    artifact.status,
    artifact.payload === undefined ? null : json(artifact.payload),
    json(artifact.gateErrors),
    artifact.provider ?? null,
    artifact.model ?? null,
    artifact.createdAt,
    artifact.acceptedAt ?? null,
    jobId,
    artifact.reportVersionId,
    leaseOwner ?? null,
    leaseOwner ?? null,
    now(),
  )
  if (Number(result.changes) !== 1) throw new Error('任务已停止，不能保存模块产物。')
}

export function saveArtifact(jobId: string, artifact: AnalysisArtifactRecord, leaseOwner?: string) {
  saveArtifactInDatabase(getDatabase(), jobId, artifact, leaseOwner)
}

export function saveFailedAttempt(jobId: string, artifact: AnalysisArtifactRecord, state: AnalysisModuleState, leaseOwner?: string) {
  inImmediateTransaction((database) => {
    saveArtifactInDatabase(database, jobId, artifact, leaseOwner)
    saveModuleStateInDatabase(database, jobId, state, leaseOwner)
  })
}

export function getJob(jobId: string): AnalysisJob | undefined {
  return optionalRow('SELECT * FROM analysis_jobs WHERE id = ?', jobId, jobFromRow)
}

export function getAnalysisJobPromptSettings(jobId: string): AnalysisPromptConfig[] | undefined {
  const row = getDatabase().prepare('SELECT prompt_config_json FROM analysis_jobs WHERE id = ?').get(jobId) as { prompt_config_json?: unknown } | undefined
  return parseStoredPromptSettings(row?.prompt_config_json)
}

export function getJobEvaluationContext(jobId: string): ReportEvaluationContext {
  const row = getDatabase().prepare('SELECT evaluation_context_json FROM analysis_jobs WHERE id = ?').get(jobId) as { evaluation_context_json?: unknown } | undefined
  const stored = parseReportEvaluationContext(row?.evaluation_context_json)
  if (!stored) throw new Error('任务缺少有效的冻结课题评价基准。')
  return stored
}

export function getJobModelRuntime(jobId: string): AiModelRuntimeSnapshot {
  const row = getDatabase().prepare('SELECT model_runtime_json FROM analysis_jobs WHERE id = ?').get(jobId) as { model_runtime_json?: unknown } | undefined
  const stored = text(row?.model_runtime_json)
  if (!stored) throw new Error('任务缺少冻结的模型配置。')
  return parseJson<AiModelRuntimeSnapshot>(stored)
}

export function getLatestJobForReport(reportVersionId: string): AnalysisJob | undefined {
  return optionalRow("SELECT * FROM analysis_jobs WHERE report_version_id = ? AND type != 'insight' ORDER BY created_at DESC, rowid DESC LIMIT 1", reportVersionId, jobFromRow)
}

export function getLatestInsightJobForReport(reportVersionId: string): AnalysisJob | undefined {
  return optionalRow(
    "SELECT * FROM analysis_jobs WHERE report_version_id = ? AND type = 'insight' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    reportVersionId,
    jobFromRow,
  )
}

/** 终态失败与 failed 事件写入同一事务，保证 SSE 能收到与状态一致的失败事件。 */
export function failAnalysisJob(jobId: string, message: string, leaseOwner?: string): AnalysisJob | undefined {
  return inImmediateTransaction((database) => {
    const currentRow = database.prepare('SELECT * FROM analysis_jobs WHERE id = ?').get(jobId) as Record<string, unknown> | undefined
    if (!currentRow) return undefined
    if (terminalJobStatuses.has(jobFromRow(currentRow).status)) return getJob(jobId)
    const timestamp = now()
    const result = database.prepare(`
      UPDATE analysis_jobs
      SET status = 'failed', error_message = ?, last_error_code = 'worker_failure', last_error_at = ?,
          terminal_reason = 'worker_failure', terminal_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'running' AND cancel_requested = 0
        AND (? IS NULL OR (lease_owner = ? AND lease_expires_at > ?))
    `).run(message, timestamp, timestamp, timestamp, jobId, leaseOwner ?? null, leaseOwner ?? null, timestamp)
    if (Number(result.changes) === 1) {
      reconcileAiBudgetForJobInDatabase(database, jobId, 'worker_failure')
      insertRequiredJobEvent(database, jobId, { type: 'failed', message }, timestamp)
    }
    return getJob(jobId)
  })
}

export function updateAnalysisJob(jobId: string, input: {
  status?: AnalysisJob['status']
  stage?: AnalysisStage
  stageIndex?: number
  errorMessage?: string
}, leaseOwner?: string) {
  return inImmediateTransaction((database) => {
    const currentRow = database.prepare('SELECT * FROM analysis_jobs WHERE id = ?').get(jobId) as Record<string, unknown> | undefined
    if (!currentRow) return undefined
    const current = jobFromRow(currentRow)
    if (terminalJobStatuses.has(current.status)) return current
    const nextStatus = input.status ?? current.status
    const nextStage = input.stage ?? current.stage
    const nextStageIndex = input.stageIndex ?? current.stageIndex
    const errorMessage = Object.prototype.hasOwnProperty.call(input, 'errorMessage') ? input.errorMessage : current.errorMessage
    const timestamp = now()
    const isTerminal = terminalJobStatuses.has(nextStatus)
    const result = database.prepare(`
      UPDATE analysis_jobs
      SET status = ?, current_stage = ?, stage_index = ?, error_message = ?,
          last_error_code = CASE WHEN ? IS NOT NULL THEN 'job_update' ELSE last_error_code END,
          last_error_at = CASE WHEN ? IS NOT NULL THEN ? ELSE last_error_at END,
          terminal_reason = CASE WHEN ? THEN COALESCE(terminal_reason, ?) ELSE terminal_reason END,
          terminal_at = CASE WHEN ? THEN COALESCE(terminal_at, ?) ELSE terminal_at END,
          lease_owner = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN NULL ELSE lease_owner END,
          lease_expires_at = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN NULL ELSE lease_expires_at END,
          updated_at = ?
      WHERE id = ? AND status = 'running' AND cancel_requested = 0
        AND (? IS NULL OR (lease_owner = ? AND lease_expires_at > ?))
    `).run(nextStatus, nextStage, nextStageIndex, errorMessage ?? null, errorMessage ?? null, errorMessage ?? null, timestamp, isTerminal ? 1 : 0, nextStatus, isTerminal ? 1 : 0, timestamp, nextStatus, nextStatus, timestamp, jobId, leaseOwner ?? null, leaseOwner ?? null, timestamp)
    if (Number(result.changes) !== 1) return undefined
    if (isTerminal) reconcileAiBudgetForJobInDatabase(database, jobId, 'job_update_terminal')
    return getJob(jobId)
  })
}

function getQueueRetryDelayMs(attempt: number) {
  const normalizedAttempt = Math.max(1, Number.isSafeInteger(attempt) ? attempt : 1)
  return Math.min(queueRetryMaxMs, queueRetryBaseMs * 2 ** Math.min(20, normalizedAttempt - 1))
}

export function claimNextJob(workerId: string, leaseMs = 60_000): AnalysisJob | undefined {
  return inImmediateTransaction((database) => {
    const timestamp = now()
    const expired = database.prepare(`
      SELECT job.*,
        COALESCE(json_array_length(snapshot.model_calls_json), 0) AS checkpointed_calls,
        (
          SELECT COUNT(*)
          FROM analysis_artifacts artifact
          WHERE artifact.job_id = job.id
            AND artifact.report_version_id = job.report_version_id
            AND artifact.status IN ('accepted', 'failed')
            AND artifact.provider IS NOT NULL
            AND artifact.model IS NOT NULL
        ) AS persisted_artifacts
      FROM analysis_jobs job
      LEFT JOIN analysis_snapshots snapshot
        ON snapshot.id = job.latest_partial_snapshot_id
        AND snapshot.job_id = job.id
        AND snapshot.report_version_id = job.report_version_id
        AND snapshot.kind = 'partial'
        AND snapshot.schema_version = ${analysisSnapshotSchemaVersion}
      WHERE job.status = 'running' AND job.cancel_requested = 0
        AND job.lease_expires_at IS NOT NULL AND job.lease_expires_at < ?
    `).all(timestamp) as Array<Record<string, unknown>>
    for (const row of expired) {
      const uncheckpointedAiCall = hasUncheckpointedAiCall(row)
      if (Number(row.attempts ?? 0) >= maxJobAutoRecoveries || uncheckpointedAiCall) {
        markJobDeadLetterInDatabase(database, String(row.id), uncheckpointedAiCall ? 'lease_expired_after_ai_call' : 'max_attempts_exhausted')
      } else {
        scheduleJobRetryInDatabase(database, String(row.id), String(row.lease_owner ?? ''), timestamp, 'lease_expired')
      }
    }

    const exhaustedQueued = database.prepare(`
      SELECT id FROM analysis_jobs
      WHERE status = 'queued' AND cancel_requested = 0 AND attempts >= ?
    `).all(maxJobAutoRecoveries) as Array<{ id: string }>
    for (const row of exhaustedQueued) markJobDeadLetterInDatabase(database, row.id, 'max_attempts_exhausted')

    const cancelled = database.prepare(`
      SELECT id FROM analysis_jobs
      WHERE status IN ('queued', 'running') AND cancel_requested = 1
    `).all() as Array<{ id: string }>
    for (const row of cancelled) cancelJobInDatabase(database, row.id, timestamp)

    const candidate = database.prepare(`
      SELECT id FROM analysis_jobs
      WHERE status = 'queued'
        AND cancel_requested = 0 AND attempts < ?
        AND (available_at = '' OR available_at <= ?)
        AND (admission_id IS NULL OR EXISTS (
          SELECT 1 FROM ai_budget_ledger ledger
          WHERE ledger.job_id = analysis_jobs.id AND ledger.state = 'reserved'
        ))
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
    `).get(maxJobAutoRecoveries, timestamp) as { id: string } | undefined
    if (!candidate) return undefined
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString()
    const result = database.prepare(`
      UPDATE analysis_jobs
      SET status = 'running', attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?,
          last_claimed_at = ?, last_worker_id = ?, error_message = NULL, updated_at = ?
      WHERE id = ? AND status = 'queued' AND cancel_requested = 0 AND attempts < ?
    `).run(workerId, leaseExpiresAt, timestamp, workerId, timestamp, candidate.id, maxJobAutoRecoveries)
    if (Number(result.changes) !== 1) return undefined
    touchAiBudgetReservationForJobInDatabase(database, candidate.id, timestamp)
    return getJob(candidate.id)
  })
}

export function renewJobLease(jobId: string, workerId: string, leaseMs = 60_000) {
  return inImmediateTransaction((database) => {
    const currentTime = now()
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString()
    const result = database.prepare(`
      UPDATE analysis_jobs SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ? AND cancel_requested = 0 AND lease_expires_at > ?
    `).run(leaseExpiresAt, currentTime, jobId, workerId, currentTime)
    if (Number(result.changes) === 1) touchAiBudgetReservationForJobInDatabase(database, jobId, currentTime)
    return Number(result.changes) === 1
  })
}

export function releaseJobLease(jobId: string, workerId: string, failure?: { code?: string; message?: string }) {
  return inImmediateTransaction((database) => {
    const timestamp = now()
    const row = database.prepare(`
      SELECT job.*,
        COALESCE(json_array_length(snapshot.model_calls_json), 0) AS checkpointed_calls,
        (
          SELECT COUNT(*)
          FROM analysis_artifacts artifact
          WHERE artifact.job_id = job.id
            AND artifact.report_version_id = job.report_version_id
            AND artifact.status IN ('accepted', 'failed')
            AND artifact.provider IS NOT NULL
            AND artifact.model IS NOT NULL
        ) AS persisted_artifacts
      FROM analysis_jobs job
      LEFT JOIN analysis_snapshots snapshot
        ON snapshot.id = job.latest_partial_snapshot_id
        AND snapshot.job_id = job.id
        AND snapshot.report_version_id = job.report_version_id
        AND snapshot.kind = 'partial'
        AND snapshot.schema_version = ${analysisSnapshotSchemaVersion}
      WHERE job.id = ? AND job.lease_owner = ? AND job.status = 'running' AND job.lease_expires_at > ?
    `).get(jobId, workerId, timestamp) as Record<string, unknown> | undefined
    if (!row) return false
    if (Number(row.attempts ?? 0) >= maxJobAutoRecoveries || hasUncheckpointedAiCall(row)) {
      return markJobDeadLetterInDatabase(database, jobId, hasUncheckpointedAiCall(row) ? 'uncheckpointed_ai_call' : (failure?.code ?? 'max_attempts_exhausted'), failure?.message)
    }
    scheduleJobRetryInDatabase(database, jobId, workerId, timestamp, failure?.code ?? 'worker_released', failure?.message)
    return true
  })
}

export function markAnalysisAiCallStarted(jobId: string, details: { provider?: string; model?: string; stage?: string; module?: string; attempt?: number }, leaseOwner?: string) {
  return inImmediateTransaction((database) => {
    const timestamp = now()
    const current = database.prepare("SELECT admission_id FROM analysis_jobs WHERE id = ? AND status = 'running' AND cancel_requested = 0").get(jobId) as { admission_id?: string | null } | undefined
    if (!current) throw new Error('任务已停止，不能发起 AI 调用。')
    const result = database.prepare(`
      UPDATE analysis_jobs
      SET ai_calls_started = ai_calls_started + 1, updated_at = ?
      WHERE id = ? AND status = 'running' AND cancel_requested = 0
        AND (? IS NULL OR (lease_owner = ? AND lease_expires_at > ?))
    `).run(timestamp, jobId, leaseOwner ?? null, leaseOwner ?? null, timestamp)
    if (Number(result.changes) !== 1) throw new Error('任务租约已失效，不能发起 AI 调用。')
    const accounted = markAiBudgetCallStartedForJobInDatabase(database, jobId, details)
    if (current.admission_id && !accounted) throw new Error('AI 预算预留已失效，不能发起 AI 调用。')
  })
}

function recordAnalysisAiCallCompletedInDatabase(database: ReturnType<typeof getDatabase>, jobId: string, details: AnalysisCallCheckpoint['details'], leaseOwner?: string) {
  const timestamp = now()
  const current = database.prepare("SELECT admission_id FROM analysis_jobs WHERE id = ? AND status = 'running' AND cancel_requested = 0").get(jobId) as { admission_id?: string | null } | undefined
  if (!current) throw new Error('任务已停止，不能记入 AI 调用。')
  const accounted = recordAiBudgetCallCompletedForJobInDatabase(database, jobId, details)
  if (current.admission_id && !accounted) throw new Error('AI 预算调用记录失败，结果保持未知。')
  const result = database.prepare(`
    UPDATE analysis_jobs
    SET ai_calls_completed = ai_calls_completed + 1,
        ai_tokens = ai_tokens + ?,
        updated_at = ?
    WHERE id = ? AND status = 'running' AND cancel_requested = 0
      AND (? IS NULL OR (lease_owner = ? AND lease_expires_at > ?))
  `).run(details.tokens ?? 0, timestamp, jobId, leaseOwner ?? null, leaseOwner ?? null, timestamp)
  if (Number(result.changes) !== 1) throw new Error('任务租约已失效，不能完成 AI 调用记录。')
}

export function recordAnalysisAiCallCompleted(jobId: string, details: AnalysisCallCheckpoint['details'], leaseOwner?: string) {
  return inImmediateTransaction((database) => recordAnalysisAiCallCompletedInDatabase(database, jobId, details, leaseOwner))
}

function resolveCheckpointLeaseOwner(input: AnalysisCallCheckpoint, leaseOwner?: string) {
  const snapshotLeaseOwner = input.snapshot?.leaseOwner
  if (leaseOwner !== undefined && snapshotLeaseOwner !== undefined && leaseOwner !== snapshotLeaseOwner) {
    throw new Error('AI 调用检查点的任务租约不一致。')
  }
  const effectiveLeaseOwner = leaseOwner ?? snapshotLeaseOwner
  if (effectiveLeaseOwner !== undefined && !effectiveLeaseOwner.trim()) throw new Error('AI 调用检查点缺少有效任务租约。')
  return effectiveLeaseOwner
}

function validateAnalysisCallCheckpoint(
  database: ReturnType<typeof getDatabase>,
  input: AnalysisCallCheckpoint,
  leaseOwner: string | undefined,
  alreadyApplied: boolean,
) {
  const jobRow = database.prepare('SELECT * FROM analysis_jobs WHERE id = ?').get(input.jobId) as Record<string, unknown> | undefined
  if (!jobRow) throw new Error('AI 调用检查点所属任务不存在。')
  const jobReportVersionId = text(jobRow.report_version_id)
  if (!jobReportVersionId || input.artifact.reportVersionId !== jobReportVersionId) throw new Error('AI 调用检查点的报告版本不匹配。')
  const running = text(jobRow.status) === 'running' && !Boolean(jobRow.cancel_requested)
  if (!running && !alreadyApplied) throw new Error('任务已停止，不能保存 AI 调用检查点。')
  const storedLeaseOwner = nullableText(jobRow.lease_owner)
  if (storedLeaseOwner !== undefined && leaseOwner !== storedLeaseOwner) throw new Error('任务租约所有者不匹配，不能保存 AI 调用检查点。')
  if (running && leaseOwner !== undefined && !isFutureTimestamp(jobRow.lease_expires_at)) throw new Error('任务租约已失效，不能保存 AI 调用检查点。')
  if (!database.prepare('SELECT 1 FROM report_versions WHERE id = ?').get(jobReportVersionId)) throw new Error('AI 调用检查点的报告版本不存在。')

  const insightCheckpoint = input.artifact.moduleId === 'report_insight'
  const jobType = text(jobRow.type)
  if (insightCheckpoint !== (jobType === 'insight')) throw new Error('AI 调用检查点与任务类型不匹配。')
  validateCheckpointDetails(input.details, insightCheckpoint)
  validateCheckpointAttempt(database, jobRow, input, alreadyApplied, insightCheckpoint)
  validateCheckpointFrozenConfiguration(jobRow, input, insightCheckpoint)
  validateCheckpointArtifact(input.artifact, input.jobId, jobReportVersionId, input.details, insightCheckpoint)
  validateCheckpointState(input.state, input.artifact, insightCheckpoint)
  validateCheckpointSnapshot(input.snapshot, input, leaseOwner, insightCheckpoint)
  validateCheckpointMonotonicity(database, input, insightCheckpoint)
}

function validateCheckpointDetails(details: AnalysisCallCheckpoint['details'], insightCheckpoint: boolean) {
  const expectedModule = insightCheckpoint ? 'report_insight' : 'page_analysis'
  if (!isNonEmptyString(details.provider) || !isNonEmptyString(details.model)) throw new Error('AI 调用检查点缺少 provider 或 model。')
  if (details.module !== expectedModule || details.stage !== expectedModule) throw new Error('AI 调用检查点的模块或阶段不匹配。')
  if (!Number.isSafeInteger(details.attempt) || Number(details.attempt) < 1) throw new Error('AI 调用检查点的 attempt 无效。')
  if (!Number.isSafeInteger(details.tokens) || Number(details.tokens) < 0) throw new Error('AI 调用检查点的 tokens 无效。')
}

function validateCheckpointAttempt(
  database: ReturnType<typeof getDatabase>,
  jobRow: Record<string, unknown>,
  input: AnalysisCallCheckpoint,
  alreadyApplied: boolean,
  insightCheckpoint: boolean,
) {
  if (alreadyApplied) return
  const started = readNonNegativeCounter(jobRow.ai_calls_started)
  const completed = readNonNegativeCounter(jobRow.ai_calls_completed)
  if (started === undefined || completed === undefined || started !== completed + 1) {
    throw new Error('AI 调用检查点没有对应的未完成调用。')
  }
  if (insightCheckpoint) {
    if (input.details.attempt !== 1) throw new Error('洞察 AI 调用检查点的 attempt 无效。')
    return
  }
  const state = database.prepare('SELECT status, attempt FROM analysis_module_states WHERE job_id = ? AND module_id = ?').get(input.jobId, input.artifact.moduleId) as { status?: unknown; attempt?: unknown } | undefined
  if (!state || !['running', 'gating', 'retrying'].includes(text(state.status)) || Number(state.attempt) !== input.details.attempt) {
    throw new Error('AI 调用检查点与当前模块 attempt 不匹配。')
  }
}

function validateCheckpointFrozenConfiguration(
  jobRow: Record<string, unknown>,
  input: AnalysisCallCheckpoint,
  insightCheckpoint: boolean,
) {
  const runtime = parseStoredModelRuntime(jobRow.model_runtime_json)
  if (!runtime || runtime.channel !== 'chat_completions' || !isNonEmptyString(runtime.modelName)) throw new Error('AI 调用检查点缺少有效的冻结模型配置。')
  if (input.details.provider !== 'chat_completions' || input.details.model !== runtime.modelName) throw new Error('AI 调用检查点与冻结模型配置不匹配。')
  if (insightCheckpoint) {
    if (input.artifact.promptVersion !== insightCheckpointPromptVersion || input.artifact.schemaVersion !== 1) throw new Error('洞察 AI 调用检查点版本无效。')
    return
  }
  const prompts = parseStoredPromptSettings(jobRow.prompt_config_json)
  const prompt = prompts?.find((candidate) => candidate.target === 'page_analysis')
  if (!prompt) throw new Error('AI 调用检查点缺少冻结的分析页提示词配置。')
  const expectedPromptVersion = pageAnalysisModule.promptVersion + ':settings-' + String(prompt.version)
  if (input.artifact.schemaVersion !== pageAnalysisModule.schemaVersion || input.artifact.promptVersion !== expectedPromptVersion) {
    throw new Error('AI 调用检查点与冻结提示词配置不匹配。')
  }
}

function parseStoredModelRuntime(value: unknown): { channel?: unknown; modelName?: unknown } | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const parsed = parseJson<unknown>(value)
    return isRecord(parsed) ? { channel: parsed.channel, modelName: parsed.modelName } : undefined
  } catch {
    return undefined
  }
}

function readNonNegativeCounter(value: unknown) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined
}

function validateCheckpointArtifact(
  artifact: AnalysisArtifactRecord,
  jobId: string,
  reportVersionId: string,
  details: AnalysisCallCheckpoint['details'],
  insightCheckpoint: boolean,
) {
  if (artifact.jobId !== jobId || artifact.reportVersionId !== reportVersionId) throw new Error('AI 调用检查点的产物归属不匹配。')
  const expectedModule = insightCheckpoint ? 'report_insight' : 'page_analysis'
  if (!isNonEmptyString(artifact.id) || artifact.moduleId !== expectedModule) throw new Error('AI 调用检查点的产物标识无效。')
  if (!Number.isSafeInteger(artifact.schemaVersion) || Number(artifact.schemaVersion) < 1) throw new Error('AI 调用检查点的产物 schema 无效。')
  if (!isNonEmptyString(artifact.promptVersion) || !isNonEmptyString(artifact.provider) || !isNonEmptyString(artifact.model)) throw new Error('AI 调用检查点的产物元数据不完整。')
  if (artifact.provider !== details.provider || artifact.model !== details.model) throw new Error('AI 调用检查点的 provider 或 model 不匹配。')
  if (artifact.status !== 'accepted' && artifact.status !== 'failed') throw new Error('AI 调用检查点的产物状态无效。')
  if (!Number.isSafeInteger(artifact.attempt) || Number(artifact.attempt) < 1 || artifact.attempt !== details.attempt) throw new Error('AI 调用检查点的产物 attempt 不匹配。')
  if (!isNonEmptyTimestamp(artifact.createdAt) || (artifact.acceptedAt !== undefined && !isNonEmptyTimestamp(artifact.acceptedAt))) throw new Error('AI 调用检查点的产物时间无效。')
  if (artifact.status === 'accepted' && !artifact.acceptedAt) throw new Error('已接受的 AI 产物缺少 acceptedAt。')
  if (!isGateErrors(artifact.gateErrors)) throw new Error('AI 调用检查点的门禁错误无效。')
  assertCheckpointJson(artifact.payload, '产物 payload', artifact.status === 'failed')
  if (insightCheckpoint) {
    if (artifact.schemaVersion !== 1 || artifact.promptVersion !== insightCheckpointPromptVersion) {
      throw new Error('洞察 AI 调用检查点产物元数据无效。')
    }
    if (artifact.status === 'accepted') {
      if (artifact.gateErrors.length) throw new Error('洞察 AI 调用检查点产物元数据无效。')
      if (!isInsightCheckpointPayload(artifact.payload, reportVersionId, details)) throw new Error('洞察 AI 调用检查点 payload 无效。')
      return
    }
    if (artifact.status === 'failed' && isInsightFailedSettlementPayload(artifact.payload, reportVersionId, details)) return
    throw new Error('洞察失败检查点 payload 无效。')
  }
  if (artifact.schemaVersion !== pageAnalysisModule.schemaVersion) throw new Error('分析页 AI 调用检查点产物 schema 无效。')
  if (artifact.status === 'accepted' && (!Value.Check(AnalysisArtifactSchemas.page_analysis, artifact.payload) || validatePageAnalysisOutput(artifact.payload).length)) {
    throw new Error('已接受的 AI 产物未通过页面门禁。')
  }
}

function isInsightCheckpointPayload(
  value: unknown,
  reportVersionId: string,
  details: AnalysisCallCheckpoint['details'],
): boolean {
  if (!isRecord(value) || value.checkpointVersion !== 1 || value.reportVersionId !== reportVersionId) return false
  if (value.tokens !== details.tokens || !isInsightOutput(value.insight)) return false
  return true
}

function isInsightFailedSettlementPayload(
  value: unknown,
  reportVersionId: string,
  details: AnalysisCallCheckpoint['details'],
) {
  return isRecord(value)
    && value.checkpointVersion === 1
    && value.reportVersionId === reportVersionId
    && value.failed === true
    && value.tokens === details.tokens
}

function isInsightOutput(value: unknown): boolean {
  if (!isRecord(value) || typeof value.title !== 'string' || typeof value.summary !== 'string' || typeof value.html !== 'string') return false
  if (!Number.isSafeInteger(value.readingMinutes) || Number(value.readingMinutes) < 1) return false
  return Array.isArray(value.sections) && value.sections.every((section) => isRecord(section) && typeof section.id === 'string' && typeof section.label === 'string')
}

function validateCheckpointState(
  state: AnalysisModuleState | undefined,
  artifact: AnalysisArtifactRecord,
  insightCheckpoint: boolean,
) {
  if (!state) {
    if (!insightCheckpoint) throw new Error('页面 AI 调用检查点缺少模块状态。')
    return
  }
  if (insightCheckpoint || state.moduleId !== artifact.moduleId || state.artifactId !== artifact.id) throw new Error('AI 调用检查点的模块状态不匹配。')
  if (!Number.isSafeInteger(state.attempt) || state.attempt !== artifact.attempt || !Number.isSafeInteger(state.maxAttempts) || state.maxAttempts < state.attempt) {
    throw new Error('AI 调用检查点的模块状态 attempt 无效。')
  }
  if (!isNonEmptyTimestamp(state.updatedAt) || !isGateErrors(state.gateErrors)) throw new Error('AI 调用检查点的模块状态无效。')
  if (artifact.status === 'accepted' && state.status !== 'accepted') throw new Error('已接受产物必须对应 accepted 模块状态。')
  if (artifact.status === 'failed' && !['failed', 'retrying'].includes(state.status)) throw new Error('失败产物必须对应 failed 或 retrying 模块状态。')
}

function validateCheckpointSnapshot(
  snapshot: AnalysisSnapshotWrite | undefined,
  input: AnalysisCallCheckpoint,
  leaseOwner: string | undefined,
  insightCheckpoint: boolean,
) {
  if (!snapshot) {
    if (!insightCheckpoint) throw new Error('页面 AI 调用检查点缺少部分快照。')
    return
  }
  if (insightCheckpoint || snapshot.kind !== 'partial' || snapshot.schemaVersion !== analysisSnapshotSchemaVersion) throw new Error('AI 调用检查点快照类型或 schema 无效。')
  if (snapshot.id === '' || snapshot.jobId !== input.jobId || snapshot.reportVersionId !== input.artifact.reportVersionId) throw new Error('AI 调用检查点快照归属不匹配。')
  if (snapshot.leaseOwner !== leaseOwner) throw new Error('AI 调用检查点快照的任务租约不匹配。')
  if (snapshot.payload.schemaVersion !== analysisSnapshotSchemaVersion || snapshot.schemaVersion !== snapshot.payload.schemaVersion) throw new Error('AI 调用检查点快照 payload schema 无效。')
  if (!isNonEmptyString(snapshot.id) || !isNonEmptyString(snapshot.promptVersion) || !isNonEmptyString(snapshot.pipelineVersion)) throw new Error('AI 调用检查点快照元数据不完整。')
  assertCheckpointJson(snapshot.payload, '快照 payload')
  if (!Array.isArray(snapshot.artifacts) || !snapshot.artifacts.some((artifact) => artifact.id === input.artifact.id)) throw new Error('AI 调用检查点快照未包含对应产物。')
  if (!Array.isArray(snapshot.moduleStates) || input.state && !snapshot.moduleStates.some((state) => state.moduleId === input.state?.moduleId && state.artifactId === input.artifact.id && state.attempt === input.state.attempt)) {
    throw new Error('AI 调用检查点快照未包含对应模块状态。')
  }
  for (const artifact of snapshot.artifacts) validateSnapshotArtifact(artifact, input)
  for (const state of snapshot.moduleStates) validateSnapshotModuleState(state, snapshot.artifacts)
  if (!Array.isArray(snapshot.modelCalls) || !snapshot.modelCalls.length) throw new Error('AI 调用检查点快照缺少 modelCalls。')
  const matchingCall = snapshot.modelCalls.find((call) => isMatchingModelCall(call, input.details))
  if (!matchingCall) throw new Error('AI 调用检查点快照未包含对应 model call。')
  for (const call of snapshot.modelCalls) validateSnapshotModelCall(call)
}

function validateSnapshotArtifact(artifact: AnalysisArtifactRecord, input: AnalysisCallCheckpoint) {
  if (artifact.jobId !== input.jobId || artifact.reportVersionId !== input.artifact.reportVersionId || artifact.moduleId !== 'page_analysis') throw new Error('部分快照包含跨任务产物。')
  if (!isNonEmptyString(artifact.id) || !Number.isSafeInteger(artifact.attempt) || artifact.attempt < 1 || !isGateErrors(artifact.gateErrors)) throw new Error('部分快照包含无效产物。')
  assertCheckpointJson(artifact.payload, '快照产物 payload', artifact.status === 'failed')
}

function validateSnapshotModuleState(state: AnalysisModuleState, artifacts: AnalysisArtifactRecord[]) {
  if (state.moduleId !== 'page_analysis' || !['pending', 'running', 'gating', 'retrying', 'accepted', 'failed'].includes(state.status)) throw new Error('部分快照包含无效模块状态。')
  if (!Number.isSafeInteger(state.attempt) || state.attempt < 0 || !Number.isSafeInteger(state.maxAttempts) || state.maxAttempts < 1 || !isNonEmptyTimestamp(state.updatedAt) || !isGateErrors(state.gateErrors)) throw new Error('部分快照包含无效模块状态。')
  if (state.artifactId !== undefined && !artifacts.some((artifact) => artifact.id === state.artifactId)) throw new Error('部分快照状态引用未知产物。')
}

function validateSnapshotModelCall(call: AnalysisSnapshotWrite['modelCalls'][number]) {
  if (!isNonEmptyString(call.provider) || !isNonEmptyString(call.model)
    || call.stage !== 'page_analysis' || call.module !== 'page_analysis'
    || !Number.isSafeInteger(call.tokens) || call.tokens < 0) {
    throw new Error('部分快照包含无效 model call。')
  }
}

function isMatchingModelCall(call: AnalysisSnapshotWrite['modelCalls'][number], details: AnalysisCallCheckpoint['details']) {
  return call.provider === details.provider
    && call.model === details.model
    && call.module === details.module
    && call.stage === details.stage
    && call.tokens === details.tokens
}

function validateCheckpointMonotonicity(database: ReturnType<typeof getDatabase>, input: AnalysisCallCheckpoint, insightCheckpoint: boolean) {
  if (insightCheckpoint) return
  const current = database.prepare('SELECT status, attempt, artifact_id FROM analysis_module_states WHERE job_id = ? AND module_id = ?').get(input.jobId, input.artifact.moduleId) as { status?: string; attempt?: unknown; artifact_id?: string | null } | undefined
  const currentArtifact = current?.artifact_id
    ? database.prepare('SELECT prompt_version, schema_version FROM analysis_artifacts WHERE id = ? AND job_id = ?').get(current.artifact_id, input.jobId) as { prompt_version?: string; schema_version?: unknown } | undefined
    : undefined
  const sameEpoch = !currentArtifact || (currentArtifact.prompt_version === input.artifact.promptVersion && Number(currentArtifact.schema_version) === input.artifact.schemaVersion)
  if (sameEpoch && current && Number.isSafeInteger(Number(current.attempt)) && input.state && input.state.attempt < Number(current.attempt)) throw new Error('模块状态 attempt 不能回退。')
  const accepted = database.prepare("SELECT prompt_version, schema_version, MAX(attempt) AS attempt FROM analysis_artifacts WHERE job_id = ? AND module_id = ? AND status = 'accepted'").get(input.jobId, input.artifact.moduleId) as { prompt_version?: string; schema_version?: unknown; attempt?: unknown } | undefined
  const acceptedEpoch = accepted && accepted.prompt_version === input.artifact.promptVersion && Number(accepted.schema_version) === input.artifact.schemaVersion
  if (input.artifact.status === 'accepted' && acceptedEpoch && accepted?.attempt !== undefined && accepted.attempt !== null && input.artifact.attempt < Number(accepted.attempt)) throw new Error('已接受产物 attempt 不能回退。')
  if (sameEpoch && current?.status === 'accepted' && input.state && input.state.status !== 'accepted') throw new Error('已接受模块不能被降级。')
}

function isCheckpointAlreadyApplied(database: ReturnType<typeof getDatabase>, input: AnalysisCallCheckpoint) {
  const row = database.prepare('SELECT * FROM analysis_artifacts WHERE id = ? AND job_id = ?').get(input.artifact.id, input.jobId) as Record<string, unknown> | undefined
  if (!row) return false
  const existing = artifactFromRow(row)
  if (!sameArtifact(existing, input.artifact)) throw new Error('相同产物 ID 已属于不同的 AI 检查点。')
  // 洞察检查点没有 analysis snapshot；其确定性 artifact ID 本身就是提交屏障。
  if (input.artifact.moduleId === 'report_insight') return true
  const snapshotApplied = input.snapshot
    ? Boolean(database.prepare(`SELECT 1 FROM analysis_snapshots WHERE id = ? AND job_id = ? AND report_version_id = ? AND kind = 'partial' AND schema_version = ${analysisSnapshotSchemaVersion}`).get(input.snapshot.id, input.jobId, input.artifact.reportVersionId))
    : false
  if (!snapshotApplied) throw new Error('已有分析产物但缺少对应部分快照，拒绝重复记录。')
  return true
}

function sameArtifact(left: AnalysisArtifactRecord, right: AnalysisArtifactRecord) {
  return left.id === right.id
    && left.jobId === right.jobId
    && left.reportVersionId === right.reportVersionId
    && left.moduleId === right.moduleId
    && left.schemaVersion === right.schemaVersion
    && left.promptVersion === right.promptVersion
    && left.attempt === right.attempt
    && left.status === right.status
    && sameJson(left.payload, right.payload)
    && sameJson(left.gateErrors, right.gateErrors)
    && left.provider === right.provider
    && left.model === right.model
    && left.createdAt === right.createdAt
    && left.acceptedAt === right.acceptedAt
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function assertCheckpointJson(value: unknown, label: string, allowUndefined = false) {
  if (value === undefined && allowUndefined) return
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new Error('undefined')
    JSON.parse(serialized)
  } catch {
    throw new Error('AI 调用检查点的' + label + '不可序列化。')
  }
}

function isGateErrors(value: unknown): value is GateError[] {
  return Array.isArray(value) && value.every((error) => isRecord(error) && typeof error.code === 'string' && typeof error.path === 'string' && typeof error.message === 'string' && (error.expected === undefined || typeof error.expected === 'string'))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isNonEmptyTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value))
}

function isFutureTimestamp(value: unknown) {
  return isNonEmptyTimestamp(value) && Date.parse(value) > Date.now()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function checkpointAnalysisAiCall(input: AnalysisCallCheckpoint, leaseOwner?: string) {
  return inImmediateTransaction((database) => {
    const effectiveLeaseOwner = resolveCheckpointLeaseOwner(input, leaseOwner)
    const normalizedSnapshot = input.snapshot && input.snapshot.leaseOwner !== effectiveLeaseOwner
      ? { ...input.snapshot, leaseOwner: effectiveLeaseOwner }
      : input.snapshot
    const normalizedInput = normalizedSnapshot === input.snapshot ? input : { ...input, snapshot: normalizedSnapshot }
    const alreadyApplied = isCheckpointAlreadyApplied(database, normalizedInput)
    validateAnalysisCallCheckpoint(database, normalizedInput, effectiveLeaseOwner, alreadyApplied)
    if (alreadyApplied) return
    recordAnalysisAiCallCompletedInDatabase(database, normalizedInput.jobId, normalizedInput.details, effectiveLeaseOwner)
    saveArtifactInDatabase(database, normalizedInput.jobId, normalizedInput.artifact, effectiveLeaseOwner)
    if (normalizedInput.state) saveModuleStateInDatabase(database, normalizedInput.jobId, normalizedInput.state, effectiveLeaseOwner)
    if (normalizedInput.snapshot) saveAnalysisSnapshotInDatabase(database, normalizedInput.snapshot)
  })
}

export function settleCancelledAnalysisAiCall(input: AnalysisCallCheckpoint) {
  return inImmediateTransaction((database) => {
    const alreadyApplied = isCheckpointAlreadyApplied(database, input)
    validateCancelledCallSettlement(database, input, alreadyApplied)
    if (alreadyApplied) return
    recordCancelledAiCallCompletedInDatabase(database, input.jobId, input.details)
    saveCancelledSettlementArtifactInDatabase(database, input.jobId, input.artifact)
  })
}

function validateCancelledCallSettlement(
  database: ReturnType<typeof getDatabase>,
  input: AnalysisCallCheckpoint,
  alreadyApplied: boolean,
) {
  const jobRow = database.prepare('SELECT * FROM analysis_jobs WHERE id = ?').get(input.jobId) as Record<string, unknown> | undefined
  if (!jobRow) throw new Error('AI 调用检查点所属任务不存在。')
  const jobReportVersionId = text(jobRow.report_version_id)
  if (!jobReportVersionId || input.artifact.reportVersionId !== jobReportVersionId) throw new Error('AI 调用检查点的报告版本不匹配。')
  const cancelled = text(jobRow.status) === 'cancelled' || Boolean(jobRow.cancel_requested)
  if (!cancelled && !alreadyApplied) throw new Error('任务未取消，不能走受限终态记账。')
  if (input.snapshot) throw new Error('受限终态记账不能发布分析快照。')
  if (input.state) throw new Error('受限终态记账不能发布模块状态。')
  if (input.artifact.status !== 'failed') throw new Error('受限终态记账只能保存失败产物。')
  const insightCheckpoint = input.artifact.moduleId === 'report_insight'
  const jobType = text(jobRow.type)
  if (insightCheckpoint !== (jobType === 'insight')) throw new Error('AI 调用检查点与任务类型不匹配。')
  validateCheckpointDetails(input.details, insightCheckpoint)
  validateCheckpointAttempt(database, jobRow, input, alreadyApplied, insightCheckpoint)
  validateCheckpointFrozenConfiguration(jobRow, input, insightCheckpoint)
  validateCheckpointArtifact(input.artifact, input.jobId, jobReportVersionId, input.details, insightCheckpoint)
}

function recordCancelledAiCallCompletedInDatabase(
  database: ReturnType<typeof getDatabase>,
  jobId: string,
  details: AnalysisCallCheckpoint['details'],
) {
  const timestamp = now()
  const current = database.prepare('SELECT admission_id, status, cancel_requested FROM analysis_jobs WHERE id = ?').get(jobId) as {
    admission_id?: string | null
    status?: unknown
    cancel_requested?: unknown
  } | undefined
  if (!current) throw new Error('任务已停止，不能记入 AI 调用。')
  const cancelled = text(current.status) === 'cancelled' || Boolean(current.cancel_requested)
  if (!cancelled) throw new Error('任务未取消，不能走受限终态记账。')
  const accounted = recordAiBudgetCallCompletedForJobInDatabase(database, jobId, details)
  if (current.admission_id && !accounted) throw new Error('AI 预算调用记录失败，结果保持未知。')
  const result = database.prepare(`
    UPDATE analysis_jobs
    SET ai_calls_completed = ai_calls_completed + 1,
        ai_tokens = ai_tokens + ?,
        updated_at = ?
    WHERE id = ? AND (status = 'cancelled' OR cancel_requested = 1)
      AND ai_calls_started = ai_calls_completed + 1
  `).run(details.tokens ?? 0, timestamp, jobId)
  if (Number(result.changes) !== 1) throw new Error('任务状态已变化，不能完成受限终态记账。')
  reconcileAiBudgetForJobInDatabase(database, jobId, 'cancelled_call_settled')
}

function saveCancelledSettlementArtifactInDatabase(
  database: ReturnType<typeof getDatabase>,
  jobId: string,
  artifact: AnalysisArtifactRecord,
) {
  if (artifact.status !== 'failed') throw new Error('受限终态记账只能保存失败产物。')
  const result = database.prepare(`
    INSERT INTO analysis_artifacts (
      id, job_id, report_version_id, module_id, schema_version, prompt_version, attempt,
      status, payload_json, gate_errors_json, provider, model, created_at, accepted_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM analysis_jobs
      WHERE id = ? AND report_version_id = ?
        AND (status = 'cancelled' OR cancel_requested = 1)
    )
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      payload_json = excluded.payload_json,
      gate_errors_json = excluded.gate_errors_json,
      provider = excluded.provider,
      model = excluded.model,
      accepted_at = excluded.accepted_at
    WHERE analysis_artifacts.job_id = excluded.job_id
      AND analysis_artifacts.report_version_id = excluded.report_version_id
      AND analysis_artifacts.module_id = excluded.module_id
      AND analysis_artifacts.schema_version = excluded.schema_version
      AND analysis_artifacts.prompt_version = excluded.prompt_version
      AND analysis_artifacts.attempt = excluded.attempt
      AND analysis_artifacts.status != 'accepted'
  `).run(
    artifact.id,
    jobId,
    artifact.reportVersionId,
    artifact.moduleId,
    artifact.schemaVersion,
    artifact.promptVersion,
    artifact.attempt,
    artifact.status,
    artifact.payload === undefined ? null : json(artifact.payload),
    json(artifact.gateErrors),
    artifact.provider ?? null,
    artifact.model ?? null,
    artifact.createdAt,
    artifact.acceptedAt ?? null,
    jobId,
    artifact.reportVersionId,
  )
  if (Number(result.changes) !== 1) throw new Error('任务状态已变化，不能完成受限终态记账。')
}

function hasUncheckpointedAiCall(row: Record<string, unknown>) {
  const started = Number(row.ai_calls_started ?? 0)
  const completed = Number(row.ai_calls_completed ?? 0)
  const snapshotCalls = Number(row.checkpointed_calls ?? 0)
  const persistedArtifacts = Number(row.persisted_artifacts ?? 0)
  const checkpointed = Math.max(snapshotCalls, persistedArtifacts)
  return started > completed || completed > checkpointed
}


function retryDelayTimestamp(timestamp: string, attempts: number) {
  return new Date(Date.parse(timestamp) + getQueueRetryDelayMs(attempts)).toISOString()
}

function scheduleJobRetryInDatabase(
  database: ReturnType<typeof getDatabase>,
  jobId: string,
  workerId: string,
  timestamp: string,
  reason: string,
  message?: string,
) {
  const row = database.prepare(`
    SELECT attempts, lease_owner FROM analysis_jobs
    WHERE id = ? AND status = 'running' AND cancel_requested = 0
  `).get(jobId) as { attempts?: unknown; lease_owner?: string | null } | undefined
  if (!row || (row.lease_owner ?? '') !== workerId) return false
  const attempts = integer(row.attempts)
  const availableAt = retryDelayTimestamp(timestamp, attempts)
  const result = database.prepare(`
    UPDATE analysis_jobs
    SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, available_at = ?,
        last_retry_at = ?, last_retry_reason = ?, last_worker_id = ?,
        last_error_code = ?, last_error_at = ?, error_message = COALESCE(?, error_message), updated_at = ?
    WHERE id = ? AND status = 'running' AND cancel_requested = 0 AND lease_owner = ?
  `).run(availableAt, timestamp, reason, workerId, reason, timestamp, message ?? null, timestamp, jobId, workerId)
  if (Number(result.changes) !== 1) return false
  insertJobEvent(database, jobId, {
    type: 'info',
    message: message
      ? `任务执行未完成，将在 ${availableAt} 后重试（第 ${attempts + 1} 次领取）。`
      : `任务租约已回收，将在 ${availableAt} 后重试（第 ${attempts + 1} 次领取）。`,
  }, timestamp)
  return true
}

function markJobDeadLetterInDatabase(
  database: ReturnType<typeof getDatabase>,
  jobId: string,
  reason: string,
  errorMessage?: string,
) {
  const timestamp = now()
  const message = errorMessage ?? (reason === 'uncheckpointed_ai_call'
    ? 'AI 调用结果未知，已进入死信，避免自动重试造成重复调用。'
    : reason === 'lease_expired_after_ai_call'
      ? 'AI 调用中的任务租约已失效，已进入死信，等待人工确认调用结果。'
      : '任务多次中断，已停止自动重试。')
  const result = database.prepare(`
    UPDATE analysis_jobs
    SET status = 'failed', error_message = COALESCE(error_message, ?),
        last_error_code = ?, last_error_at = ?, last_retry_reason = ?,
        terminal_reason = 'dead_letter', terminal_at = ?,
        lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE id = ? AND status IN ('queued', 'running')
  `).run(message, reason, timestamp, reason, timestamp, timestamp, jobId)
  if (Number(result.changes) !== 1) return false
  reconcileAiBudgetForJobInDatabase(database, jobId, 'dead_letter:' + reason)
  insertRequiredJobEvent(database, jobId, { type: 'failed', message }, timestamp)
  return true
}

function cancelJobInDatabase(database: ReturnType<typeof getDatabase>, jobId: string, timestamp = now()) {
  const result = database.prepare(`
    UPDATE analysis_jobs
    SET status = 'cancelled', cancel_requested = 1, terminal_reason = 'cancelled', terminal_at = ?,
        last_error_code = 'cancelled', last_error_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE id = ? AND status IN ('queued', 'running')
  `).run(timestamp, timestamp, timestamp, jobId)
  if (Number(result.changes) !== 1) return false
  reconcileAiBudgetForJobInDatabase(database, jobId, 'job_cancelled')
  insertRequiredJobEvent(database, jobId, { type: 'cancelled', message: '任务已取消，Worker 将在安全点停止。' }, timestamp)
  return true
}

export function isJobCancellationRequested(jobId: string, leaseOwner?: string) {
  const row = getDatabase().prepare('SELECT cancel_requested, status, lease_owner, lease_expires_at FROM analysis_jobs WHERE id = ?').get(jobId) as {
    cancel_requested: number
    status: string
    lease_owner: string | null
    lease_expires_at: string | null
  } | undefined
  if (!row || Boolean(row.cancel_requested) || row.status === 'cancelled') return true
  if (!leaseOwner) return false
  return row.lease_owner !== leaseOwner || !row.lease_expires_at || row.lease_expires_at <= now()
}

export function cancelJob(jobId: string, actor?: AuthUser) {
  return inImmediateTransaction((database) => {
    const currentRow = database.prepare('SELECT * FROM analysis_jobs WHERE id = ?').get(jobId) as Record<string, unknown> | undefined
    if (!currentRow) return undefined
    if (actor) {
      const report = database.prepare('SELECT project_id FROM report_versions WHERE id = ?').get(text(currentRow.report_version_id)) as { project_id?: string } | undefined
      if (!report?.project_id || !userCanManageProjectInDatabase(database, report.project_id, actor)) throw new ReportAuthorizationChangedError()
    }
    const current = jobFromRow(currentRow)
    if (terminalJobStatuses.has(current.status)) return current
    cancelJobInDatabase(database, jobId)
    return getJob(jobId)
  })
}

export function createRetryJob(jobId: string, actor?: AuthUser) {
  return inImmediateTransaction((database) => {
    const sourceRow = database.prepare('SELECT * FROM analysis_jobs WHERE id = ?').get(jobId) as Record<string, unknown> | undefined
    if (!sourceRow) return undefined
    const source = jobFromRow(sourceRow)
    assertLatestReportVersionInDatabase(database, source.reportVersionId)
    if (actor) {
      const report = database.prepare('SELECT project_id FROM report_versions WHERE id = ?').get(source.reportVersionId) as { project_id?: string } | undefined
      if (!report?.project_id || !userCanManageProjectInDatabase(database, report.project_id, actor)) throw new ReportAuthorizationChangedError()
    }
    if (!terminalJobStatuses.has(source.status)) throw new Error('只有终态任务可以重新执行。')

    // 重试可以从链中的任意历史任务发起，但活动任务约束属于报告本身，而非直接父任务。
    const existing = findActiveAnalysisJobForReport(database, source.reportVersionId)
    if (existing) return existing
    const timestamp = now()
    const retry = createJobRecord(source.reportVersionId, 'rerun', timestamp, source.id, actor)
    const sourceEvaluationContext = parseReportEvaluationContext(sourceRow.evaluation_context_json)
    const transactionalEvaluationContext = resolveStoredReportEvaluationContext(source.reportVersionId).context
    if (sourceEvaluationContext && !evaluationContextsEqual(sourceEvaluationContext, transactionalEvaluationContext)) {
      throw new ReportEvaluationContextChangedError()
    }
    const promptSettings = getAiPromptSettingsSnapshot()
    try {
      insertJob(database, retry, promptSettings, sourceEvaluationContext ?? transactionalEvaluationContext)
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const active = findActiveAnalysisJobForReport(database, source.reportVersionId)
        if (active) return active
        throw new Error('该报告已有正在排队或执行中的分析任务。')
      }
      throw error
    }
    insertInitialModuleStates(database, retry.id, timestamp)
    insertJobEvent(database, retry.id, { type: 'info', message: `已基于任务 ${source.id} 创建新的重试任务。` }, timestamp)
    return retry
  })
}





function hasActiveJobLease(database: ReturnType<typeof getDatabase>, reportVersionId: string, leaseOwner: string) {
  return Boolean(database.prepare("SELECT 1 FROM analysis_jobs WHERE report_version_id = ? AND status = 'running' AND cancel_requested = 0 AND lease_owner = ? AND lease_expires_at > ?").get(reportVersionId, leaseOwner, now()))
}

function findActiveAnalysisJobForReport(database: ReturnType<typeof getDatabase>, reportVersionId: string) {
  const row = database.prepare(`
    SELECT * FROM analysis_jobs
    WHERE report_version_id = ?
      AND type IN ('initial', 'rerun')
      AND status IN ('queued', 'running')
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get(reportVersionId) as Record<string, unknown> | undefined
  return row ? jobFromRow(row) : undefined
}

function findActiveInsightJobForReport(database: ReturnType<typeof getDatabase>, reportVersionId: string) {
  const row = database.prepare(`
    SELECT * FROM analysis_jobs
    WHERE report_version_id = ? AND type = 'insight' AND status IN ('queued', 'running')
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get(reportVersionId) as Record<string, unknown> | undefined
  return row ? jobFromRow(row) : undefined
}

export function getJobEvents(jobId: string, afterId = 0, limit = 100): JobEvent[] {
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
  return (getDatabase().prepare('SELECT * FROM job_events WHERE job_id = ? AND id > ? ORDER BY id ASC LIMIT ?').all(jobId, afterId, boundedLimit) as Record<string, unknown>[]).map(jobEventFromRow)
}

export function publishAnalysisEvent(jobId: string, event: Omit<JobEvent, 'id' | 'jobId' | 'createdAt'>, leaseOwner?: string) {
  // 单条 INSERT ... SELECT 守卫保证校验与写入原子：任务停止/取消后不再插入事件。
  const database = getDatabase()
  const createdAt = now()
  const result = database.prepare(`
    INSERT INTO job_events(job_id, type, stage, module_id, errors_json, message, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM analysis_jobs
      WHERE id = ? AND (? IS NULL OR (status = 'running' AND cancel_requested = 0 AND lease_owner = ? AND lease_expires_at > ?))
    )
  `).run(
    jobId,
    event.type,
    event.stage ?? null,
    event.moduleId ?? null,
    json(event.errors ?? []),
    event.message,
    createdAt,
    jobId,
    leaseOwner ?? null,
    leaseOwner ?? null,
    now(),
  )
  if (Number(result.changes) !== 1) return undefined
  return { ...event, id: Number(result.lastInsertRowid), jobId, createdAt }
}

export function getReportInsight(reportVersionId: string): ReportInsight | undefined {
  const row = getDatabase().prepare('SELECT * FROM report_insights WHERE report_version_id = ?').get(reportVersionId)
  return row ? reportInsightFromRow(row as Record<string, unknown>) : undefined
}

export class ReportInsightReservationLostError extends Error {
  constructor() {
    super('洞察生成占位已失效，本次洞察未保存。')
    this.name = 'ReportInsightReservationLostError'
  }
}

type SaveReportInsightInput = Omit<ReportInsight, 'id' | 'generatedAt'> & { reservationToken?: string }

export function saveReportInsight(input: SaveReportInsightInput, actor?: AuthUser): ReportInsight {
  return inImmediateTransaction((database) => {
    const report = database.prepare('SELECT project_id FROM report_versions WHERE id = ?').get(input.reportVersionId) as { project_id?: string } | undefined
    if (!report) throw new Error('报告版本不存在。')
    if (actor && (!report.project_id || !userCanManageProjectInDatabase(database, report.project_id, actor))) throw new ReportAuthorizationChangedError()
    if (input.reservationToken) {
      const reservation = database.prepare(
        'SELECT 1 AS present FROM report_insight_reservations WHERE report_version_id = ? AND owner_token = ? AND lease_expires_at > ?',
      ).get(input.reportVersionId, input.reservationToken, now())
      if (!reservation) throw new ReportInsightReservationLostError()
    }
    const { reservationToken: _reservationToken, ...insightInput } = input
    return upsertReportInsight(database, insightInput)
  })
}

export class ReportInsightLimitError extends Error {
  constructor() {
    super('报告洞察最多只能重新生成三次。')
    this.name = 'ReportInsightLimitError'
  }
}

function upsertReportInsight(
  database: ReturnType<typeof getDatabase>,
  input: Omit<ReportInsight, 'id' | 'generatedAt'>,
): ReportInsight {
  const existing = database.prepare('SELECT id, regeneration_count FROM report_insights WHERE report_version_id = ?').get(input.reportVersionId) as { id?: string; regeneration_count?: number } | undefined
  const existingRegenerationCount = Math.max(0, Number(existing?.regeneration_count ?? 0))
  if (existing && existingRegenerationCount >= MAX_INSIGHT_REGENERATIONS) throw new ReportInsightLimitError()
  // 同一报告正文版本上的洞察重新生成会递增次数；重新分析不会影响这条记录。
  const regenerationCount = existing ? existingRegenerationCount + 1 : 0
  const insight: ReportInsight = {
    ...input,
    id: existing?.id ?? newId('insight'),
    generatedAt: now(),
    regenerationCount,
  }
  if (existing) {
    database.prepare(`
      UPDATE report_insights
      SET title = ?, summary = ?, reading_minutes = ?, sections_json = ?, html = ?,
          provider = ?, model = ?, generated_at = ?, regeneration_count = ?
      WHERE report_version_id = ?
    `).run(
      insight.title,
      insight.summary,
      insight.readingMinutes,
      json(insight.sections),
      insight.html,
      insight.provider,
      insight.model,
      insight.generatedAt,
      insight.regenerationCount ?? 0,
      insight.reportVersionId,
    )
  } else {
    database.prepare(`
      INSERT INTO report_insights(
        id, report_version_id, title, summary, reading_minutes, sections_json,
        html, provider, model, generated_at, regeneration_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      insight.id,
      insight.reportVersionId,
      insight.title,
      insight.summary,
      insight.readingMinutes,
      json(insight.sections),
      insight.html,
      insight.provider,
      insight.model,
      insight.generatedAt,
      insight.regenerationCount ?? 0,
    )
  }
  return insight
}

export class ReportAnalysisInProgressError extends Error {
  constructor() {
    super('完整分析正在进行，请完成后再生成洞察。')
    this.name = 'ReportAnalysisInProgressError'
  }
}

const reportInsightReservationTtlMs = 15 * 60 * 1000

/** Allows only one insight generation for a report body version at a time. */
export function reserveReportInsightGeneration(reportVersionId: string): boolean {
  return reserveReportInsightGenerationWithToken(reportVersionId) !== undefined
}

export function reserveReportInsightGenerationWithToken(reportVersionId: string, actor?: AuthUser): string | undefined {
  return inImmediateTransaction((database) => {
    const timestamp = new Date()
    const nowIso = timestamp.toISOString()
    const leaseExpiresAt = new Date(timestamp.getTime() + reportInsightReservationTtlMs).toISOString()
    database.prepare('DELETE FROM report_insight_reservations WHERE lease_expires_at <= ?').run(nowIso)
    const report = database.prepare('SELECT project_id FROM report_versions WHERE id = ?').get(reportVersionId) as { project_id?: string } | undefined
    if (!report) throw new Error('报告版本不存在。')
    if (actor && (!report.project_id || !userCanManageProjectInDatabase(database, report.project_id, actor))) throw new ReportAuthorizationChangedError()
    const existingInsight = database.prepare('SELECT regeneration_count FROM report_insights WHERE report_version_id = ?').get(reportVersionId) as { regeneration_count?: number } | undefined
    if (Number(existingInsight?.regeneration_count ?? 0) >= MAX_INSIGHT_REGENERATIONS) throw new ReportInsightLimitError()
    const ownerToken = randomUUID()
    const reservation = database.prepare(`
      INSERT OR IGNORE INTO report_insight_reservations(report_version_id, owner_token, lease_expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(reportVersionId, ownerToken, leaseExpiresAt, nowIso)
    return Number(reservation.changes) === 1 ? ownerToken : undefined
  })
}

export function releaseReportInsightGeneration(reportVersionId: string, ownerToken?: string) {
  const database = getDatabase()
  if (ownerToken) {
    database.prepare(`
      DELETE FROM report_insight_reservations
      WHERE report_version_id = ? AND owner_token = ?
    `).run(reportVersionId, ownerToken)
    return
  }
  database.prepare(`
    DELETE FROM report_insight_reservations
    WHERE report_version_id = ?
  `).run(reportVersionId)
}

export function isReportInsightGenerating(reportVersionId: string): boolean {
  const database = getDatabase()
  const reservation = database.prepare(`
    SELECT 1 AS present FROM report_insight_reservations
    WHERE report_version_id = ? AND lease_expires_at > ?
  `).get(reportVersionId, now())
  if (reservation) return true
  const activeInsight = database.prepare(`
    SELECT 1 AS present FROM analysis_jobs
    WHERE report_version_id = ? AND type = 'insight' AND status IN ('queued', 'running')
    LIMIT 1
  `).get(reportVersionId)
  return Boolean(activeInsight)
}

export function createInsightGenerationJob(reportVersionId: string, actor: AuthUser): AnalysisJob {
  const report = getReportIdentity(reportVersionId)
  if (!report) throw new Error('报告版本不存在。')
  if (!userCanManageProject(report.projectId, actor)) throw new ReportAuthorizationChangedError()

  return inImmediateTransaction((database) => {
    assertLatestReportVersionInDatabase(database, reportVersionId)
    const currentReport = database.prepare('SELECT project_id FROM report_versions WHERE id = ?').get(reportVersionId) as { project_id?: string } | undefined
    if (!currentReport?.project_id) throw new Error('报告版本不存在。')
    if (!userCanManageProjectInDatabase(database, currentReport.project_id, actor)) throw new ReportAuthorizationChangedError()
    const existingInsight = database.prepare('SELECT regeneration_count FROM report_insights WHERE report_version_id = ?').get(reportVersionId) as { regeneration_count?: number } | undefined
    if (Number(existingInsight?.regeneration_count ?? 0) >= MAX_INSIGHT_REGENERATIONS) throw new ReportInsightLimitError()
    database.prepare('DELETE FROM report_insight_reservations WHERE lease_expires_at <= ?').run(now())
    if (database.prepare('SELECT 1 FROM report_insight_reservations WHERE report_version_id = ? AND lease_expires_at > ? LIMIT 1').get(reportVersionId, now())) {
      throw new Error('洞察正在生成，请稍后查看。')
    }
    const active = findActiveInsightJobForReport(database, reportVersionId)
    if (active) throw new Error('洞察正在生成，请稍后查看。')
    const timestamp = now()
    const job = createJobRecord(reportVersionId, 'insight', timestamp, undefined, actor)
    job.priority = 5
    const promptSettings = getAiPromptSettingsSnapshot().filter((prompt) => prompt.target === 'report_insight')
    if (!promptSettings.length) promptSettings.push(getAiPromptConfiguration('report_insight'))
    try {
      insertJob(database, job, promptSettings)
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new Error('洞察正在生成，请稍后查看。')
      throw error
    }
    insertJobEvent(database, job.id, { type: 'info', message: '洞察生成任务已进入队列。' }, timestamp)
    return job
  })
}

/**
 * 洞察写入、任务完成、预算结算与 completed 事件必须在同一带 lease 守卫的事务内提交：
 * 取消、租约过期或 Worker 接管后，任何一步都不允许单独落库，迟到结果不会写入洞察。
 */
export function completeInsightGenerationWithInsight(
  jobId: string,
  insight: Omit<ReportInsight, 'id' | 'generatedAt'>,
  usage: { tokens: number },
  leaseOwner?: string,
) {
  return completeInsightGenerationTransaction(jobId, usage, leaseOwner, insight)
}

function completeInsightGenerationTransaction(
  jobId: string,
  usage: { tokens: number },
  leaseOwner?: string,
  insight?: Omit<ReportInsight, 'id' | 'generatedAt'>,
) {
  return inImmediateTransaction((database) => {
    const currentRow = database.prepare('SELECT * FROM analysis_jobs WHERE id = ?').get(jobId) as Record<string, unknown> | undefined
    if (!currentRow) throw new Error('分析任务不存在。')
    const job = jobFromRow(currentRow)
    if (job.type !== 'insight') throw new Error('当前任务不是洞察生成任务。')
    if (insight) {
      if (insight.reportVersionId !== job.reportVersionId) throw new Error('洞察与任务报告版本不匹配。')
      upsertReportInsight(database, insight)
    }
    const timestamp = now()
    const result = database.prepare(`
      UPDATE analysis_jobs
      SET status = 'completed', current_stage = 'completed', stage_index = ?, error_message = NULL,
          terminal_reason = 'completed', terminal_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'running' AND cancel_requested = 0
        AND (? IS NULL OR (lease_owner = ? AND lease_expires_at > ?))
    `).run(AnalysisStages.indexOf('completed'), timestamp, timestamp, jobId, leaseOwner ?? null, leaseOwner ?? null, timestamp)
    if (Number(result.changes) !== 1) throw new Error('任务已停止，不能完成洞察生成。')
    const settled = settleAiBudgetForJobInDatabase(database, jobId, usage.tokens)
    const budgetRow = database.prepare('SELECT state FROM ai_budget_ledger WHERE job_id = ?').get(jobId) as { state?: string } | undefined
    if (budgetRow && ['reserved', 'uncertain'].includes(String(budgetRow.state)) && !settled) {
      markAiBudgetUncertainForJobInDatabase(database, jobId, 'insight_finalization_with_unknown_ai_call')
    }
    insertRequiredJobEvent(database, jobId, { type: 'completed', stage: 'completed', message: '洞察已生成。' }, timestamp)
    return getJob(jobId)
  })
}

function createReportFacts(report: ReportVersion): ReportFacts {
  return {
    title: report.title,
    paragraphCount: report.paragraphCount,
    characterCount: report.characterCount,
  }
}

function createJobRecord(
  reportVersionId: string,
  type: AnalysisJob['type'],
  timestamp: string,
  parentJobId?: string,
  actor?: AuthUser,
) {
  return {
    id: newId('job'),
    reportVersionId,
    parentJobId,
    type,
    status: 'queued' as const,
    stage: 'validating' as const,
    stageIndex: 0,
    attempts: 0,
    cancelRequested: false,
    requestedByUserId: actor?.id ?? '',
    availableAt: timestamp,
    priority: 0,
    admissionId: undefined as string | undefined,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function insertJob(
  database: ReturnType<typeof getDatabase>,
  job: ReturnType<typeof createJobRecord>,
  promptSettings?: AnalysisPromptConfig[],
  evaluationContext?: ReportEvaluationContext,
) {
  const modelRuntime = job.requestedByUserId ? getAiModelRuntimeSnapshot(job.type === 'insight' ? 'report_insight' : 'page_analysis') : undefined
  if (job.requestedByUserId && !modelRuntime) throw new Error(job.type === 'insight' ? '报告洞察尚未选择模型。' : '分析页尚未选择模型。')
  if (job.requestedByUserId) {
    const reportRow = database.prepare('SELECT project_id FROM report_versions WHERE id = ?').get(job.reportVersionId) as { project_id?: unknown } | undefined
    if (job.type === 'insight') {
      const estimate = estimateInsightBudget()
      job.admissionId = reserveAiBudgetInDatabase(database, {
        userId: job.requestedByUserId,
        projectId: text(reportRow?.project_id),
        operation: 'insight',
        jobId: job.id,
        reportVersionId: job.reportVersionId,
        estimatedTokens: estimate.estimatedTokens,
      })
    } else {
      const estimate = estimateAnalysisBudget(pageAnalysisModule.maxAttempts)
      job.admissionId = reserveAiBudgetInDatabase(database, {
        userId: job.requestedByUserId,
        projectId: text(reportRow?.project_id),
        operation: 'analysis',
        jobId: job.id,
        reportVersionId: job.reportVersionId,
        estimatedTokens: estimate.estimatedTokens,
      })
    }
  }
  database.prepare(`
    INSERT INTO analysis_jobs (
      id, report_version_id, parent_job_id, type, status, current_stage, stage_index, attempts,
      cancel_requested, prompt_config_json, evaluation_context_json, model_runtime_json,
      requested_by_user_id, available_at, priority, admission_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    job.id,
    job.reportVersionId,
    job.parentJobId ?? null,
    job.type,
    job.status,
    job.stage,
    job.stageIndex,
    job.attempts,
    promptSettings ? json(promptSettings) : '[]',
    evaluationContext ? json(evaluationContext) : null,
    modelRuntime ? json(modelRuntime) : null,
    job.requestedByUserId ?? '',
    job.availableAt ?? job.createdAt,
    job.priority ?? 0,
    job.admissionId ?? null,
    job.createdAt,
    job.updatedAt,
  )
}

function insertInitialModuleStates(database: ReturnType<typeof getDatabase>, jobId: string, timestamp: string) {
  database.prepare(`
    INSERT INTO analysis_module_states (
      job_id, module_id, status, attempt, max_attempts, artifact_id, gate_errors_json, updated_at
    ) VALUES (?, ?, 'pending', 0, ?, NULL, '[]', ?)
  `).run(jobId, pageAnalysisModule.id, pageAnalysisModule.maxAttempts, timestamp)
}

function insertRequiredJobEvent(
  database: ReturnType<typeof getDatabase>,
  jobId: string,
  event: Omit<JobEvent, 'id' | 'jobId' | 'createdAt'>,
  timestamp: string,
) {
  const result = database.prepare(`
    INSERT INTO job_events(job_id, type, stage, module_id, errors_json, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(jobId, event.type, event.stage ?? null, event.moduleId ?? null, json(event.errors ?? []), event.message, timestamp)
  return { ...event, id: Number(result.lastInsertRowid), jobId, createdAt: timestamp }
}

function insertJobEvent(
  database: ReturnType<typeof getDatabase>,
  jobId: string,
  event: Omit<JobEvent, 'id' | 'jobId' | 'createdAt'>,
  timestamp: string,
) {
  try {
    return insertRequiredJobEvent(database, jobId, event, timestamp)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(JSON.stringify({ scope: 'analysis_job_event', jobId, eventType: event.type, error: detail.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300) }))
    return undefined
  }
}

let lastJobEventsPruneAt = 0

/** 按时间清理历史任务事件，每个进程每天最多执行一次；多进程重复执行是幂等的。 */
export function pruneJobEventsIfDue(nowMs = Date.now()) {
  if (nowMs - lastJobEventsPruneAt < 24 * 60 * 60 * 1000) return
  pruneJobEvents(nowMs)
  // 清理成功后才推进时钟：失败（如 busy 超时）时下次调用立即重试，而不是停摆一天。
  lastJobEventsPruneAt = nowMs
}

/** 立即执行一次事件清理（不受每日时钟限制），供运维与测试使用。 */
export function pruneJobEvents(nowMs = Date.now()) {
  const retentionDays = runtimeConfig.jobEventsRetentionDays
  const cutoff = new Date(nowMs - retentionDays * 86_400_000).toISOString()
  getDatabase().prepare('DELETE FROM job_events WHERE created_at < ?').run(cutoff)
}

/** 仅供测试重置清理时钟。 */
export function resetJobEventsPruneClock() {
  lastJobEventsPruneAt = 0
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(
    error && typeof error === 'object' &&
    'code' in error && String(error.code) === 'ERR_SQLITE_ERROR' &&
    'message' in error && String(error.message).includes('UNIQUE constraint failed'),
  )
}

function reportInsightFromRow(row: Record<string, unknown>): ReportInsight {
  return {
    id: text(row.id),
    reportVersionId: text(row.report_version_id),
    title: text(row.title),
    summary: text(row.summary),
    readingMinutes: integer(row.reading_minutes),
    sections: parseJson<ReportInsight['sections']>(text(row.sections_json)),
    html: text(row.html),
    provider: text(row.provider),
    model: text(row.model),
    generatedAt: text(row.generated_at),
    regenerationCount: integer(row.regeneration_count ?? 0),
  }
}



export const EXPLICIT_EXAMPLE_PROJECT_IDS = new Set(['project-sample'])

export function isExplicitExampleProject(id: string) {
  return EXPLICIT_EXAMPLE_PROJECT_IDS.has(id)
}

function projectFromRow(row: Record<string, unknown>): Project {
  const id = text(row.id)
  const title = text(row.title)
  const isExample = isExplicitExampleProject(id)
  const rawStatus = text(row.status) as ProjectProgressStatus
  const rawStage = row.stage !== undefined && row.stage !== null && text(row.stage) ? text(row.stage) as ProjectStage : undefined
  const stage: ProjectStage = rawStage || (rawStatus === 'completed' ? '已完成' : rawStatus === 'not_started' ? '开题中' : '推进中')
  return {
    id,
    ownerId: text(row.owner_id),
    title,
    objective: text(row.objective),
    description: text(row.description),
    ownerName: text(row.owner_name),
    collaboratorNames: nullableText(row.collaborator_names) ?? undefined,
    status: rawStatus,
    stage,
    milestones: parseMilestones(text(row.milestones_json)),
    isExample,
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  }
}

interface ReportRowDecorations {
  fullAnalysisDone: Set<string>
}

/** 列表路径批量判断当前报告是否拥有可发布的完整 page_analysis 快照。 */
function loadReportDecorations(reportIds: string[]): ReportRowDecorations {
  const fullAnalysisDone = new Set<string>()
  if (!reportIds.length) return { fullAnalysisDone }
  const idParam = JSON.stringify(reportIds)
  const doneRows = getDatabase().prepare(`
    SELECT report.id AS rid
    FROM report_versions report
    INNER JOIN analysis_snapshots snapshot ON snapshot.id = report.current_analysis_id
    INNER JOIN analysis_jobs job ON job.id = snapshot.job_id
    WHERE report.id IN (SELECT value FROM json_each(?))
      AND snapshot.report_version_id = report.id
      AND snapshot.kind = 'final'
      AND snapshot.schema_version = ${analysisSnapshotSchemaVersion}
      AND job.report_version_id = report.id
      AND job.type IN ('initial', 'rerun')
      AND job.status IN ('completed')
      AND json_valid(snapshot.payload_json)
      AND json_valid(snapshot.module_states_json)
      AND json_valid(snapshot.artifacts_json)
      AND (
        SELECT COUNT(*) FROM json_each(snapshot.module_states_json) state
        WHERE json_extract(state.value, '$.status') = 'accepted'
          AND json_extract(state.value, '$.moduleId') = 'page_analysis'
          AND EXISTS (
            SELECT 1 FROM analysis_artifacts state_artifact
            WHERE state_artifact.id = json_extract(state.value, '$.artifactId')
              AND state_artifact.job_id = snapshot.job_id
              AND state_artifact.module_id = 'page_analysis'
              AND state_artifact.schema_version = 1
              AND state_artifact.status = 'accepted'
          )
      ) = 1
      AND EXISTS (
        SELECT 1 FROM analysis_artifacts artifact
        WHERE artifact.job_id = job.id
          AND artifact.report_version_id = report.id
          AND artifact.module_id = 'page_analysis'
          AND artifact.schema_version = 1
          AND artifact.status = 'accepted'
          AND json_valid(artifact.payload_json)
      )
  `).all(idParam) as Array<{ rid: string }>
  for (const row of doneRows) fullAnalysisDone.add(row.rid)
  return { fullAnalysisDone }
}

function reportFromRow(row: Record<string, unknown>, decorations?: ReportRowDecorations): ReportVersion {
  const reportId = text(row.id)
  return {
    id: reportId,
    projectId: text(row.project_id),
    milestoneId: nullableText(row.milestone_id),
    deliveryType: nullableText(row.delivery_type) as ReportDeliveryType | undefined,
    version: integer(row.version),
    title: text(row.title),
    fileName: text(row.file_name),
    fileHash: text(row.file_hash),
    paragraphCount: integer(row.paragraph_count),
    characterCount: integer(row.character_count),
    previousCharacterCount: nullableInteger(row.previous_character_count),
    parseStatus: text(row.parse_status) as ReportVersion['parseStatus'],
    latestJobStatus: nullableText(row.latest_job_status) as ReportVersion['latestJobStatus'],
    currentAnalysisId: nullableText(row.current_analysis_id),
    hasCompletedFullAnalysis: decorations
      ? decorations.fullAnalysisDone.has(reportId)
      : reportHasCompletedFullAnalysis(reportId),
    createdAt: text(row.created_at),
    sourceUpdatedAt: text(row.source_updated_at) || text(row.created_at),
    previousVersionId: nullableText(row.previous_version_id),
    parseError: nullableText(row.parse_error),
  }
}

function jobFromRow(row: Record<string, unknown>): AnalysisJob {
  return {
    id: text(row.id),
    reportVersionId: text(row.report_version_id),
    type: text(row.type) as AnalysisJob['type'],
    status: text(row.status) as AnalysisJob['status'],
    stage: text(row.current_stage) as AnalysisStage,
    stageIndex: integer(row.stage_index),
    attempts: integer(row.attempts),
    cancelRequested: Boolean(row.cancel_requested),
    requestedByUserId: text(row.requested_by_user_id),
    availableAt: text(row.available_at),
    priority: integer(row.priority),
    admissionId: nullableText(row.admission_id),
    lastClaimedAt: nullableText(row.last_claimed_at),
    lastRetryAt: nullableText(row.last_retry_at),
    lastRetryReason: nullableText(row.last_retry_reason),
    lastWorkerId: nullableText(row.last_worker_id),
    lastErrorCode: nullableText(row.last_error_code),
    lastErrorAt: nullableText(row.last_error_at),
    terminalReason: nullableText(row.terminal_reason),
    terminalAt: nullableText(row.terminal_at),
    aiCallsStarted: integer(row.ai_calls_started),
    aiCallsCompleted: integer(row.ai_calls_completed),
    aiTokens: integer(row.ai_tokens),
    errorMessage: nullableText(row.error_message),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  }
}

function moduleStateFromRow(row: Record<string, unknown>): AnalysisModuleState {
  return {
    moduleId: text(row.module_id) as AnalysisModuleState['moduleId'],
    status: text(row.status) as AnalysisModuleState['status'],
    attempt: integer(row.attempt),
    maxAttempts: integer(row.max_attempts),
    artifactId: nullableText(row.artifact_id),
    gateErrors: parseJson<GateError[]>(text(row.gate_errors_json)),
    updatedAt: text(row.updated_at),
  }
}

function artifactFromRow(row: Record<string, unknown>): AnalysisArtifactRecord {
  return {
    id: text(row.id),
    jobId: text(row.job_id),
    reportVersionId: text(row.report_version_id),
    moduleId: text(row.module_id) as AnalysisTrackedModuleId,
    schemaVersion: integer(row.schema_version),
    promptVersion: text(row.prompt_version),
    attempt: integer(row.attempt),
    status: text(row.status) as AnalysisArtifactRecord['status'],
    payload: row.payload_json ? parseJson(text(row.payload_json)) : undefined,
    gateErrors: parseJson<GateError[]>(text(row.gate_errors_json)),
    provider: nullableText(row.provider),
    model: nullableText(row.model),
    createdAt: text(row.created_at),
    acceptedAt: nullableText(row.accepted_at),
  }
}

function snapshotFromRow(row: Record<string, unknown>): AnalysisSnapshot {
  return {
    id: text(row.id),
    reportVersionId: text(row.report_version_id),
    schemaVersion: integer(row.schema_version),
    promptVersion: text(row.prompt_version),
    pipelineVersion: text(row.pipeline_version),
    modelCalls: parseJson<AnalysisSnapshot['modelCalls']>(text(row.model_calls_json)),
    artifacts: parseJson<AnalysisArtifactRecord[]>(text(row.artifacts_json)),
    moduleStates: parseJson<AnalysisModuleState[]>(text(row.module_states_json)),
    payload: parseJson<AnalysisSnapshot['payload']>(text(row.payload_json)),
    createdAt: text(row.created_at),
  }
}

function jobEventFromRow(row: Record<string, unknown>): JobEvent {
  return {
    id: integer(row.id),
    jobId: text(row.job_id),
    type: text(row.type) as AnalysisJobEventType,
    stage: nullableText(row.stage) as AnalysisStage | undefined,
    moduleId: nullableText(row.module_id) as AnalysisTrackedModuleId | undefined,
    errors: parseJson<GateError[]>(text(row.errors_json)),
    message: text(row.message),
    createdAt: text(row.created_at),
  }
}

function rows(sql: string, ...parameters: Array<string | number>) {
  return getDatabase().prepare(sql).all(...parameters) as Record<string, unknown>[]
}

function optionalRow<T>(sql: string, parameter: string, convert: (row: Record<string, unknown>) => T) {
  const row = getDatabase().prepare(sql).get(parameter) as Record<string, unknown> | undefined
  return row ? convert(row) : undefined
}


function newId(prefix: string) {
  return `${prefix}-${randomUUID()}`
}

function now() {
  return new Date().toISOString()
}

function json(value: unknown) {
  return JSON.stringify(value)
}

function parseJson<T = unknown>(value: string): T {
  return JSON.parse(value) as T
}

function isCanonicalPageAnalysisPayload(value: unknown): value is AnalysisSnapshotPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const payload = value as Partial<AnalysisSnapshotPayload>
  return payload.schemaVersion === analysisSnapshotSchemaVersion
    && Boolean(payload.reportDetails)
    && Boolean(payload.reportCompleteness)
    && Boolean(payload.aiScore)
    && Array.isArray(payload.suggestions)
    && Boolean(payload.visualization)
}

function parseStoredPromptSettings(value: unknown): AnalysisPromptConfig[] | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const parsed = parseJson<unknown>(value)
    if (!Array.isArray(parsed) || !parsed.length) return undefined
    const valid = parsed.filter((item): item is AnalysisPromptConfig => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false
      const prompt = item as Partial<AnalysisPromptConfig>
      return isAiPromptTarget(prompt.target)
        && typeof prompt.systemPrompt === 'string'
        && typeof prompt.instructionPrompt === 'string'
        && typeof prompt.version === 'number'
        && Number.isInteger(prompt.version)
        && typeof prompt.updatedAt === 'string'
        && typeof prompt.updatedBy === 'string'
    })
    return valid.length === parsed.length ? valid : undefined
  } catch {
    return undefined
  }
}

function readPublishedOverallValue(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value >= 0 && value <= 100 ? value : undefined
}

function readPublishedSectionCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.trunc(value)
}

function text(value: unknown) {
  return typeof value === 'string' ? value : String(value ?? '')
}

function nullableText(value: unknown) {
  return value === null || value === undefined ? undefined : text(value)
}

function integer(value: unknown) {
  return typeof value === 'number' ? Math.trunc(value) : Number(value ?? 0)
}

function nullableInteger(value: unknown) {
  return value === null || value === undefined ? undefined : integer(value)
}


export interface KnowledgeItem {
  id: string
  title: string
  fileName: string
  fileSize: number
  category: string
  description: string
  tags: string[]
  sourcePath: string
  fileHash: string
  uploadedBy: string
  uploadedByUserId: string
  createdAt: string
  updatedAt: string
}

function mimeTypeForKnowledgeFile(fileName: string) {
  return /\.pdf$/i.test(fileName) ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
}

function knowledgeItemFromRow(row: Record<string, unknown>): KnowledgeItem {
  let tags: string[] = []
  try {
    const parsed = JSON.parse(String(row.tags_json || '[]'))
    if (Array.isArray(parsed)) tags = parsed.map(String)
  } catch {
    tags = []
  }
  return {
    id: text(row.id),
    title: text(row.title),
    fileName: text(row.file_name),
    fileSize: integer(row.file_size),
    category: text(row.category || '行业研报'),
    description: text(row.description || ''),
    tags,
    sourcePath: text(row.source_path),
    fileHash: text(row.file_hash),
    uploadedBy: text(row.uploaded_by || '系统用户'),
    uploadedByUserId: text(row.uploaded_by_user_id),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  }
}

export function listKnowledgeItems(category?: string, pagination?: ListPagination): KnowledgeItem[] {
  const suffix = pagination ? ' LIMIT ? OFFSET ?' : ''
  const parameters: Array<string | number> = []
  let query = 'SELECT * FROM knowledge_items'
  if (category && category !== '全部') {
    query += ' WHERE category = ?'
    parameters.push(category)
  }
  query += ' ORDER BY created_at DESC, id DESC' + suffix
  if (pagination) parameters.push(pagination.limit, pagination.offset)
  return rows(query, ...parameters).map(knowledgeItemFromRow)
}

export function countKnowledgeItems(category?: string): number {
  const row = category && category !== '全部'
    ? getDatabase().prepare('SELECT COUNT(*) AS count FROM knowledge_items WHERE category = ?').get(category)
    : getDatabase().prepare('SELECT COUNT(*) AS count FROM knowledge_items').get()
  return integer((row as { count?: unknown } | undefined)?.count)
}

export function getKnowledgeItem(id: string): KnowledgeItem | undefined {
  const row = getDatabase().prepare('SELECT * FROM knowledge_items WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? knowledgeItemFromRow(row) : undefined
}

export function createKnowledgeItem(item: Omit<KnowledgeItem, 'createdAt' | 'updatedAt'>, actor?: AuthUser, storageReservationId?: string): KnowledgeItem {
  const timestamp = new Date().toISOString()
  return inImmediateTransaction((database) => {
    if (actor) {
      const currentActor = database.prepare("SELECT 1 FROM users WHERE id = ? AND status = 'active'").get(actor.id)
      if (!currentActor || item.uploadedByUserId !== actor.id) throw new ReportAuthorizationChangedError()
    }
    database.prepare(`
    INSERT INTO knowledge_items(
      id, title, file_name, file_size, category, description, tags_json, source_path, file_hash,
      uploaded_by, uploaded_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.id,
    item.title,
    item.fileName,
    item.fileSize,
    item.category,
    item.description,
    JSON.stringify(item.tags || []),
    item.sourcePath,
    item.fileHash,
    item.uploadedBy,
    item.uploadedByUserId,
      timestamp,
      timestamp,
    )
    if (storageReservationId) {
      if (!actor) throw new Error('存储预留缺少上传者。')
      consumeStorageReservationInDatabase(database, storageReservationId, {
        ownerType: 'knowledge', ownerId: item.id, userId: actor.id, projectId: null,
        sizeBytes: item.fileSize, fileHash: item.fileHash, sourcePath: item.sourcePath, mimeType: mimeTypeForKnowledgeFile(item.fileName),
      })
    }
    const row = database.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(item.id) as Record<string, unknown>
    return knowledgeItemFromRow(row)
  })
}

export function userCanDeleteKnowledgeItem(item: KnowledgeItem, user: AuthUser): boolean {
  return user.role === 'admin' || (Boolean(item.uploadedByUserId) && item.uploadedByUserId === user.id)
}

export async function deleteKnowledgeItem(id: string, actor?: AuthUser): Promise<boolean> {
  const sourcePath = inImmediateTransaction((database) => {
    const row = database.prepare('SELECT source_path, uploaded_by_user_id FROM knowledge_items WHERE id = ?').get(id) as { source_path?: string; uploaded_by_user_id?: string | null } | undefined
    if (!row) return undefined
    if (actor) {
      const currentActor = database.prepare("SELECT role, status FROM users WHERE id = ?").get(actor.id) as { role?: string; status?: string } | undefined
      const allowed = currentActor?.status === 'active' && (currentActor.role === 'admin' || row.uploaded_by_user_id === actor.id)
      if (!allowed) throw new ReportAuthorizationChangedError()
    }
    releaseStorageAllocationInDatabase(database, 'knowledge', id)
    database.prepare('DELETE FROM knowledge_items WHERE id = ?').run(id)
    return row.source_path
  })
  if (!sourcePath) return false
  const cleanupTarget = getKnowledgeCleanupTarget(sourcePath)
  if (cleanupTarget) await rm(cleanupTarget, { recursive: true, force: true }).catch(() => undefined)
  return true
}


export interface ReportWithProject extends ReportVersion {
  projectTitle: string
  projectOwnerName: string
  aiScore?: number
  completeness?: number
  sectionCount?: number
}

export function listAllReportsWithProjects(pagination?: ListPagination): ReportWithProject[] {
  const suffix = pagination ? ' LIMIT ? OFFSET ?' : ''
  const parameters: Array<string | number> = []
  if (pagination) parameters.push(pagination.limit, pagination.offset)
  const reportRows = rows(`
    SELECT report_versions.*, projects.title AS project_title, projects.owner_name AS project_owner_name,
           ${publishedMetricSql('current_snapshot.payload_json', '$.aiScore')} AS analysis_ai_score,
           ${publishedMetricSql('current_snapshot.payload_json', '$.reportCompleteness')} AS analysis_completeness,
           ${publishedSectionCountSql('current_snapshot.payload_json')} AS analysis_section_count,
           ${latestFullJobStatusSql()} AS latest_job_status
    FROM report_versions
    JOIN projects ON projects.id = report_versions.project_id
    ${canonicalCurrentSnapshotJoin('current_snapshot', 'report_versions')}
    ORDER BY report_versions.created_at DESC, report_versions.id DESC${suffix}
  `, ...parameters)
  const decorations = loadReportDecorations(reportRows.map((row) => text(row.id)))
  return reportRows.map((row) => {
    return {
      ...reportFromRow(row, decorations),
      projectTitle: text(row.project_title),
      projectOwnerName: text(row.project_owner_name),
      aiScore: readPublishedOverallValue(row.analysis_ai_score),
      completeness: readPublishedOverallValue(row.analysis_completeness),
      sectionCount: readPublishedSectionCount(row.analysis_section_count),
    }
  })
}

export function listOverviewActivityReports(limit?: number): ReportWithProject[] {
  const suffix = limit === undefined ? '' : ' LIMIT ?'
  const reportRows = rows(`
    SELECT report_versions.*, projects.title AS project_title, projects.owner_name AS project_owner_name,
      ${publishedMetricSql('current_snapshot.payload_json', '$.aiScore')} AS analysis_ai_score,
      ${publishedMetricSql('current_snapshot.payload_json', '$.reportCompleteness')} AS analysis_completeness,
      ${latestFullJobStatusSql()} AS latest_job_status
    FROM projects
    INNER JOIN report_versions ON report_versions.id = (
      SELECT candidate.id
      FROM report_versions candidate
      WHERE candidate.project_id = projects.id
      ORDER BY CASE WHEN COALESCE(${latestFullJobStatusSql('candidate.id')}, '') IN ('queued', 'running') THEN 0 ELSE 1 END,
      candidate.source_updated_at DESC,
      candidate.version DESC
      LIMIT 1
    )
    ${canonicalCurrentSnapshotJoin('current_snapshot', 'report_versions')}
    ORDER BY CASE WHEN latest_job_status IN ('queued', 'running') THEN 0 ELSE 1 END,
      report_versions.source_updated_at DESC${suffix}
  `, ...(limit === undefined ? [] : [limit]))
  const decorations = loadReportDecorations(reportRows.map((row) => text(row.id)))
  return reportRows.map((row) => {
    return {
      ...reportFromRow(row, decorations),
      projectTitle: text(row.project_title),
      projectOwnerName: text(row.project_owner_name),
      aiScore: readPublishedOverallValue(row.analysis_ai_score),
      completeness: readPublishedOverallValue(row.analysis_completeness),
    }
  })
}

export function countAllReportsWithProjects(): number {
  const row = getDatabase().prepare(`
    SELECT COUNT(*) AS count
    FROM report_versions
    JOIN projects ON projects.id = report_versions.project_id
  `).get() as { count?: unknown } | undefined
  return integer(row?.count)
}

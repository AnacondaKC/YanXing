import { randomUUID } from 'node:crypto'
import { logUnexpectedError } from '@/lib/http/public-error'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { pageResult, type PaginationInput } from '@/lib/http/pagination'
import { nextMonotonicIsoTimestamp } from '@/lib/monotonic-iso-timestamp'
import { OVERVIEW_TREND_DAYS } from '@/lib/overview-trends'
import { notificationActions, type NotificationAction, type NotificationItem } from '@/modules/notifications/domain'
import type { ProjectMemberRole } from '@/modules/projects/domain'
import { freezeProjectWorkflow, type ProjectStageRecord, type StageCompletionReason, type StageLifecycleStatus } from '@/modules/projects/stage-domain'
import { PROJECT_FIELD_LIMITS } from '@/modules/projects/validation'
import { resolveReportDeletionAccess, resolveReportOperationAccess } from '@/modules/reports/submission-policy'
import { SubmissionTaskError } from '@/modules/reports/submission-task-domain'
import type { ReportSubmissionRepository } from '@/lib/db/report-submission-repository'
import type { SubmissionQueryRepository } from '@/lib/db/submission-query-repository'
import type { SubmissionTaskRepository } from '@/lib/db/submission-task-repository'
import { ReportSubmissionError } from '@/modules/reports/upload-domain'
import {
  actorCanEditConfiguration, actorCanWrite, projectDetail, projectListItem, queryProjection, reportCard, reportDetailFromNative,
  stageGroup, writeContext, type WorkspaceActorView, type WorkspaceProjectRecord,
} from '@/modules/reports/workspace-query'
import type {
  WorkspaceKnowledgeCard, WorkspaceOverview, WorkspaceProjectDetail, WorkspaceProjectSafeEdit,
  WorkspaceReportCard, WorkspaceReportDetail, WorkspaceSelectionSource,
} from '@/modules/contracts/submission-workspace'

type Row = Record<string, SQLOutputValue>
const NOTIFICATION_SUMMARY_MAX = 240
const NOTIFICATION_DETAIL_MAX = 2_000
const TITLE_MAX = 240
const RECENT_LIMIT = 8

export class SubmissionWorkspaceRepository {
  constructor(private readonly input: {
    database: DatabaseSync
    tasks: SubmissionTaskRepository
    queries: SubmissionQueryRepository
    reports: ReportSubmissionRepository
  }) {}

  listProjects(input: { actorId: string; pagination: PaginationInput }) {
    const actor = this.requireActor(input.actorId)
    const total = this.count('SELECT COUNT(*) AS count FROM projects')
    const rows = this.database.prepare('SELECT id FROM projects ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?').all(input.pagination.limit, input.pagination.offset) as Array<{ id: string }>
    const contexts = this.projectContexts(actor, rows.map(row => row.id))
    const counts = this.database.prepare('SELECT project_id, COUNT(*) AS count, (SELECT id FROM report_submissions latest WHERE latest.project_id=r.project_id AND latest.deleted_at IS NULL ORDER BY submission_sequence DESC LIMIT 1) AS latest_id FROM report_submissions r WHERE deleted_at IS NULL AND project_id IN (SELECT value FROM json_each(?)) GROUP BY project_id').all(JSON.stringify(rows.map(row => row.id)))
    const latestCards = new Map(this.cards(actor, counts.map(row => String(row.latest_id)), contexts).map(card => [card.projectId, card]))
    const projects = rows.map(row => {
      const context = contexts.get(row.id)!
      return projectListItem({ ...context, submittedReportCount: Number(counts.find(count => count.project_id === row.id)?.count ?? 0), completedStageCount: context.workflow.stages.filter(stage => stage.lifecycleStatus === 'completed').length, latestSubmission: latestCards.get(row.id) })
    })
    const page = pageResult(projects, total, input.pagination)
    return { projects: page.items, total: page.total, limit: page.limit, offset: page.offset, hasMore: page.hasMore }
  }

  getProjectDetail(input: { actorId: string; projectId: string; requested?: { stageId?: string; reportId?: string; source?: WorkspaceSelectionSource } }): WorkspaceProjectDetail {
    const actor = this.requireActor(input.actorId)
    const assembled = this.assembleProject(actor, input.projectId)
    const selection = queryProjection.defaultSelection({ workflow: assembled.workflow, stages: assembled.stages, latestSubmission: assembled.latestSubmission, requested: input.requested })
    const selectedReport = selection.selected.reportId ? this.getReportDetail({ actorId: actor.id, reportId: selection.selected.reportId }) : undefined
    return projectDetail({ project: assembled.project, workflow: assembled.workflow, stages: assembled.stages, canWrite: assembled.canWrite, canEditConfiguration: assembled.canEditConfiguration, latestSubmission: assembled.latestSubmission, selectedReport, requested: input.requested })
  }

  listStages(input: { actorId: string; projectId: string }) {
    const detail = this.getProjectDetail(input)
    return { workflow: detail.workflow, stages: detail.stages, latestSubmissionReportId: detail.latestSubmission?.id, currentCompletionByStage: detail.currentCompletionByStage }
  }

  listStageReports(input: { actorId: string; projectId: string; stageId: string; pagination: PaginationInput }) {
    const assembled = this.assembleProject(this.requireActor(input.actorId), input.projectId)
    const group = assembled.stages.find((item) => item.stage.id === input.stageId)
    if (!group) throw notFound('STAGE_NOT_FOUND', '阶段不存在。')
    const items = group.reports.slice(input.pagination.offset, input.pagination.offset + input.pagination.limit)
    const page = pageResult(items, group.reports.length, input.pagination)
    return { reports: items, total: page.total, limit: page.limit, offset: page.offset, hasMore: page.hasMore }
  }

  listProjectReports(input: { actorId: string; projectId: string; pagination: PaginationInput }) {
    const assembled = this.assembleProject(this.requireActor(input.actorId), input.projectId)
    const reports = assembled.stages.flatMap((group) => group.reports).sort((left, right) => right.submissionSequence - left.submissionSequence)
    const items = reports.slice(input.pagination.offset, input.pagination.offset + input.pagination.limit)
    const page = pageResult(items, reports.length, input.pagination)
    return { reports: items, total: page.total, limit: page.limit, offset: page.offset, hasMore: page.hasMore }
  }

  listHistory(input: { actorId: string; projectId: string; pagination: PaginationInput }) {
    const detail = this.getProjectDetail(input)
    const timeline = detail.stages.flatMap((group) => group.reports).sort((left, right) => right.submissionSequence - left.submissionSequence)
    const page = pageResult(timeline.slice(input.pagination.offset, input.pagination.offset + input.pagination.limit), timeline.length, input.pagination)
    return { currentStageId: detail.workflow.currentStageId, latestSubmissionReportId: detail.latestSubmission?.id, currentCompletionByStage: detail.currentCompletionByStage, groups: detail.stages, timeline: page.items, total: page.total, limit: page.limit, offset: page.offset, hasMore: page.hasMore }
  }

  listLibraryReports(input: { actorId: string; pagination: PaginationInput }) {
    const actor = this.requireActor(input.actorId)
    const total = this.count('SELECT COUNT(*) AS count FROM report_submissions WHERE deleted_at IS NULL')
    const rows = this.database.prepare('SELECT id FROM report_submissions WHERE deleted_at IS NULL ORDER BY submitted_at DESC, submission_sequence DESC, id DESC LIMIT ? OFFSET ?').all(input.pagination.limit, input.pagination.offset) as Array<{ id: string }>
    const reports = this.cards(actor, rows.map(row => row.id))
    const page = pageResult(reports, total, input.pagination)
    return { reports, total: page.total, limit: page.limit, offset: page.offset, hasMore: page.hasMore }
  }

  getReportCard(input: { actorId: string; reportId: string }): WorkspaceReportCard {
    const card = this.cards(this.requireActor(input.actorId), [input.reportId])[0]
    if (!card) throw notFound('REPORT_NOT_FOUND', '报告不存在。')
    return card
  }

  getReportDetail(input: { actorId: string; reportId: string }): WorkspaceReportDetail {
    const actor = this.requireActor(input.actorId)
    const native = this.input.queries.detail(actor.id, input.reportId)
    const report = this.input.tasks.getReport(input.reportId)
    if (!report || report.deletedAt) throw notFound('REPORT_NOT_FOUND', '报告不存在。')
    const assembled = this.projectContexts(actor, [report.projectId]).get(report.projectId)!
    const stage = assembled.workflow.stages.find((item) => item.id === report.stageId)
    if (!stage) throw notFound('STAGE_NOT_FOUND', '阶段不存在。')
    return reportDetailFromNative({ ...native, report, stage, canWrite: assembled.canWrite, canEditConfiguration: assembled.canEditConfiguration, projectTitle: assembled.project.title, dispatch: native.dispatch })
  }

  safeEditProject(input: { actorId: string; projectId: string; edit: WorkspaceProjectSafeEdit }): WorkspaceProjectDetail {
    const committed = this.transact(() => {
      const actor = this.requireActor(input.actorId)
      this.input.reports.assertCanEditConfiguration(actor.id, input.projectId)
      const current = this.projectRow(input.projectId)
      if (!current) throw notFound('PROJECT_NOT_FOUND', '课题不存在。')
      if (String(current.updated_at) !== input.edit.expectedUpdatedAt) throw new ReportSubmissionError('PROJECT_UPDATE_CONFLICT', '课题已被其他人更新，请刷新后重试。', 409)
      const title = input.edit.title?.trim() ?? String(current.title)
      const objective = input.edit.objective?.trim() ?? String(current.objective ?? '')
      const description = input.edit.description?.trim() ?? String(current.description ?? '')
      if (!title) throw new ReportSubmissionError('INVALID_SUBMISSION', '课题标题不能为空。', 400)
      if (title.length > PROJECT_FIELD_LIMITS.title || objective.length > PROJECT_FIELD_LIMITS.objective || description.length > PROJECT_FIELD_LIMITS.description) {
        throw new ReportSubmissionError('INVALID_SUBMISSION', '课题字段长度超过限制。', 400)
      }
      const updatedAt = nextMonotonicIsoTimestamp(String(current.updated_at))
      const result = this.database.prepare('UPDATE projects SET title = ?, objective = ?, description = ?, updated_at = ? WHERE id = ? AND updated_at = ?').run(title, objective, description, updatedAt, input.projectId, input.edit.expectedUpdatedAt)
      if (Number(result.changes) !== 1) throw new ReportSubmissionError('PROJECT_UPDATE_CONFLICT', '课题已被其他人更新，请刷新后重试。', 409)
      return { actor, title, changed: [
        input.edit.title !== undefined && title !== String(current.title) ? '标题' : '',
        input.edit.objective !== undefined && objective !== String(current.objective ?? '') ? '研究目标' : '',
        input.edit.description !== undefined && description !== String(current.description ?? '') ? '课题说明' : '',
      ].filter(Boolean) }
    })
    if (committed.changed.length) {
      this.recordActivity({ action: notificationActions.projectUpdated, actor: committed.actor, projectId: input.projectId, projectTitle: committed.title, summary: '修改课题「' + committed.title + '」', detail: committed.actor.displayName + ' 修改课题「' + committed.title + '」，变更内容：' + committed.changed.join('、') + '。' })
    }
    return this.getProjectDetail({ actorId: committed.actor.id, projectId: input.projectId })
  }

  overview(input: { actorId: string }): WorkspaceOverview {
    const actor = this.requireActor(input.actorId)
    const now = new Date()
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - OVERVIEW_TREND_DAYS + 1).toISOString()
    const reportStats = this.database.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(character_count),0) AS characters, SUM(julianday(submitted_at)>=julianday(?)) AS weekly FROM report_submissions WHERE deleted_at IS NULL').get(weekStart)!
    const knowledgeStats = this.database.prepare('SELECT COUNT(*) AS count, COUNT(DISTINCT category) AS categories, SUM(julianday(created_at)>=julianday(?)) AS weekly FROM knowledge_items').get(weekStart)!
    const completedStageCount = this.count("SELECT COUNT(*) AS count FROM project_stages WHERE lifecycle_status = 'completed'")
    const taskStats = this.database.prepare('SELECT status, COUNT(*) AS count FROM submission_tasks GROUP BY status').all()
    const countStatus = (status: string) => Number(taskStats.find(row => row.status === status)?.count ?? 0)
    const jobStats = { completed: countStatus('completed'), failed: countStatus('failed'), cancelled: countStatus('cancelled'), running: countStatus('running'), queued: countStatus('queued') }
    const submissions = this.aggregateTrend('SELECT submitted_at AS at, 1 AS value FROM report_submissions WHERE deleted_at IS NULL', now)
    const characters = this.aggregateTrend('SELECT submitted_at AS at, character_count AS value FROM report_submissions WHERE deleted_at IS NULL', now)
    const knowledge = this.aggregateTrend('SELECT created_at AS at, 1 AS value FROM knowledge_items', now)
    const successes = this.aggregateTrend("SELECT created_at AS at, CASE WHEN status='completed' THEN 1 ELSE 0 END AS value FROM submission_tasks", now)
    const scores = this.aggregateTrend(`SELECT created_at AS at, value FROM (
      SELECT created_at, CASE WHEN json_valid(payload_json) AND json_extract(payload_json,'$.kind')='analysis' AND json_type(payload_json,'$.snapshot.payload.aiScore.overall') IN ('integer','real')
      THEN json_extract(payload_json,'$.snapshot.payload.aiScore.overall') END AS value
      FROM submission_task_results WHERE operation='analysis') WHERE typeof(value) IN ('integer','real') AND value BETWEEN 0 AND 100`, now)
    const analyzedProjects = this.aggregateTrend("SELECT MIN(results.created_at) AS at, 1 AS value FROM submission_task_results results JOIN report_submissions reports ON reports.id=results.report_id WHERE results.operation='analysis' AND reports.deleted_at IS NULL GROUP BY reports.project_id", now)
    const recentIds = this.database.prepare('SELECT id FROM report_submissions WHERE deleted_at IS NULL ORDER BY submitted_at DESC, submission_sequence DESC, id DESC LIMIT ?').all(RECENT_LIMIT) as Array<{ id: string }>
    const activityIds = this.database.prepare('SELECT report_id AS id FROM submission_tasks ORDER BY updated_at DESC, id DESC LIMIT ?').all(RECENT_LIMIT) as Array<{ id: string }>
    const cardMap = new Map(this.cards(actor, [...new Set([...uniqueIds(recentIds), ...uniqueIds(activityIds)])]).map(card => [card.id, card]))
    return {
      stats: {
        submittedReportCount: Number(reportStats.count), totalCharacters: Number(reportStats.characters), knowledgeCount: Number(knowledgeStats.count), knowledgeCategoryCount: Number(knowledgeStats.categories), completedStageCount, jobStats,
        weeklyNewReports: Number(reportStats.weekly ?? 0), weeklyNewKnowledge: Number(knowledgeStats.weekly ?? 0),
        trends: { submissions: submissions.map(row => row.sum), characters: characters.map(row => row.sum), knowledge: knowledge.map(row => row.sum),
          successRate: successes.map(row => row.count ? Math.round(row.sum / row.count * 100) : 0),
          averageScore: scores.map(row => row.count ? Math.round(row.sum / row.count) : 0), analyzedProjects: analyzedProjects.map(row => row.sum) },
      },
      recentReports: uniqueIds(recentIds).flatMap(id => cardMap.get(id) ?? []),
      activityReports: uniqueIds(activityIds).flatMap(id => cardMap.get(id) ?? []),
      recentKnowledge: this.recentKnowledge(actor),
    }
  }

  listNotifications(input: { actorId: string; pagination: PaginationInput }) {
    const actor = this.requireActor(input.actorId)
    const rows = this.database.prepare('SELECT id, action, actor_name, project_id, project_title, report_id, report_title, summary, detail, read_at, created_at FROM notifications WHERE recipient_user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?').all(actor.id, input.pagination.limit, input.pagination.offset) as Row[]
    const items = rows.flatMap((row) => { const item = notificationFromRow(row, actor.role === 'admin'); return item ? [item] : [] })
    const total = this.count('SELECT COUNT(*) AS count FROM notifications WHERE recipient_user_id = ?', actor.id)
    const unreadCount = this.count('SELECT COUNT(*) AS count FROM notifications WHERE recipient_user_id = ? AND read_at IS NULL', actor.id)
    const page = pageResult(items, total, input.pagination)
    return { notifications: page.items, total: page.total, unreadCount, limit: page.limit, offset: page.offset, hasMore: page.hasMore }
  }

  markNotificationsRead(input: { actorId: string; all?: boolean; ids?: readonly string[] }) {
    const actor = this.requireActor(input.actorId)
    const ids = input.all === true ? [] : [...new Set((input.ids ?? []).filter(Boolean))]
    if (input.all !== true && !ids.length) return 0
    const filter = input.all === true ? '' : ' AND id IN (' + ids.map(() => '?').join(', ') + ')'
    const result = this.database.prepare('UPDATE notifications SET read_at = ? WHERE recipient_user_id = ? AND read_at IS NULL' + filter).run(new Date().toISOString(), actor.id, ...ids)
    return Number(result.changes)
  }

  listTaskEvents(input: { actorId: string; jobId: string; afterId: number; limit: number }) {
    this.requireActor(input.actorId)
    this.input.queries.task(input.actorId, input.jobId)
    const rows = this.database.prepare('SELECT id, job_id, report_id, kind, message, created_at FROM submission_task_events WHERE job_id = ? AND id > ? ORDER BY id ASC LIMIT ?').all(input.jobId, input.afterId, input.limit) as Row[]
    return rows.map((row) => {
      const kind = String(row.kind)
      const event: { id: number; type: string; jobId?: string; reportId: string; message: string; createdAt: string } = {
        id: Number(row.id), type: kind, reportId: String(row.report_id), message: String(row.message), createdAt: String(row.created_at),
      }
      if (row.job_id) event.jobId = String(row.job_id)
      return event
    })
  }

  jobView(input: { actorId: string; jobId: string }) {
    const task = this.input.queries.task(input.actorId, input.jobId)
    const analysisTask = this.input.tasks.latestTask(task.reportId, 'analysis')
    const insightTask = this.input.tasks.latestTask(task.reportId, 'insight')
    return {
      job: task, analysisTask, insightTask,
      progress: {
        analysis: analysisTask ? { stage: analysisTask.stage, stageIndex: analysisTask.stageIndex, status: analysisTask.status, cancelRequested: analysisTask.cancelRequested } : undefined,
        insight: insightTask ? { stage: insightTask.stage, stageIndex: insightTask.stageIndex, status: insightTask.status, cancelRequested: insightTask.cancelRequested } : undefined,
      },
    }
  }

  recordActivity(input: { action: NotificationAction; actor: WorkspaceActorView; summary: string; detail: string; projectId?: string; projectTitle?: string; reportId?: string; reportTitle?: string }) {
    const summary = clip(input.summary, NOTIFICATION_SUMMARY_MAX)
    const detail = clip(input.detail || input.summary, NOTIFICATION_DETAIL_MAX)
    if (!summary || !detail) return
    try {
      this.transact(() => {
        const recipients = this.database.prepare("SELECT id FROM users WHERE status = 'active' AND (role = 'admin' OR EXISTS (SELECT 1 FROM project_members members WHERE members.project_id = ? AND members.user_id = users.id AND members.role IN ('owner', 'editor')))").all(input.projectId ?? '') as Array<{ id: string }>
        const insert = this.database.prepare('INSERT INTO notifications (id, recipient_user_id, action, actor_user_id, actor_name, project_id, project_title, report_id, report_title, summary, detail, read_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)')
        const createdAt = new Date().toISOString()
        for (const recipient of recipients) {
          insert.run('notification-' + randomUUID(), recipient.id, input.action, input.actor.id, clip(input.actor.displayName, TITLE_MAX), input.projectId ?? null, clip(input.projectTitle ?? '', TITLE_MAX), input.reportId ?? null, input.reportTitle ? clip(input.reportTitle, TITLE_MAX) : null, summary, detail, createdAt)
        }
      })
    } catch (error) { logUnexpectedError('workspace-notification', error) }
  }

  actor(actorId: string) { return this.requireActor(actorId) }

  private transact<T>(work: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      try { this.database.exec('ROLLBACK') } catch { /* transaction already closed */ }
      throw error
    }
  }

  private get database() { return this.input.database }

  private requireActor(actorId: string): WorkspaceActorView {
    const row = this.database.prepare('SELECT id, role, status, display_name FROM users WHERE id = ?').get(actorId) as Row | undefined
    if (!row || String(row.status) !== 'active') throw new SubmissionTaskError('UNAUTHENTICATED', '未登录。', 401)
    const role = String(row.role)
    if (role !== 'admin' && role !== 'researcher') throw new SubmissionTaskError('UNAUTHENTICATED', '未登录。', 401)
    return { id: String(row.id), role, status: 'active', displayName: String(row.display_name) }
  }

  private projectContexts(actor: WorkspaceActorView, projectIds: readonly string[]) {
    const ids = JSON.stringify([...new Set(projectIds)])
    const rows = this.database.prepare('SELECT id, title, objective, description, owner_name, created_at, updated_at FROM projects WHERE id IN (SELECT value FROM json_each(?))').all(ids)
    const members = this.database.prepare('SELECT m.project_id, m.user_id, m.role, u.display_name FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id IN (SELECT value FROM json_each(?)) ORDER BY u.display_name').all(ids)
    const states = this.database.prepare('SELECT project_id, plan_revision, workflow_revision, next_submission_sequence, completed_at FROM project_report_state WHERE project_id IN (SELECT value FROM json_each(?))').all(ids)
    const stages = this.database.prepare('SELECT * FROM project_stages WHERE project_id IN (SELECT value FROM json_each(?)) ORDER BY ordinal').all(ids).map(mapStage)
    return new Map(rows.map(row => {
      const projectId = String(row.id)
      const membership = members.find(member => member.project_id === projectId && member.user_id === actor.id)
      const project: WorkspaceProjectRecord = { id: projectId, title: String(row.title), objective: String(row.objective ?? ''), description: String(row.description ?? ''), ownerName: String(row.owner_name ?? ''),
        ownerId: String(members.find(member => member.project_id === projectId && member.role === 'owner')?.user_id ?? ''),
        collaboratorNames: members.filter(member => member.project_id === projectId && member.role === 'editor').map(member => String(member.display_name)).join('、') || undefined,
        memberRole: membership?.role as ProjectMemberRole | undefined, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
      const state = states.find(state => state.project_id === projectId)
      if (!state) throw new ReportSubmissionError('STAGE_PLAN_MISSING', '请先创建研究计划。', 409)
      const workflow = freezeProjectWorkflow({ projectId, planRevision: Number(state.plan_revision), workflowRevision: Number(state.workflow_revision), nextSubmissionSequence: Number(state.next_submission_sequence), completedAt: state.completed_at ? String(state.completed_at) : undefined, stages: stages.filter(stage => stage.projectId === projectId) })
      const access = writeContext({ actor, projectId, membershipRole: project.memberRole })
      return [projectId, { project, workflow, access, canWrite: actorCanWrite({ actor, projectId, membershipRole: project.memberRole }), canEditConfiguration: actorCanEditConfiguration({ actor, projectId, membershipRole: project.memberRole }) }] as const
    }))
  }

  private cards(actor: WorkspaceActorView, ids: readonly string[], contexts?: ReturnType<SubmissionWorkspaceRepository['projectContexts']>) {
    if (!ids.length) return []
    const projections = this.input.queries.batch(ids)
    const projects = contexts ?? this.projectContexts(actor, projections.map(item => item.report.projectId))
    const cards = new Map(projections.map(item => {
      const context = projects.get(item.report.projectId)
      if (!context) throw notFound('PROJECT_NOT_FOUND', '课题不存在。')
      const stage = context.workflow.stages.find(stage => stage.id === item.report.stageId)
      if (!stage) throw notFound('STAGE_NOT_FOUND', '阶段不存在。')
      return [item.report.id, reportCard({ ...item, stage, latestSubmissionId: item.latest?.id, canWrite: context.canWrite, canEditConfiguration: context.canEditConfiguration, projectTitle: context.project.title,
        analysisDecision: resolveReportOperationAccess({ access: context.access, report: item.report, latestSubmission: item.latest, history: item.operations.analysis }),
        insightDecision: resolveReportOperationAccess({ access: context.access, report: item.report, latestSubmission: item.latest, history: item.operations.insight }),
        deletionDecision: resolveReportDeletionAccess({ access: context.access, report: item.report, stage, operations: item.operations }) })] as const
    }))
    return ids.flatMap(id => { const card = cards.get(id); return card ? [card] : [] })
  }

  private assembleProject(actor: WorkspaceActorView, projectId: string) {
    const contexts = this.projectContexts(actor, [projectId])
    const context = contexts.get(projectId)
    if (!context) throw notFound('PROJECT_NOT_FOUND', '课题不存在。')
    const rows = this.database.prepare('SELECT id FROM report_submissions WHERE project_id=? AND deleted_at IS NULL ORDER BY submission_sequence DESC').all(projectId)
    const cards = this.cards(actor, rows.map(row => String(row.id)), contexts)
    const stages = context.workflow.stages.map(stage => stageGroup({ stage, canWrite: context.canWrite, reports: cards.filter(card => card.stageId === stage.id) }))
    return { ...context, stages, latestSubmission: cards[0] }
  }

  private projectRow(projectId: string) {
    return this.database.prepare('SELECT id, title, objective, description, owner_name, created_at, updated_at FROM projects WHERE id = ?').get(projectId) as Row | undefined
  }

  private recentKnowledge(actor: WorkspaceActorView): WorkspaceKnowledgeCard[] {
    const rows = this.database.prepare('SELECT id, title, file_name, file_size, category, description, tags_json, uploaded_by, uploaded_by_user_id, created_at, updated_at FROM knowledge_items ORDER BY created_at DESC, id DESC LIMIT ?').all(RECENT_LIMIT) as Row[]
    return rows.map((row) => {
      let tags: string[] = []
      try { const parsed = JSON.parse(String(row.tags_json || '[]')); if (Array.isArray(parsed)) tags = parsed.map(String) } catch { tags = [] }
      const uploadedByUserId = String(row.uploaded_by_user_id ?? '')
      return { id: String(row.id), title: String(row.title), fileName: String(row.file_name), fileSize: Number(row.file_size), category: String(row.category || '行业研报'), description: String(row.description ?? ''), tags, uploadedBy: String(row.uploaded_by || '系统用户'), canDelete: actor.role === 'admin' || uploadedByUserId === actor.id, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
    })
  }

  private count(sql: string, ...parameters: Array<string | number>) {
    const row = this.database.prepare(sql).get(...parameters) as { count?: unknown } | undefined
    return Number(row?.count ?? 0)
  }

  private aggregateTrend(eventsSql: string, now: Date) {
    // Local-midnight cutoffs preserve DST and include all pre-window events in the baseline.
    const cutoffs = Array.from({ length: OVERVIEW_TREND_DAYS }, (_, index) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - OVERVIEW_TREND_DAYS + index + 2).toISOString())
    return this.database.prepare(`WITH events AS (` + eventsSql + `)
      SELECT COALESCE(SUM(events.value),0) AS sum, COUNT(events.value) AS count
      FROM json_each(?) days LEFT JOIN events ON julianday(events.at)<julianday(days.value)
      GROUP BY days.key ORDER BY CAST(days.key AS INTEGER)`).all(JSON.stringify(cutoffs)).map(row => ({ sum: Number(row.sum), count: Number(row.count) }))
  }

}

function uniqueIds(rows: Array<{ id: string }>) { return [...new Set(rows.map((row) => String(row.id)))] }
function notFound(code: string, message: string): never { throw new SubmissionTaskError(code, message, 404) }
function clip(value: string, max: number) { const normalized = value.trim(); return normalized.length > max ? normalized.slice(0, max - 1) + '…' : normalized }

function notificationFromRow(row: Row, includeDetail: boolean): NotificationItem | undefined {
  const action = row.action
  if (typeof action !== 'string' || !isNotificationAction(action)) return undefined
  const item: NotificationItem = { id: String(row.id ?? ''), action, summary: String(row.summary ?? ''), createdAt: String(row.created_at ?? ''), read: row.read_at !== null && row.read_at !== undefined }
  const projectId = optionalText(row.project_id); const projectTitle = optionalText(row.project_title)
  const reportId = optionalText(row.report_id); const reportTitle = optionalText(row.report_title)
  if (projectId) item.projectId = projectId
  if (projectTitle) item.projectTitle = projectTitle
  if (reportId) item.reportId = reportId
  if (reportTitle) item.reportTitle = reportTitle
  if (includeDetail) {
    const actorName = optionalText(row.actor_name); const detail = optionalText(row.detail)
    if (actorName) item.actorName = actorName
    if (detail) item.detail = detail
  }
  return item
}

function isNotificationAction(value: string): value is NotificationAction {
  return (Object.values(notificationActions) as string[]).includes(value)
}

function optionalText(value: SQLOutputValue) { return typeof value === 'string' && value ? value : undefined }

function mapStage(row: Row): ProjectStageRecord {
  const stage: ProjectStageRecord = { id: String(row.id), projectId: String(row.project_id), ordinal: Number(row.ordinal), title: String(row.title), lifecycleStatus: String(row.lifecycle_status) as StageLifecycleStatus, nextReportVersion: Number(row.next_report_version), stateRevision: Number(row.state_revision), completionRevision: Number(row.completion_revision) }
  if (row.description) stage.description = String(row.description)
  if (row.planned_start_at) stage.plannedStartAt = String(row.planned_start_at)
  if (row.planned_end_at) stage.plannedEndAt = String(row.planned_end_at)
  if (row.started_at) stage.startedAt = String(row.started_at)
  if (row.completed_at) stage.completedAt = String(row.completed_at)
  if (row.completion_reason) stage.completionReason = String(row.completion_reason) as StageCompletionReason
  if (row.current_completion_report_id) stage.currentCompletionReportId = String(row.current_completion_report_id)
  return stage
}

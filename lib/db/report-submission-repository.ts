import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { isReportSubmissionCommand, isReportSubmissionIdempotencyKey } from '@/modules/contracts/report-submission'
import type { ProjectMemberRole } from '@/modules/projects/domain'
import {
  STAGE_FIELD_LIMITS,
  assertValidStageWorkflow,
  assertStagePlanEdit,
  StageWorkflowError,
  freezeProjectWorkflow,
  initializeStageWorkflow,
  isIdentity,
  type ProjectStageRecord,
  type ProjectWorkflow,
  type StageCompletionReason,
  type StageLifecycleStatus,
  type StagePlanInput,
} from '@/modules/projects/stage-domain'
import { planStageReportSubmission } from '@/modules/projects/stage-workflow'
import type { ReportSubmission } from '@/modules/reports/submission-domain'
import { canEditProjectConfiguration } from '@/modules/projects/configuration-policy'
import { canWriteProjectReports } from '@/modules/reports/submission-policy'
import {
  ReportSubmissionError,
  type PreparedReportFile,
  type ReportSubmissionConfirmation,
  type ReportSubmissionReceipt,
  type ReportUploadRecord,
  type ReportUploadStatus,
  type SubmissionFailureCode,
  type SubmissionQuota,
} from '@/modules/reports/upload-domain'
import type { UserRole, UserStatus } from '@/modules/users/domain'
import { isStageProjectCreate, isStagePlanEdit, type StageProjectCreate, type StagePlanEdit } from '@/modules/projects/stage-project-contract'

const uploadSelect = 'SELECT id, project_id, actor_id, file_name, status, reservation_id, reserved_bytes, created_at, expires_at, source_key, mime_type, file_hash, source_size, title, document_text, paragraph_count, character_count, report_id, error_code FROM report_uploads WHERE id = ?'

interface UploadRow {
  id: string; project_id: string; actor_id: string; file_name: string; status: string
  reservation_id: string; reserved_bytes: number; created_at: string; expires_at: string
  source_key: string | null; mime_type: string | null; file_hash: string | null
  source_size: number | null; title: string | null; document_text: string | null
  paragraph_count: number | null; character_count: number | null
  report_id: string | null; error_code: string | null
}

interface StateRow {
  project_id: string; plan_revision: number; workflow_revision: number
  next_submission_sequence: number; completed_at: string | null
}

export class ReportSubmissionRepository {
  private readonly database: DatabaseSync
  private readonly quota: SubmissionQuota
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(input: { database: DatabaseSync; quota: SubmissionQuota; now?: () => Date; newId?: () => string }) {
    this.database = input.database
    this.quota = input.quota
    this.now = input.now ?? (() => new Date())
    this.newId = input.newId ?? randomUUID
  }

  initializePlan(input: { actorId: string; projectId: string; stages: readonly StagePlanInput[] }): ProjectWorkflow {
    return this.transact(() => {
      this.assertCanWrite(input.actorId, input.projectId)
      if (this.readState(input.projectId)) fail('STAGE_PLAN_EXISTS', '该课题已创建研究计划。')
      const workflow = this.initializePlanRecord(input.projectId, input.stages)
      this.auditPlan(input.actorId, workflow, { event: 'plan_initialized', after: workflow })
      return workflow
    })
  }

  createProject(input: { actorId: string; project: StageProjectCreate }): ProjectWorkflow {
    if (!isStageProjectCreate(input.project) || !input.project.title.trim() || !input.project.objective.trim() || !input.project.description.trim()) {
      fail('INVALID_SUBMISSION', '课题信息无效。', 400)
    }
    return this.transact(() => {
      const actor = this.database.prepare("SELECT role FROM users WHERE id=? AND status='active'").get(input.actorId)
      const draft = input.project
      if (!actor || !['admin','researcher'].includes(String(actor.role)) || (draft.ownerId !== input.actorId && actor.role !== 'admin')) fail('REPORT_WRITE_FORBIDDEN', '不能为其他用户创建课题。', 403)
      const collaborators = draft.collaboratorIds ?? []
      if (collaborators.includes(draft.ownerId)) fail('PROJECT_MEMBER_INVALID', '负责人不能同时作为协作者。', 400)
      const members = [draft.ownerId, ...collaborators].map(id => this.database.prepare("SELECT id,display_name FROM users WHERE id=? AND status='active'").get(id))
      if (members.some(member => !member)) fail('PROJECT_MEMBER_INVALID', '课题成员不存在或已停用。', 400)
      const projectId = this.newId()
      const at = this.timestamp()
      this.database.prepare('INSERT INTO projects(id,title,objective,description,owner_name,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(projectId,draft.title.trim(),draft.objective.trim(),draft.description.trim(),String(members[0]!.display_name),at,at)
      const memberStatement = this.database.prepare('INSERT INTO project_members(project_id,user_id,role,created_at) VALUES (?,?,?,?)')
      memberStatement.run(projectId,draft.ownerId,'owner',at)
      for (const id of collaborators) memberStatement.run(projectId,id,'editor',at)
      const workflow = this.initializePlanRecord(projectId,draft.stages)
      this.auditPlan(input.actorId,workflow,{event:'project_created',after:workflow,ownerId:draft.ownerId,collaboratorIds:collaborators})
      return workflow
    })
  }

  editPlan(input: {actorId:string;projectId:string;edit:StagePlanEdit}): ProjectWorkflow {
    if (!isStagePlanEdit(input.edit)) fail('INVALID_SUBMISSION','研究计划参数无效。',400)
    return this.transact(() => {
      this.assertCanEditConfiguration(input.actorId, input.projectId)
      const before = this.readWorkflow(input.projectId)
      if (before.planRevision !== input.edit.expectedPlanRevision) throw new StageWorkflowError('PROJECT_PLAN_CHANGED','研究计划已变更，请刷新重试。')
      const previous = String(this.database.prepare('SELECT updated_at FROM projects WHERE id=?').get(input.projectId)?.updated_at)
      const at = new Date(Math.max(this.now().getTime(),Date.parse(previous)+1)).toISOString()
      const after = assertStagePlanEdit({workflow:before,nextStages:input.edit.nextStages,editedAt:at})
      const structural = before.stages.length !== after.stages.length || before.stages.some((stage,index)=>stage.id!==after.stages[index]?.id)
      if (structural) {
        this.assertStageIdsAvailable(input.projectId,after.stages)
        this.database.prepare('DELETE FROM project_stages WHERE project_id=?').run(input.projectId)
        for (const stage of after.stages) this.insertStage(stage)
      } else {
        const update = this.database.prepare('UPDATE project_stages SET title=?,description=?,planned_start_at=?,planned_end_at=? WHERE id=? AND project_id=?')
        for (const stage of after.stages) update.run(stage.title,stage.description??null,stage.plannedStartAt??null,stage.plannedEndAt??null,stage.id,input.projectId)
      }
      this.database.prepare('UPDATE project_report_state SET plan_revision=? WHERE project_id=?').run(after.planRevision,input.projectId)
      this.database.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(at,input.projectId)
      this.auditPlan(input.actorId,after,{event:'stage_plan_edited',before,after})
      return this.readWorkflow(input.projectId)
    })
  }

  private initializePlanRecord(projectId: string, stages: readonly StagePlanInput[]): ProjectWorkflow {
    const workflow = initializeStageWorkflow({projectId,stages,startedAt:this.timestamp()})
    this.assertStageIdsAvailable(projectId,workflow.stages)
    this.database.prepare('INSERT INTO project_report_state(project_id) VALUES (?)').run(projectId)
    for (const stage of workflow.stages) this.insertStage(stage)
    return this.readWorkflow(projectId)
  }

  private assertStageIdsAvailable(projectId:string,stages:readonly StagePlanInput[]) {
    const query=this.database.prepare('SELECT project_id FROM project_stages WHERE id=?')
    for(const stage of stages) {
      const existing=query.get(stage.id)
      if(existing && existing.project_id!==projectId) throw new StageWorkflowError('INVALID_STAGE_PLAN','阶段编号已属于其他课题。')
    }
  }

  private auditPlan(actorId: string, workflow: ProjectWorkflow, event: {event:string;[key:string]:unknown}): void {
    this.database.prepare('INSERT INTO stage_project_audit(id,project_id,actor_id,event_type,plan_revision,payload_json,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(this.newId(),workflow.projectId,actorId,event.event,workflow.planRevision,JSON.stringify(event),this.timestamp())
  }

  loadWorkflow(input: { actorId: string; projectId: string }): ProjectWorkflow {
    this.assertCanEditConfiguration(input.actorId, input.projectId)
    return this.readWorkflow(input.projectId)
  }

  beginUpload(input: { actorId: string; projectId: string; uploadId: string; fileName: string; reservedBytes: number; expiresAt: string }): ReportUploadRecord {
    return this.transact(() => {
      this.assertCanWrite(input.actorId, input.projectId)
      this.readWorkflow(input.projectId)
      if (!isIdentity(input.uploadId, STAGE_FIELD_LIMITS.id)) fail('INVALID_SUBMISSION', '上传编号无效。', 400)
      if (typeof input.fileName !== 'string' || !input.fileName.trim()) fail('INVALID_SUBMISSION', '文件名无效。', 400)
      if (!Number.isSafeInteger(input.reservedBytes) || input.reservedBytes < 1) fail('INVALID_SUBMISSION', '预留容量无效。', 400)
      const createdAt = this.timestamp()
      if (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.parse(createdAt)) {
        fail('INVALID_SUBMISSION', '上传过期时间无效。', 400)
      }
      if (this.selectUpload(input.uploadId)) fail('INVALID_SUBMISSION', '上传编号已存在。', 400)
      const reservationId = this.quota.reserve({
        database: this.database,
        actorId: input.actorId,
        projectId: input.projectId,
        expectedBytes: input.reservedBytes,
      })
      this.database.prepare(
        "INSERT INTO report_uploads(id, project_id, actor_id, file_name, status, reservation_id, reserved_bytes, created_at, expires_at) VALUES (?, ?, ?, ?, 'receiving', ?, ?, ?, ?)",
      ).run(input.uploadId, input.projectId, input.actorId, input.fileName, reservationId, input.reservedBytes, createdAt, input.expiresAt)
      return this.mapUpload(this.requireUploadRow(input.uploadId))
    })
  }

  markParsing(input: { actorId: string; projectId: string; uploadId: string }): ReportUploadRecord {
    return this.transact(() => {
      this.assertCanWrite(input.actorId, input.projectId)
      const upload = this.requireOwnedUpload(input)
      this.assertUsable(upload, 'parsing')
      if (upload.status === 'parsing') return upload
      this.updateStatus(upload.id, 'receiving', 'parsing')
      return this.mapUpload(this.requireUploadRow(upload.id))
    })
  }

  markReady(input: { actorId: string; projectId: string; uploadId: string; file: PreparedReportFile }): ReportUploadRecord {
    return this.transact(() => {
      this.assertCanWrite(input.actorId, input.projectId)
      const upload = this.requireOwnedUpload(input)
      this.assertUsable(upload, 'ready')
      if (upload.status === 'ready') return upload
      if (upload.status !== 'parsing') fail('UPLOAD_NOT_READY', '文件尚未完成解析，不能提交。')
      assertPreparedFile(input.file, upload)
      this.database.prepare(
        "UPDATE report_uploads SET status = 'ready', source_key = ?, mime_type = ?, file_hash = ?, source_size = ?, title = ?, document_text = ?, paragraph_count = ?, character_count = ? WHERE id = ? AND status = 'parsing'",
      ).run(
        input.file.sourceKey,
        input.file.mimeType,
        input.file.fileHash,
        input.file.sourceSize,
        input.file.title,
        input.file.text,
        input.file.paragraphCount,
        input.file.characterCount,
        upload.id,
      )
      return this.mapUpload(this.requireUploadRow(upload.id))
    })
  }

  failUpload(input: { actorId: string; projectId: string; uploadId: string; errorCode: string }): ReportUploadRecord {
    return this.transact(() => {
      const upload = this.requireOwnedUpload(input)
      if (typeof input.errorCode !== 'string' || !input.errorCode.trim()) fail('INVALID_SUBMISSION', '失败原因无效。', 400)
      if (upload.status === 'committed') fail('UPLOAD_ALREADY_COMMITTED', '该上传已生成正式报告。')
      if (upload.status === 'reclaiming' || upload.status === 'reclaimed') return upload
      if (upload.status !== 'failed') {
        this.database.prepare(
          "UPDATE report_uploads SET status = 'failed', error_code = ? WHERE id = ? AND status != 'committed'",
        ).run(input.errorCode, upload.id)
        this.quota.release({ database: this.database, reservationId: upload.reservationId })
      }
      return this.mapUpload(this.requireUploadRow(upload.id))
    })
  }

  getUpload(input: { actorId: string; projectId: string; uploadId: string }): ReportUploadRecord {
    this.assertCanWrite(input.actorId, input.projectId)
    return this.requireOwnedUpload(input)
  }

  replayConfirmation(input: ReportSubmissionConfirmation): { receipt: ReportSubmissionReceipt; replayed: true } | undefined {
    return this.transact(() => {
      const confirmation = this.requireConfirmation(input)
      this.assertCanWrite(confirmation.actorId, confirmation.projectId)
      const receipt = this.readReceipt(confirmation)
      return receipt ? { receipt, replayed: true } : undefined
    })
  }

  confirmSubmission(input: ReportSubmissionConfirmation): { receipt: ReportSubmissionReceipt; replayed: boolean } {
    return this.transact(() => {
      const confirmation = this.requireConfirmation(input)
      this.assertCanWrite(confirmation.actorId, confirmation.projectId)
      const replayed = this.readReceipt(confirmation)
      if (replayed) return { receipt: replayed, replayed: true }

      const upload = this.requireOwnedUpload({
        actorId: confirmation.actorId,
        projectId: confirmation.projectId,
        uploadId: confirmation.command.uploadId,
      })
      this.assertUsable(upload, 'committed')
      if (upload.status === 'committed') fail('UPLOAD_ALREADY_COMMITTED', '该上传已生成正式报告。')
      if (upload.status !== 'ready' || !upload.prepared) fail('UPLOAD_NOT_READY', '文件尚未完成解析，不能提交。')

      const workflow = this.readWorkflow(confirmation.projectId)
      const submittedAt = this.timestamp()
      const reportId = this.newId()
      const planned = planStageReportSubmission({
        workflow,
        reportId,
        stageId: confirmation.command.stageId,
        reportKind: confirmation.command.reportKind,
        submittedAt,
        expectedPlanRevision: confirmation.command.expectedPlanRevision,
        expectedWorkflowRevision: confirmation.command.expectedWorkflowRevision,
        expectedCompletionRevision: confirmation.command.expectedCompletionRevision,
        expectedCompletionReportId: confirmation.command.expectedCompletionReportId,
      })
      const file = upload.prepared
      const report: ReportSubmission = {
        id: reportId,
        projectId: confirmation.projectId,
        stageId: confirmation.command.stageId,
        stageVersion: planned.allocation.stageVersion,
        submissionSequence: planned.allocation.submissionSequence,
        submittedAs: confirmation.command.reportKind,
        title: file.title,
        fileName: upload.fileName,
        sourceKey: file.sourceKey,
        fileHash: file.fileHash,
        sourceSize: file.sourceSize,
        paragraphCount: file.paragraphCount,
        characterCount: file.characterCount,
        submittedBy: confirmation.actorId,
        submittedAt,
        wasFirstStageSubmission: planned.allocation.stageVersion === 1,
      }
      this.insertReport(report)
      this.database.prepare('INSERT INTO report_submission_documents(report_id, text, mime_type) VALUES (?, ?, ?)').run(report.id, file.text, file.mimeType)
      this.writeStages(planned.workflow)
      this.database.prepare(
        'UPDATE project_report_state SET plan_revision = ?, workflow_revision = ?, next_submission_sequence = ?, completed_at = ? WHERE project_id = ?',
      ).run(
        planned.workflow.planRevision,
        planned.workflow.workflowRevision,
        planned.workflow.nextSubmissionSequence,
        planned.workflow.completedAt ?? null,
        planned.workflow.projectId,
      )
      this.quota.consume({
        database: this.database,
        reservationId: upload.reservationId,
        report,
        mimeType: file.mimeType,
      })
      this.database.prepare(
        "UPDATE report_uploads SET status = 'committed', document_text = NULL, report_id = ? WHERE id = ? AND status = 'ready'",
      ).run(report.id, upload.id)
      for (const event of planned.events) {
        this.database.prepare(
          'INSERT INTO report_submission_audit(id, project_id, report_id, actor_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(this.newId(), report.projectId, report.id, report.submittedBy, event.type, JSON.stringify(event), submittedAt)
      }
      const outboxEventId = this.newId()
      this.database.prepare(
        "INSERT INTO report_submission_outbox(id, report_id, project_id, actor_id, event_type, payload_json, status, attempts, available_at, created_at) VALUES (?, ?, ?, ?, 'report_submitted', ?, 'pending', 0, ?, ?)",
      ).run(outboxEventId, report.id, report.projectId, report.submittedBy, JSON.stringify({
        reportId: report.id,
        projectId: report.projectId,
        stageId: report.stageId,
        stageVersion: report.stageVersion,
        submissionSequence: report.submissionSequence,
        submittedAs: report.submittedAs,
        submittedAt: report.submittedAt,
        actorId: report.submittedBy,
        previousCompletionReportId: planned.previousCompletionReportId,
        events: planned.events,
        workflow: planned.workflow,
      }), submittedAt, submittedAt)
      const receipt: ReportSubmissionReceipt = {
        reportId: report.id,
        projectId: report.projectId,
        stageId: report.stageId,
        stageVersion: report.stageVersion,
        submissionSequence: report.submissionSequence,
        submittedAs: report.submittedAs,
        submittedAt: report.submittedAt,
        outboxEventId,
      }
      try {
        this.database.prepare(
          'INSERT INTO report_submission_requests(actor_id, project_id, idempotency_key, request_digest, upload_id, report_id, receipt_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          confirmation.actorId,
          confirmation.projectId,
          confirmation.idempotencyKey,
          requestDigest(confirmation.command),
          upload.id,
          report.id,
          serializeReceipt(receipt),
          submittedAt,
        )
      } catch (error) {
        if (isUniqueConstraint(error, 'report_submission_requests.upload_id')) {
          fail('UPLOAD_ALREADY_COMMITTED', '该上传已生成正式报告。')
        }
        if (isUniqueConstraint(error, 'report_submission_requests')) fail('IDEMPOTENCY_KEY_REUSED', '幂等键已被不同请求使用。')
        throw error
      }
      return { receipt, replayed: false }
    })
  }

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

  private timestamp() {
    return this.now().toISOString()
  }

  assertCanEditConfiguration(actorId: string, projectId: string): void {
    if (!canEditProjectConfiguration(this.projectAccess(actorId, projectId))) {
      fail('PROJECT_CONFIGURATION_FORBIDDEN', '没有编辑课题配置的权限。', 403)
    }
  }

  private assertCanWrite(actorId: string, projectId: string) {
    if (!canWriteProjectReports(this.projectAccess(actorId, projectId))) {
      fail('REPORT_WRITE_FORBIDDEN', '没有上传或提交报告的权限。', 403)
    }
  }

  private projectAccess(actorId: string, projectId: string) {
    const project = this.database.prepare('SELECT id FROM projects WHERE id = ?').get(projectId) as { id: string } | undefined
    if (!project) fail('PROJECT_NOT_FOUND', '课题不存在。', 404)
    const user = this.database.prepare('SELECT id, role, status FROM users WHERE id = ?').get(actorId) as { id: string; role: string; status: string } | undefined
    const member = this.database.prepare(
      'SELECT project_id, user_id, role FROM project_members WHERE project_id = ? AND user_id = ?',
    ).get(projectId, actorId) as { project_id: string; user_id: string; role: string } | undefined
    const actor = user && isUserRole(user.role) && isUserStatus(user.status)
      ? { id: user.id, role: user.role, status: user.status }
      : undefined
    const membership = member && isMemberRole(member.role)
      ? { projectId: member.project_id, userId: member.user_id, role: member.role }
      : undefined
    return { projectId, actor, membership }
  }

  private requireConfirmation(input: ReportSubmissionConfirmation): ReportSubmissionConfirmation {
    if (!isReportSubmissionIdempotencyKey(input.idempotencyKey) || !isReportSubmissionCommand(input.command)) {
      fail('INVALID_SUBMISSION', '提交请求无效。', 400)
    }
    if (typeof input.actorId !== 'string' || typeof input.projectId !== 'string') {
      fail('INVALID_SUBMISSION', '提交请求无效。', 400)
    }
    return input
  }

  private readReceipt(input: ReportSubmissionConfirmation): ReportSubmissionReceipt | undefined {
    const row = this.database.prepare(
      'SELECT request_digest, receipt_json FROM report_submission_requests WHERE actor_id = ? AND project_id = ? AND idempotency_key = ?',
    ).get(input.actorId, input.projectId, input.idempotencyKey) as { request_digest: string; receipt_json: string } | undefined
    if (!row) return undefined
    if (row.request_digest !== requestDigest(input.command)) fail('IDEMPOTENCY_KEY_REUSED', '幂等键已被不同请求使用。')
    return parseReceipt(row.receipt_json)
  }

  private requireOwnedUpload(input: { actorId: string; projectId: string; uploadId: string }): ReportUploadRecord {
    const row = this.selectUpload(input.uploadId)
    if (!row || row.actor_id !== input.actorId || row.project_id !== input.projectId) {
      fail('UPLOAD_NOT_FOUND', '上传准备记录不存在。', 404)
    }
    return this.mapUpload(row)
  }

  private selectUpload(uploadId: string) {
    return this.database.prepare(uploadSelect).get(uploadId) as UploadRow | undefined
  }

  private requireUploadRow(uploadId: string) {
    return this.selectUpload(uploadId) ?? fail('UPLOAD_NOT_FOUND', '上传准备记录不存在。', 404)
  }

  private assertUsable(upload: ReportUploadRecord, next: ReportUploadStatus) {
    if (Date.parse(upload.expiresAt) <= this.now().getTime() && upload.status !== 'committed' && upload.status !== 'failed') {
      fail('UPLOAD_EXPIRED', '上传准备已过期，请重新上传。')
    }
    if (upload.status === 'failed') fail('UPLOAD_ABORTED', '上传已失败或已取消。')
    if (upload.status === 'committed' && next !== 'committed') fail('UPLOAD_ALREADY_COMMITTED', '该上传已生成正式报告。')
  }

  private updateStatus(uploadId: string, from: ReportUploadStatus, to: ReportUploadStatus) {
    const result = this.database.prepare('UPDATE report_uploads SET status = ? WHERE id = ? AND status = ?').run(to, uploadId, from)
    if (Number(result.changes) !== 1) fail('UPLOAD_NOT_READY', '文件尚未完成解析，不能提交。')
  }

  private readState(projectId: string) {
    return this.database.prepare(
      'SELECT project_id, plan_revision, workflow_revision, next_submission_sequence, completed_at FROM project_report_state WHERE project_id = ?',
    ).get(projectId) as StateRow | undefined
  }

  private readWorkflow(projectId: string): ProjectWorkflow {
    const state = this.readState(projectId)
    if (!state) fail('STAGE_PLAN_MISSING', '请先创建研究计划。')
    const stages = (this.database.prepare(
      'SELECT id, project_id, ordinal, title, description, planned_start_at, planned_end_at, lifecycle_status, started_at, completed_at, completion_reason, current_completion_report_id, next_report_version, state_revision, completion_revision FROM project_stages WHERE project_id = ? ORDER BY ordinal',
    ).all(projectId) as unknown[]).map(mapStage)
    const workflow = freezeProjectWorkflow({
      projectId: state.project_id,
      planRevision: asInt(state.plan_revision),
      workflowRevision: asInt(state.workflow_revision),
      nextSubmissionSequence: asInt(state.next_submission_sequence),
      completedAt: state.completed_at ?? undefined,
      stages,
    })
    assertValidStageWorkflow(workflow)
    return workflow
  }

  private insertStage(stage: ProjectStageRecord) {
    this.database.prepare(
      'INSERT INTO project_stages(id, project_id, ordinal, title, description, planned_start_at, planned_end_at, lifecycle_status, started_at, completed_at, completion_reason, current_completion_report_id, next_report_version, state_revision, completion_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      stage.id,
      stage.projectId,
      stage.ordinal,
      stage.title,
      stage.description ?? null,
      stage.plannedStartAt ?? null,
      stage.plannedEndAt ?? null,
      stage.lifecycleStatus,
      stage.startedAt ?? null,
      stage.completedAt ?? null,
      stage.completionReason ?? null,
      stage.currentCompletionReportId ?? null,
      stage.nextReportVersion,
      stage.stateRevision,
      stage.completionRevision,
    )
  }

  private writeStages(workflow: ProjectWorkflow) {
    const ordered = [...workflow.stages].sort((left, right) => (
      Number(left.lifecycleStatus === 'in_progress') - Number(right.lifecycleStatus === 'in_progress')
    ))
    const statement = this.database.prepare(
      'UPDATE project_stages SET lifecycle_status = ?, started_at = ?, completed_at = ?, completion_reason = ?, current_completion_report_id = ?, next_report_version = ?, state_revision = ?, completion_revision = ? WHERE id = ? AND project_id = ?',
    )
    for (const stage of ordered) {
      const result = statement.run(
        stage.lifecycleStatus,
        stage.startedAt ?? null,
        stage.completedAt ?? null,
        stage.completionReason ?? null,
        stage.currentCompletionReportId ?? null,
        stage.nextReportVersion,
        stage.stateRevision,
        stage.completionRevision,
        stage.id,
        stage.projectId,
      )
      if (Number(result.changes) !== 1) fail('INVALID_SUBMISSION', '阶段状态写入失败。')
    }
  }

  private insertReport(report: ReportSubmission) {
    this.database.prepare(
      'INSERT INTO report_submissions(id, project_id, stage_id, stage_version, submission_sequence, submitted_as, title, file_name, source_key, file_hash, source_size, paragraph_count, character_count, submitted_by, submitted_at, was_first_stage_submission) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      report.id,
      report.projectId,
      report.stageId,
      report.stageVersion,
      report.submissionSequence,
      report.submittedAs,
      report.title,
      report.fileName,
      report.sourceKey,
      report.fileHash,
      report.sourceSize,
      report.paragraphCount,
      report.characterCount,
      report.submittedBy,
      report.submittedAt,
      report.wasFirstStageSubmission ? 1 : 0,
    )
  }

  private mapUpload(row: UploadRow): ReportUploadRecord {
    const record: ReportUploadRecord = {
      id: row.id,
      projectId: row.project_id,
      actorId: row.actor_id,
      fileName: row.file_name,
      status: asUploadStatus(row.status),
      reservationId: row.reservation_id,
      reservedBytes: asInt(row.reserved_bytes),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }
    const prepared = mapPrepared(row)
    if (prepared) record.prepared = prepared
    if (row.report_id) record.reportId = row.report_id
    if (row.error_code) record.errorCode = row.error_code
    return record
  }
}

function fail(code: SubmissionFailureCode, message: string, status?: number): never {
  throw new ReportSubmissionError(code, message, status ?? statusFor(code))
}

function statusFor(code: SubmissionFailureCode) {
  if (code === 'PROJECT_NOT_FOUND' || code === 'UPLOAD_NOT_FOUND') return 404
  if (code === 'REPORT_WRITE_FORBIDDEN') return 403
  if (code === 'INVALID_SUBMISSION' || code === 'UPLOAD_FILE_INVALID') return 400
  return 409
}

function requestDigest(command: ReportSubmissionConfirmation['command']) {
  return createHash('sha256').update(JSON.stringify({
    uploadId: command.uploadId,
    stageId: command.stageId,
    reportKind: command.reportKind,
    expectedPlanRevision: command.expectedPlanRevision,
    expectedWorkflowRevision: command.expectedWorkflowRevision,
    expectedCompletionRevision: command.expectedCompletionRevision,
    expectedCompletionReportId: command.expectedCompletionReportId,
  })).digest('hex')
}

function serializeReceipt(receipt: ReportSubmissionReceipt) {
  return JSON.stringify({
    reportId: receipt.reportId,
    projectId: receipt.projectId,
    stageId: receipt.stageId,
    stageVersion: receipt.stageVersion,
    submissionSequence: receipt.submissionSequence,
    submittedAs: receipt.submittedAs,
    submittedAt: receipt.submittedAt,
    outboxEventId: receipt.outboxEventId,
  })
}

function parseReceipt(json: string): ReportSubmissionReceipt {
  const value = JSON.parse(json) as unknown
  if (!isRecord(value)) fail('INVALID_SUBMISSION', '提交回执无效。')
  const submittedAs = value.submittedAs
  if (submittedAs !== 'update' && submittedAs !== 'completion') fail('INVALID_SUBMISSION', '提交回执无效。')
  return {
    reportId: asText(value.reportId),
    projectId: asText(value.projectId),
    stageId: asText(value.stageId),
    stageVersion: asInt(value.stageVersion),
    submissionSequence: asInt(value.submissionSequence),
    submittedAs,
    submittedAt: asText(value.submittedAt),
    outboxEventId: asText(value.outboxEventId),
  }
}

function assertPreparedFile(file: PreparedReportFile, upload: ReportUploadRecord) {
  if (!isOwnedRelativeSourceKey(file.sourceKey) || !file.sourceKey.startsWith(upload.id + '/')) fail('UPLOAD_FILE_INVALID', '解析后的报告文件路径无效。', 400)
  if (!nonEmpty(file.fileName) || !nonEmpty(file.mimeType) || !nonEmpty(file.fileHash) || !nonEmpty(file.title) || !nonEmpty(file.text)) {
    fail('UPLOAD_FILE_INVALID', '解析后的报告文件无效。', 400)
  }
  if (!Number.isSafeInteger(file.sourceSize) || file.sourceSize < 1 || file.sourceSize > upload.reservedBytes) {
    fail('UPLOAD_FILE_INVALID', '解析后的报告文件超出预留容量。', 400)
  }
  if (!Number.isSafeInteger(file.paragraphCount) || file.paragraphCount < 1) fail('UPLOAD_FILE_INVALID', '解析后的报告文件无效。', 400)
  if (!Number.isSafeInteger(file.characterCount) || file.characterCount < 1 || file.characterCount !== file.text.length) fail('UPLOAD_FILE_INVALID', '解析后的报告字数无效。', 400)
}

function isOwnedRelativeSourceKey(value: string) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) return false
  if (value.startsWith('/') || value.startsWith('\\')) return false
  return !value.split(/[\\/]/).some((part) => part === '' || part === '.' || part === '..')
}

function mapPrepared(row: UploadRow): PreparedReportFile | undefined {
  if (row.source_key == null || row.mime_type == null || row.file_hash == null || row.source_size == null
    || row.title == null || row.document_text == null || row.paragraph_count == null || row.character_count == null) {
    return undefined
  }
  return {
    sourceKey: row.source_key,
    fileName: row.file_name,
    mimeType: row.mime_type,
    fileHash: row.file_hash,
    sourceSize: asInt(row.source_size),
    title: row.title,
    text: row.document_text,
    paragraphCount: asInt(row.paragraph_count),
    characterCount: asInt(row.character_count),
  }
}

function mapStage(value: unknown): ProjectStageRecord {
  if (!isRecord(value)) throw new Error('malformed stage row')
  return {
    id: asText(value.id),
    projectId: asText(value.project_id),
    ordinal: asInt(value.ordinal),
    title: asText(value.title),
    lifecycleStatus: asLifecycle(asText(value.lifecycle_status)),
    nextReportVersion: asInt(value.next_report_version),
    stateRevision: asInt(value.state_revision),
    completionRevision: asInt(value.completion_revision),
    ...(value.description ? { description: asText(value.description) } : {}),
    ...(value.planned_start_at ? { plannedStartAt: asText(value.planned_start_at) } : {}),
    ...(value.planned_end_at ? { plannedEndAt: asText(value.planned_end_at) } : {}),
    ...(value.started_at ? { startedAt: asText(value.started_at) } : {}),
    ...(value.completed_at ? { completedAt: asText(value.completed_at) } : {}),
    ...(value.completion_reason ? { completionReason: asCompletionReason(asText(value.completion_reason)) } : {}),
    ...(value.current_completion_report_id ? { currentCompletionReportId: asText(value.current_completion_report_id) } : {}),
  }
}

function asUploadStatus(value: string): ReportUploadStatus {
  if (value === 'receiving' || value === 'parsing' || value === 'ready' || value === 'failed' || value === 'committed' || value === 'reclaiming' || value === 'reclaimed') return value
  throw new Error('malformed upload status')
}

function asLifecycle(value: string): StageLifecycleStatus {
  if (value === 'not_started' || value === 'in_progress' || value === 'completed') return value
  throw new Error('malformed stage lifecycle')
}

function asCompletionReason(value: string): StageCompletionReason {
  if (value === 'report_completion' || value === 'skipped') return value
  throw new Error('malformed completion reason')
}

function asInt(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail('INVALID_SUBMISSION', '记录字段无效。')
  return value
}

function asText(value: unknown) {
  if (typeof value !== 'string' || value.length === 0) fail('INVALID_SUBMISSION', '记录字段无效。')
  return value
}

function nonEmpty(value: string) {
  return typeof value === 'string' && value.trim().length > 0
}

function isUserRole(value: string): value is UserRole { return value === 'admin' || value === 'researcher' }
function isUserStatus(value: string): value is UserStatus { return value === 'active' || value === 'disabled' }
function isMemberRole(value: string): value is ProjectMemberRole { return value === 'owner' || value === 'editor' }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isUniqueConstraint(error: unknown, fragment: string) {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed') && error.message.includes(fragment)
}

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { ReportSubmission, ReportOperation, ReportOperationHistory } from '@/modules/reports/submission-domain'
import type { SubmissionTask } from '@/modules/reports/submission-task-domain'
import { SubmissionTaskRepository } from '@/lib/db/submission-task-repository'
import { resolveReportOperationAccess, resolveReportDeletionAccess } from '@/modules/reports/submission-policy'
import { getSubmissionDisplayLabels, resolveSubmissionComparison, type ComparisonSubmission } from '@/modules/reports/submission-query'
import { SubmissionTaskError } from '@/modules/reports/submission-task-domain'

export class SubmissionQueryRepository {
  constructor(private readonly input: { database: DatabaseSync; tasks: SubmissionTaskRepository }) {}

  /** Metadata, latest attempts and scalar scores only; no task snapshots or result documents. */
  batch(reportIds: readonly string[]) {
    const database = this.input.database
    if (!reportIds.length) return []
    const ids = JSON.stringify([...new Set(reportIds)])
    const reports = database.prepare(
      `WITH wanted AS (SELECT * FROM report_submissions WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL),
      identities AS (SELECT id FROM wanted UNION SELECT (SELECT id FROM report_submissions p WHERE p.project_id=w.project_id AND p.deleted_at IS NULL AND p.submission_sequence<w.submission_sequence ORDER BY p.submission_sequence DESC LIMIT 1) FROM wanted w
      UNION SELECT (SELECT id FROM report_submissions p WHERE p.project_id=w.project_id AND p.deleted_at IS NULL ORDER BY p.submission_sequence DESC LIMIT 1) FROM wanted w)
      SELECT r.* FROM report_submissions r JOIN identities i ON i.id=r.id ORDER BY r.submission_sequence DESC`,
    ).all(ids).map(mapReport)
    const selectedIds = JSON.stringify(reports.map(report => report.id))
    const taskRows = database.prepare(`SELECT id, report_id, project_id, actor_id, operation, generation, status, stage, stage_index, attempts, cancel_requested, created_at, updated_at, error_code
      FROM submission_tasks t WHERE report_id IN (SELECT value FROM json_each(?))
      AND generation=(SELECT MAX(generation) FROM submission_tasks latest WHERE latest.report_id=t.report_id AND latest.operation=t.operation)`).all(ids)
    const tasks = new Map(taskRows.map(row => [String(row.report_id)+':'+String(row.operation), mapTask(row)]))
    const results = database.prepare(`SELECT id, report_id, operation, success_count,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.kind') END AS kind,
      CASE WHEN json_valid(payload_json) AND json_type(payload_json, '$.snapshot.payload.aiScore.overall') IN ('integer','real') THEN json_extract(payload_json, '$.snapshot.payload.aiScore.overall') END AS ai_score,
      CASE WHEN json_valid(payload_json) AND json_type(payload_json, '$.snapshot.payload.reportCompleteness.overall') IN ('integer','real') THEN json_extract(payload_json, '$.snapshot.payload.reportCompleteness.overall') END AS completeness
      FROM (SELECT id, report_id, operation, payload_json, COUNT(*) OVER (PARTITION BY report_id, operation) AS success_count,
        ROW_NUMBER() OVER (PARTITION BY report_id, operation ORDER BY generation DESC) AS position
        FROM submission_task_results WHERE report_id IN (SELECT value FROM json_each(?))) WHERE position=1`).all(selectedIds)
    const resultMap = new Map(results.map(row => [String(row.report_id)+':'+String(row.operation), row]))
    const comparisons: ComparisonSubmission[] = reports.map(report => {
      const result = resultMap.get(report.id+':analysis')
      return { ...report, analysisId: result ? String(result.id) : undefined, aiScore: result?.kind === 'analysis' ? validScore(result.ai_score) : undefined }
    })
    const wanted = new Set(reportIds)
    return reports.filter(report => wanted.has(report.id)).map(report => {
      const analysisTask = tasks.get(report.id+':analysis')
      const insightTask = tasks.get(report.id+':insight')
      const history = (operation: ReportOperation): ReportOperationHistory => {
        const task = tasks.get(report.id+':'+operation)
        return { successCount: Number(resultMap.get(report.id+':'+operation)?.success_count ?? 0),
          firstSucceededAt: operation === 'analysis' ? report.firstAnalysisSucceededAt : report.firstInsightSucceededAt,
          latestAttempt: task ? { jobId: task.id, status: task.status } : undefined }
      }
      const result = resultMap.get(report.id+':analysis')
      return { report, analysisTask, insightTask, operations: { analysis: history('analysis'), insight: history('insight') },
        latest: reports.find(item => item.projectId === report.projectId),
        comparison: resolveSubmissionComparison({ report: comparisons.find(item => item.id === report.id)!, submissions: comparisons }),
        scores: { aiScore: result?.kind === 'analysis' ? validScore(result.ai_score) : undefined, completeness: result?.kind === 'analysis' ? validScore(result.completeness) : undefined } }
    })
  }

  detail(actorId: string, reportId: string) {
    return this.readTransaction(() => {
      const { database, tasks } = this.input
      tasks.assertRead(actorId)
      const report = tasks.getReport(reportId)
      if (!report || report.deletedAt) throw new SubmissionTaskError('REPORT_NOT_FOUND','报告不存在。',404)
      const stage = database.prepare('SELECT * FROM project_stages WHERE id=?').get(report.stageId)!
      const currentStage = { id: report.stageId, projectId: report.projectId, ordinal: Number(stage.ordinal), title: String(stage.title), currentCompletionReportId: stage.current_completion_report_id ? String(stage.current_completion_report_id) : undefined }
      const analysisHistory = tasks.listResults(reportId,'analysis')
      const insightHistory = tasks.listResults(reportId,'insight')
      const projection = this.batch([report.id])[0]
      const latest = projection.latest
      const operations = projection.operations
      const access = tasks.access(actorId,report.projectId)
      const comparison = projection.comparison
      const outbox = database.prepare('SELECT status,last_error,available_at FROM report_submission_outbox WHERE report_id=?').get(report.id)
      return {
        report: { id: report.id, projectId: report.projectId, stageId: report.stageId, stageVersion: report.stageVersion, submissionSequence: report.submissionSequence, title: report.title, fileName: report.fileName, submittedAs: report.submittedAs, submittedAt: report.submittedAt, sourceSize: report.sourceSize, paragraphCount: report.paragraphCount, characterCount: report.characterCount, firstAnalysisSucceededAt: report.firstAnalysisSucceededAt, firstInsightSucceededAt: report.firstInsightSucceededAt },
        labels: getSubmissionDisplayLabels({stage:currentStage,report}),
        isLatest: latest?.id===report.id,
        capabilities: {
          analysis: resolveReportOperationAccess({access,report,latestSubmission:latest,history:operations.analysis}),
          insight: resolveReportOperationAccess({access,report,latestSubmission:latest,history:operations.insight}),
          deletion: resolveReportDeletionAccess({access,report,stage:currentStage,operations}),
        },
        tasks: {analysis:projection.analysisTask,insight:projection.insightTask},
        results: {analysis:analysisHistory[0],insight:insightHistory[0]},
        history: {analysis:analysisHistory,insight:insightHistory},
        comparison,
        dispatch: outbox ? {status:String(outbox.status),errorCode:outbox.last_error?String(outbox.last_error):undefined,availableAt:String(outbox.available_at)} : undefined,
      }
    })
  }

  task(actorId:string,jobId:string) {
    this.input.tasks.assertRead(actorId)
    const task=this.input.tasks.getTask(jobId)
    if(!task || this.input.tasks.getReport(task.reportId)?.deletedAt) throw new SubmissionTaskError('TASK_NOT_FOUND','任务不存在。',404)
    return task
  }

  private readTransaction<T>(read:()=>T):T {
    const database=this.input.database
    if(database.isTransaction) return read()
    database.exec('BEGIN')
    try {const value=read();database.exec('COMMIT');return value}
    catch (error) {
      try { database.exec('ROLLBACK') } catch { /* transaction already closed */ }
      throw error
    }
  }
}
type Row = Record<string, SQLOutputValue>
function validScore(value: SQLOutputValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined
}
function mapReport(row: Row): ReportSubmission {
  return { id: String(row.id), projectId: String(row.project_id), stageId: String(row.stage_id), stageVersion: Number(row.stage_version), submissionSequence: Number(row.submission_sequence), submittedAs: row.submitted_as as ReportSubmission['submittedAs'],
    title: String(row.title), fileName: String(row.file_name), sourceKey: String(row.source_key), fileHash: String(row.file_hash), sourceSize: Number(row.source_size), paragraphCount: Number(row.paragraph_count), characterCount: Number(row.character_count), submittedBy: String(row.submitted_by), submittedAt: String(row.submitted_at), wasFirstStageSubmission: Boolean(row.was_first_stage_submission),
    firstAnalysisSucceededAt: row.first_analysis_succeeded_at ? String(row.first_analysis_succeeded_at) : undefined, firstInsightSucceededAt: row.first_insight_succeeded_at ? String(row.first_insight_succeeded_at) : undefined }
}
function mapTask(row: Row): SubmissionTask {
  return { id: String(row.id), reportId: String(row.report_id), projectId: String(row.project_id), actorId: String(row.actor_id), operation: row.operation as ReportOperation,
    generation: Number(row.generation), status: row.status as SubmissionTask['status'], stage: row.stage as SubmissionTask['stage'], stageIndex: Number(row.stage_index), attempts: Number(row.attempts), cancelRequested: Boolean(row.cancel_requested),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), errorCode: row.error_code ? String(row.error_code) : undefined }
}


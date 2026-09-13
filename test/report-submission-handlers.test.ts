import assert from 'node:assert/strict'
import test from 'node:test'
import { createReportUploadTestDatabase } from './helpers/report-upload-database'
import { ReportSubmissionRepository } from '../lib/db/report-submission-repository'
import { createSubmissionStorageQuota } from '../lib/storage/submission-quota'
import { ReportSubmissionService } from '../modules/reports/submission-service'
import { createReportSubmissionHandlers } from '../lib/http/report-submission-handlers'
import { ReportSubmissionError, type PreparedReportFiles } from '../modules/reports/upload-domain'

function fixture(overrides: Partial<PreparedReportFiles> = {}) {
  const database = createReportUploadTestDatabase()
  const quota = createSubmissionStorageQuota({ storageRoot: '/unused-test-root' })
  const repository = new ReportSubmissionRepository({ database, quota })
  repository.initializePlan({ actorId: 'owner', projectId: 'project', stages: [
    { id: 'stage-1', title: '开题' }, { id: 'stage-2', title: '调研' }, { id: 'stage-3', title: '成果' },
  ] })
  const files: PreparedReportFiles = {
    async prepare(input) {
      const text = '这是一份完整研究报告。'
      return { sourceKey: input.uploadId + '/report.docx', fileName: input.fileName, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileHash: 'a'.repeat(64), sourceSize: 4, title: '研究报告', text, paragraphCount: 1, characterCount: text.length }
    },
    async verify() {}, async discard() {}, ...overrides,
  }
  const service = new ReportSubmissionService({ repository, files, maxUploadBytes: 1024, uploadTtlMs: 60_000 })
  const handlers = createReportSubmissionHandlers({ service, resolveActorId: (request) => request.headers.get('x-test-actor') ?? undefined, onUnexpectedError(error) { throw error } })
  return { database, repository, service, handlers }
}

function uploadRequest(actor = 'owner') {
  return new Request('http://test/reports/uploads?fileName=report.docx', { method: 'POST', headers: { 'x-test-actor': actor }, body: 'file' })
}

async function prepare(handlers: ReturnType<typeof createReportSubmissionHandlers>) {
  const response = await handlers.prepare(uploadRequest(), 'project')
  assert.equal(response.status, 201)
  const body = await response.json() as { id: string; status: string }
  assert.equal(body.status, 'ready')
  return body.id
}

function command(repository: ReportSubmissionRepository, uploadId: string, reportKind: 'update'|'completion' = 'update') {
  const workflow = repository.loadWorkflow({ actorId: 'owner', projectId: 'project' })
  const stage = workflow.stages[0]
  return { uploadId, stageId: stage.id, reportKind,
    expectedPlanRevision: workflow.planRevision, expectedWorkflowRevision: workflow.workflowRevision,
    expectedCompletionRevision: stage.completionRevision, expectedCompletionReportId: stage.currentCompletionReportId ?? null }
}

function confirmation(value: unknown, key = 'submission_request_01', actor = 'owner') {
  return new Request('http://test/reports', { method: 'POST', headers: { 'x-test-actor': actor, 'Idempotency-Key': key }, body: JSON.stringify(value) })
}

test('HTTP preparation is not a report; confirmation consumes quota and durably records report, text, receipt and outbox', async () => {
  const { database, repository, handlers } = fixture()
  try {
    const uploadId = await prepare(handlers)
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM report_submissions').get()?.n, 0)
    const status = await handlers.status(new Request('http://test/status', { headers: { 'x-test-actor':'owner' } }), { projectId:'project', uploadId })
    const statusText = await status.text()
    assert.doesNotMatch(statusText, /sourceKey|source_key|fileHash|document_text|reservation/)
    const response = await handlers.confirm(confirmation(command(repository,uploadId)), 'project')
    assert.equal(response.status, 201)
    const result = await response.json() as { receipt: { reportId: string; stageVersion: number }; replayed: boolean }
    assert.equal(result.receipt.stageVersion, 1)
    assert.equal(result.replayed, false)
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM report_submission_documents').get()?.n,1)
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM report_submission_outbox WHERE status=?').get('pending')?.n,1)
    assert.equal(database.prepare('SELECT owner_id FROM storage_allocations').get()?.owner_id,result.receipt.reportId)
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='report_versions'").get(), undefined)
    assert.equal(repository.loadWorkflow({actorId:'owner',projectId:'project'}).stages[0].lifecycleStatus,'in_progress')
    assert.equal(response.headers.get('cache-control'),'no-store')
  } finally { database.close() }
})

test('lost response retry replays before stale tokens or file verification and changed request digest conflicts', async () => {
  let verified = 0
  const { database, repository, handlers } = fixture({ async verify() { verified += 1; if (verified > 1) throw new Error('must replay before verify') } })
  try {
    const uploadId=await prepare(handlers)
    const body=command(repository,uploadId,'completion')
    const first=await handlers.confirm(confirmation(body),'project')
    assert.equal(first.status,201)
    const firstBody=await first.json() as { receipt: unknown }
    const replay=await handlers.confirm(confirmation(Object.fromEntries(Object.entries(body).reverse())),'project')
    assert.equal(replay.status,200)
    assert.deepEqual((await replay.json() as {receipt:unknown}).receipt,firstBody.receipt)
    assert.equal(verified,1)
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM report_submissions').get()?.n,1)
    const conflict=await handlers.confirm(confirmation({...body,reportKind:'update'}),'project')
    assert.equal(conflict.status,409)
    assert.equal((await conflict.json() as {code:string}).code,'IDEMPOTENCY_KEY_REUSED')
  } finally { database.close() }
})

test('completion conflict leaves prepared file intact and requires refreshed explicit confirmation', async () => {
  let discarded=0
  const { database, repository, handlers }=fixture({async discard(){discarded+=1}})
  try {
    const first=await prepare(handlers)
    const second=await prepare(handlers)
    const stale=command(repository,second,'completion')
    assert.equal((await handlers.confirm(confirmation(command(repository,first,'completion'),'first_submission_key'),'project')).status,201)
    const conflict=await handlers.confirm(confirmation(stale,'second_submission_key'),'project')
    assert.equal(conflict.status,409)
    assert.equal((await conflict.json() as {code:string}).code,'STAGE_COMPLETION_CHANGED')
    assert.equal(repository.getUpload({actorId:'owner',projectId:'project',uploadId:second}).status,'ready')
    assert.equal(discarded,0)
    const accepted=await handlers.confirm(confirmation(command(repository,second,'completion'),'confirmed_submission_key'),'project')
    assert.equal(accepted.status,201)
    assert.equal(repository.loadWorkflow({actorId:'owner',projectId:'project'}).stages[1].lifecycleStatus,'in_progress')
  } finally { database.close() }
})

test('unauthenticated/editor upload is rejected before storage and ready upload rechecks revoked privileges', async () => {
  let calls=0
  const {database,handlers}=fixture({async prepare(){calls++;throw new Error('should not run')}})
  try {
    assert.equal((await handlers.prepare(new Request('http://test/uploads?fileName=x.docx',{method:'POST',body:'file'}),'project')).status,401)
    assert.equal((await handlers.prepare(uploadRequest('editor'),'project')).status,403)
    assert.equal(calls,0)
  } finally { database.close() }
  const ready=fixture()
  try {
    const id=await prepare(ready.handlers)
    const body=command(ready.repository,id)
    ready.database.exec("UPDATE project_members SET role='editor' WHERE user_id='owner'")
    assert.equal((await ready.handlers.confirm(confirmation(body),'project')).status,403)
    assert.equal(ready.database.prepare('SELECT COUNT(*) AS n FROM report_submissions').get()?.n,0)
  } finally { ready.database.close() }
})

test('parse failure releases reservation without creating a formal report or moving stages', async () => {
  const {database,repository,handlers}=fixture({async prepare(){throw new ReportSubmissionError('REPORT_PARSE_FAILED','报告无法解析。',422)}})
  try {
    const response=await handlers.prepare(uploadRequest(),'project')
    assert.equal(response.status,422)
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM report_submissions').get()?.n,0)
    assert.equal(database.prepare("SELECT reserved_bytes FROM storage_usage WHERE scope_type='global'").get()?.reserved_bytes,0)
    assert.equal(repository.loadWorkflow({actorId:'owner',projectId:'project'}).nextSubmissionSequence,1)
    assert.equal(database.prepare('SELECT status FROM report_uploads').get()?.status,'failed')
  } finally {database.close()}
})

test('revocation during parsing cleans the owned file and releases quota without undoing the privilege change', async () => {
  let discarded=0
  const current=fixture({
    async prepare(input) {
      assert.equal(current.database.isTransaction,false)
      current.database.exec("UPDATE users SET status='disabled' WHERE id='owner'")
      const text='完整研究报告'
      return { sourceKey:input.uploadId+'/report.docx',fileName:input.fileName,mimeType:'application/docx',fileHash:'a'.repeat(64),
        sourceSize:4,title:'报告',text,paragraphCount:1,characterCount:text.length }
    },
    async discard(){discarded+=1},
  })
  try {
    assert.equal((await current.handlers.prepare(uploadRequest(),'project')).status,403)
    assert.equal(discarded,1)
    assert.equal(current.database.prepare("SELECT status FROM users WHERE id='owner'").get()?.status,'disabled')
    assert.equal(current.database.prepare("SELECT reserved_bytes FROM storage_usage WHERE scope_type='global'").get()?.reserved_bytes,0)
    assert.equal(current.database.prepare('SELECT status FROM report_uploads').get()?.status,'failed')
  } finally {current.database.close()}
})

test('cleanup failure retains reservation and never advances the report sequence', async () => {
  const {database,handlers}=fixture({async prepare(){throw new ReportSubmissionError('UPLOAD_CLEANUP_FAILED','准备文件清理失败。',500)}})
  try {
    assert.equal((await handlers.prepare(uploadRequest(),'project')).status,500)
    assert.equal(database.prepare('SELECT next_submission_sequence FROM project_report_state').get()?.next_submission_sequence,1)
    assert.equal(database.prepare("SELECT reserved_bytes FROM storage_usage WHERE scope_type='global'").get()?.reserved_bytes,1024)
    assert.equal(database.prepare('SELECT status FROM report_uploads').get()?.status,'parsing')
  } finally {database.close()}
})

test('oversized or malformed confirmation is rejected without trusting Content-Length', async () => {
  const {database,handlers}=fixture()
  try {
    assert.equal((await handlers.confirm(confirmation({version:1}),'project')).status,400)
    const huge=new Request('http://test/reports',{method:'POST',headers:{'x-test-actor':'owner','idempotency-key':'oversized_request_key','content-length':'2'},body:' '.repeat(17*1024)})
    assert.equal((await handlers.confirm(huge,'project')).status,413)
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM report_submissions').get()?.n,0)
  } finally {database.close()}
})

import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import { createSubmissionEngine, connectSubmissionEngine, initializeDefaultPlan, receiveReadyUpload, confirmationFor } from './helpers/report-submission-fixture'
import { createSubmissionWorkspaceHandlers } from '../lib/http/submission-workspace-handlers'
import { SubmissionWorkspaceRepository } from '../lib/db/submission-workspace-repository'
import { SubmissionQueryRepository } from '../lib/db/submission-query-repository'
import { createTaskFixture } from './helpers/submission-task-fixture'

const project={title:'新研究课题',objective:'明确研究问题',description:'研究背景与说明',ownerId:'owner',collaboratorIds:['editor'],stages:[{id:'new-stage-1',title:'开题'},{id:'new-stage-2',title:'成果'}]}

test('project creation atomically writes descriptive project, actual owner, collaborators, first active stage and audit',()=>{
  const {database,repository}=createSubmissionEngine()
  try {
    const workflow=repository.createProject({actorId:'owner',project})
    const stored=database.prepare('SELECT * FROM projects WHERE id=?').get(workflow.projectId)!
    assert.equal(stored.owner_name,'owner')
    assert.equal(stored.description, project.description)
    assert.equal(Object.hasOwn(stored, 'milestones_json'), false)
    assert.equal(Object.hasOwn(stored, 'status'), false)
    assert.equal(workflow.stages[0].lifecycleStatus,'in_progress')
    assert.equal(workflow.nextSubmissionSequence,1)
    assert.equal(workflow.planRevision,0)
    assert.equal(database.prepare('SELECT COUNT(*) n FROM project_members WHERE project_id=?').get(workflow.projectId)?.n,2)
    assert.equal(database.prepare('SELECT event_type FROM stage_project_audit WHERE project_id=?').get(workflow.projectId)?.event_type,'project_created')
  } finally {database.close()}
})

test('only active creators may create; delegation requires admin and every selected member must be active',()=>{
  const {database,repository}=createSubmissionEngine()
  try {
    assert.throws(()=>repository.createProject({actorId:'other',project}),/不能为其他/)
    database.exec("UPDATE users SET status='disabled' WHERE id='editor'")
    assert.throws(()=>repository.createProject({actorId:'owner',project}),/停用/)
    database.exec("UPDATE users SET status='active' WHERE id='editor'")
    const workflow=repository.createProject({actorId:'admin',project})
    assert.ok(workflow.projectId)
    assert.equal(database.prepare("SELECT user_id FROM project_members WHERE project_id=? AND role='owner'").get(workflow.projectId)?.user_id,'owner')
    assert.throws(()=>repository.createProject({actorId:'owner',project:{...project,collaboratorIds:['owner']}}),/负责人/)
    assert.throws(()=>repository.createProject({actorId:'owner',project:{...project,title:' '}}),/无效/)
  } finally {database.close()}
})

test('failed stage/audit insertion rolls back project and all memberships; no partial project remains',()=>{
  for(const table of ['project_stages','stage_project_audit']) {
    const {database,repository}=createSubmissionEngine()
    try {
      database.exec('CREATE TEMP TRIGGER reject_project BEFORE INSERT ON '+table+" BEGIN SELECT RAISE(ABORT,'injected project failure'); END")
      assert.throws(()=>repository.createProject({actorId:'owner',project}),/injected/)
      assert.equal(database.prepare('SELECT COUNT(*) n FROM projects').get()?.n,1)
      assert.equal(database.prepare('SELECT COUNT(*) n FROM project_report_state').get()?.n,0)
      assert.equal(database.prepare('SELECT COUNT(*) n FROM project_members').get()?.n,2)
    } finally {database.close()}
  }
})

test('pre-submission plan restructure is atomic and invalidates pending confirmation without discarding its file',()=>{
  const {database,repository}=createSubmissionEngine()
  try {
    initializeDefaultPlan(repository)
    receiveReadyUpload(repository,'prepared')
    const stale=confirmationFor(repository,{uploadId:'prepared',idempotencyKey:'plan_edit_submission'})
    const plan=repository.editPlan({actorId:'owner',projectId:'project',edit:{expectedPlanRevision:0,nextStages:[{id:'stage-3',title:'重排成果'},{id:'stage-1',title:'后续开题'}]}})
    assert.equal(plan.stages[0].id,'stage-3')
    assert.equal(plan.stages[0].lifecycleStatus,'in_progress')
    assert.equal(plan.planRevision,1)
    assert.throws(()=>repository.confirmSubmission(stale),/研究计划已更新/)
    assert.equal(repository.getUpload({actorId:'owner',projectId:'project',uploadId:'prepared'}).status,'ready')
    assert.throws(()=>repository.editPlan({actorId:'owner',projectId:'project',edit:{expectedPlanRevision:0,nextStages:[{id:'stage-1',title:'old'}]}}),/变更/)
    assert.equal(database.prepare('SELECT COUNT(*) n FROM stage_project_audit').get()?.n,2)
  } finally {database.close()}
})

test('after a logically deleted submission, plan identity remains frozen but descriptions and schedule can change',()=>{
  const {database,repository}=createSubmissionEngine()
  try {
    const before=initializeDefaultPlan(repository)
    receiveReadyUpload(repository,'prepared')
    const receipt=repository.confirmSubmission(confirmationFor(repository,{uploadId:'prepared',idempotencyKey:'frozen_plan_submit'})).receipt
    database.prepare("UPDATE report_submissions SET deleted_at=?,deleted_by='owner',deletion_reason='test' WHERE id=?").run(new Date().toISOString(),receipt.reportId)
    assert.throws(()=>repository.editPlan({actorId:'owner',projectId:'project',edit:{expectedPlanRevision:0,nextStages:[{id:'stage-2',title:'重排'}]}}),/不能增删或重排/)
    const nextStages=before.stages.map(stage=>({id:stage.id,title:stage.title+'修订',description:'工作内容',plannedStartAt:'2027-01-01',plannedEndAt:'2027-02-01'}))
    const after=repository.editPlan({actorId:'owner',projectId:'project',edit:{expectedPlanRevision:0,nextStages}})
    assert.equal(after.stages[0].startedAt,before.stages[0].startedAt)
    assert.equal(after.stages[0].nextReportVersion,2)
    assert.equal(after.stages[1].plannedEndAt,'2027-02-01')
    assert.equal(after.nextSubmissionSequence,2)
    assert.equal(repository.editPlan({actorId:'editor',projectId:'project',edit:{expectedPlanRevision:1,nextStages}}).planRevision,2)
  } finally {database.close()}
})

test('plan edit audit failure rolls back metadata and revision',()=>{
  const {database,repository}=createSubmissionEngine()
  try {
    const before=initializeDefaultPlan(repository)
    database.exec("CREATE TEMP TRIGGER fail_edit BEFORE INSERT ON stage_project_audit BEGIN SELECT RAISE(ABORT,'edit audit failed'); END")
    assert.throws(()=>repository.editPlan({actorId:'owner',projectId:'project',edit:{expectedPlanRevision:0,nextStages:before.stages.map(stage=>({id:stage.id,title:'changed'}))}}),/audit failed/)
    assert.deepEqual(repository.loadWorkflow({actorId:'owner',projectId:'project'}),before)
  } finally {database.close()}
})

test('independent database connections cannot overwrite an already edited plan',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yanxing-plan-edit-'))
  const path=join(root,'fresh.sqlite')
  const left=createSubmissionEngine(path)
  const right=connectSubmissionEngine(path,left.quota)
  try {
    const before=initializeDefaultPlan(left.repository)
    const stale=right.repository.loadWorkflow({actorId:'owner',projectId:'project'})
    left.repository.editPlan({actorId:'owner',projectId:'project',edit:{expectedPlanRevision:before.planRevision,nextStages:before.stages.map(stage=>({id:stage.id,title:'first edit'}))}})
    assert.throws(()=>right.repository.editPlan({actorId:'owner',projectId:'project',edit:{expectedPlanRevision:stale.planRevision,nextStages:stale.stages.map(stage=>({id:stage.id,title:'lost update'}))}}),/研究计划已变更/)
    assert.equal(right.repository.loadWorkflow({actorId:'owner',projectId:'project'}).stages[0].title,'first edit')
  } finally {left.database.close();right.database.close();await rm(root,{recursive:true,force:true})}
})

test('project handlers reject unauthenticated, oversized and legacy bodies; validated create and edit return new workflow',async()=>{
  const fixture = createTaskFixture()
  const { database } = fixture
  const queries = new SubmissionQueryRepository(fixture)
  type HandlerInput = Parameters<typeof createSubmissionWorkspaceHandlers>[0]
  const handlers = createSubmissionWorkspaceHandlers({
    processing: { repository: fixture.reports } as HandlerInput['processing'],
    workspace: new SubmissionWorkspaceRepository({ ...fixture, queries }),
    getCurrentUser: request => {
      const id = request.headers.get('x-test-actor')
      return id ? { id } as ReturnType<HandlerInput['getCurrentUser']> : undefined
    },
  })
  const request=(body:unknown,actor='owner')=>new Request('http://test/projects',{method:'POST',headers:{'x-test-actor':actor},body:JSON.stringify(body)})
  try {
    assert.equal((await handlers.createProject(request(project,''))).status,401)
    assert.equal((await handlers.createProject(request({...project,milestones:[]}))).status,409)
    assert.equal((await handlers.createProject(request({extra:'x'.repeat(70*1024)}))).status,413)
    const created=await handlers.createProject(request(project))
    assert.equal(created.status,201)
    const detail=await created.json() as {project:{id:string}}
    const edited=await handlers.editPlan(request({expectedPlanRevision:0,nextStages:project.stages}),detail.project.id)
    assert.equal(edited.status,200)
    assert.equal((await edited.json() as {workflow:{planRevision:number}}).workflow.planRevision,1)
  } finally {database.close()}
})

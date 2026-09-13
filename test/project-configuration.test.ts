import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { configurationDraft, configurationIsFrozen, ConfigurationSaveSession, membersWithOwner, validateConfiguration, type ConfigurationTransport } from '../lib/workspace-project-configuration'
import { WorkspaceRequestError } from '../lib/workspace-submission-client'
import type { WorkspaceProjectDetail } from '../lib/workspace-submission'

function fixture(): WorkspaceProjectDetail {
  return {
    project: { id: 'p', ownerId: 'owner', ownerName: '负责人', title: '课题', objective: '目标', description: '背景', updatedAt: '2026-01-01T00:00:00.000Z' },
    workflow: { planRevision: 2, workflowRevision: 0, nextSubmissionSequence: 1 },
    stages: [{ stage: { id: 'stage-1', title: '开题', nextReportVersion: 1, plannedStartAt: '2026-01-01' }, reports: [] }],
  } as unknown as WorkspaceProjectDetail
}
function harness(overrides: Partial<ConfigurationTransport> = {}) {
  const detail = fixture()
  const calls: { section: string; payload?: unknown }[] = []
  const transport: ConfigurationTransport = {
    metadata: async (_id, edit) => { calls.push({ section: 'info', payload: edit }); return { project: { ...detail.project, ...edit, updatedAt: '2026-01-02T00:00:00.000Z' }, workflow: { planRevision: 99 } } },
    plan: async (_id, edit) => { calls.push({ section: 'plan', payload: edit }); return { workflow: { planRevision: 3 } } },
    members: async (_id, snapshot) => { calls.push({ section: 'team', payload: snapshot }); return { ...snapshot, revision: snapshot.revision + 1 } },
    read: async () => { calls.push({ section: 'read' }); return detail },
    ...overrides,
  }
  return { detail, calls, transport }
}

test('metadata-only save never writes a missing-date plan or editor membership', async () => {
  const { detail, calls, transport } = harness()
  const session = new ConfigurationSaveSession(detail, false, transport)
  const draft = configurationDraft(detail)
  draft.metadata.title = '新标题'
  draft.ownerId = 'malicious-owner'
  await session.save(draft)
  assert.deepEqual(calls.map(call => call.section), ['info', 'read'])
  assert.deepEqual(calls[0].payload, { expectedUpdatedAt: detail.project.updatedAt, title: '新标题', objective: '目标', description: '背景' })
})

test('admin ownership replacement retains actual collaborators and snapshot revision', async () => {
  const { detail, calls, transport } = harness()
  const session = new ConfigurationSaveSession(detail, true, transport)
  session.members = { revision: 8, members: [{ userId: 'owner', role: 'owner' }, { userId: 'editor', role: 'editor', displayName: '同名' }, { userId: 'editor2', role: 'editor', displayName: '同名' }] }
  const draft = configurationDraft(detail)
  draft.ownerId = 'new-owner'
  await session.save(draft)
  assert.deepEqual(calls.map(call => call.section), ['team', 'read'])
  assert.deepEqual(calls[0].payload, { revision: 8, members: [{ userId: 'new-owner', role: 'owner' }, { userId: 'editor', role: 'editor' }, { userId: 'editor2', role: 'editor' }] })
  assert.deepEqual(membersWithOwner(session.members, 'editor').members, [{ userId: 'editor', role: 'owner' }, { userId: 'editor2', role: 'editor' }])
})

test('partial success retries only pending partitions using original unrelated CAS', async () => {
  let planAttempts = 0
  const revisions: number[] = []
  const { detail, calls, transport } = harness({ plan: async (_id, edit) => {
    revisions.push(edit.expectedPlanRevision)
    planAttempts++
    if (planAttempts === 1) throw new WorkspaceRequestError({ status: 400, error: '计划需要调整' })
    return { workflow: { planRevision: 3 } }
  } })
  const session = new ConfigurationSaveSession(detail, false, transport)
  const draft = configurationDraft(detail)
  draft.metadata.title = '新标题'
  draft.stages[0].title = '新阶段名'
  await assert.rejects(session.save(draft), /已保存：课题信息.*计划与排期/)
  assert.equal(session.blocked, false)
  await session.save(draft)
  assert.deepEqual(calls.map(call => call.section), ['info', 'read'])
  assert.deepEqual(revisions, [2, 2], 'metadata response revision 99 must never replace original plan CAS')
})

test('metadata checkpoint advances only acknowledged timestamp for subsequent edits', async () => {
  const { detail, calls, transport } = harness({ plan: async () => { throw new WorkspaceRequestError({ status: 400, error: 'invalid' }) } })
  const session = new ConfigurationSaveSession(detail, false, transport)
  const draft = configurationDraft(detail)
  draft.metadata.title = '第一次'
  draft.stages[0].title = '阶段修改'
  await assert.rejects(session.save(draft))
  draft.metadata.title = '第二次'
  await assert.rejects(session.save(draft))
  assert.equal((calls[1].payload as { expectedUpdatedAt: string }).expectedUpdatedAt, '2026-01-02T00:00:00.000Z')
})

for (const failure of [new WorkspaceRequestError({ status: 409, error: '版本冲突' }), new TypeError('网络中断'), new WorkspaceRequestError({ status: 503, error: '不可确认' })]) {
  test('CAS or uncertain write blocks retries until explicit reload: ' + failure.message, async () => {
    let attempts = 0
    const { detail, transport } = harness({ metadata: async () => { attempts++; throw failure } })
    const session = new ConfigurationSaveSession(detail, false, transport)
    const draft = configurationDraft(detail)
    draft.metadata.title = '修改'
    await assert.rejects(session.save(draft), /重新载入/)
    await assert.rejects(session.save(draft), /重新载入/)
    assert.equal(attempts, 1)
    assert.equal(session.blocked, true)
  })
}

test('owner executes last and successful metadata and plan are skipped after owner failure', async () => {
  let attempts = 0
  const { detail, calls, transport } = harness({ members: async (_id, snapshot) => {
    attempts++
    if (attempts === 1) throw new WorkspaceRequestError({ status: 400, error: '负责人不可用' })
    return { ...snapshot, revision: 4 }
  } })
  const session = new ConfigurationSaveSession(detail, true, transport)
  session.members = { revision: 3, members: [{ userId: 'owner', role: 'owner' }] }
  const draft = configurationDraft(detail)
  draft.metadata.title = '修改'
  draft.stages[0].title = '修改'
  draft.ownerId = 'next'
  await assert.rejects(session.save(draft), /已保存：课题信息、计划与排期/)
  await session.save(draft)
  assert.deepEqual(calls.map(call => call.section), ['info', 'plan', 'read'])
  assert.equal(attempts, 2)
})

test('after a successful plan, new metadata drafts require explicit reload instead of stale or refreshed CAS', async () => {
  const { detail, calls, transport } = harness({ members: async () => { throw new WorkspaceRequestError({ status: 400, error: '负责人不可用' }) } })
  const session = new ConfigurationSaveSession(detail, true, transport)
  session.members = { revision: 3, members: [{ userId: 'owner', role: 'owner' }] }
  const draft = configurationDraft(detail)
  draft.stages[0].title = '计划修改'
  draft.ownerId = 'next'
  await assert.rejects(session.save(draft))
  draft.metadata.title = '随后改信息'
  await assert.rejects(session.save(draft), /计划已保存.*重新载入/)
  assert.equal(session.blocked, true)
  assert.deepEqual(calls.map(call => call.section), ['plan'])
})

test('unchanged admin ownership does not need members snapshot', async () => {
  const { detail, calls, transport } = harness()
  const session = new ConfigurationSaveSession(detail, true, transport)
  const draft = configurationDraft(detail)
  draft.metadata.title = '修改'
  await session.save(draft)
  assert.deepEqual(calls.map(call => call.section), ['info', 'read'])
})

test('new phase payload preserves existing start date and excludes lifecycle and report fields', async () => {
  const { detail, calls, transport } = harness()
  const session = new ConfigurationSaveSession(detail, false, transport)
  const draft = configurationDraft(detail)
  draft.stages[0].title = '新名称'
  await session.save(draft)
  const payload = calls[0].payload as { nextStages: Record<string, unknown>[] }
  assert.equal(payload.nextStages[0].plannedStartAt, '2026-01-01')
  assert.deepEqual(Object.keys(payload.nextStages[0]).sort(), ['description', 'id', 'plannedEndAt', 'plannedStartAt', 'title'])
})

test('duplicate saves are blocked while a mutation is in flight', async () => {
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const { detail, transport } = harness({ metadata: async () => { await waiting; return { project: fixture().project } } })
  const session = new ConfigurationSaveSession(detail, false, transport)
  const draft = configurationDraft(detail)
  draft.metadata.title = '修改'
  const pending = session.save(draft)
  await assert.rejects(session.save(draft), /正在保存/)
  release()
  await pending
})

test('final read failure retries reads only and never repeats writes', async () => {
  let reads = 0
  const { detail, calls, transport } = harness({ read: async () => { reads++; if (reads === 1) throw new Error('offline'); return fixture() } })
  const session = new ConfigurationSaveSession(detail, false, transport)
  const draft = configurationDraft(detail)
  draft.metadata.title = '修改'
  await assert.rejects(session.save(draft), /所有修改已保存.*仅重新读取/)
  assert.equal(session.writesComplete, true)
  await session.save(draft)
  assert.deepEqual(calls.map(call => call.section), ['info'])
  assert.equal(reads, 2)
})

test('freeze survives report deletion; names, optional content and dates remain editable', () => {
  const detail = fixture()
  detail.workflow.nextSubmissionSequence = 2
  assert.equal(configurationIsFrozen(detail), true)
  const baseline = configurationDraft(detail)
  const draft = configurationDraft(detail)
  draft.stages[0].title = '新名称'
  assert.equal(validateConfiguration({ draft, baseline, frozen: true, isAdmin: false }), undefined)
  draft.stages.push({ id: 'stage-2', title: '新增' })
  assert.equal(validateConfiguration({ draft, baseline, frozen: true, isAdmin: false })?.tab, 'plan')
  draft.stages = []
  assert.equal(validateConfiguration({ draft, baseline, frozen: false, isAdmin: false })?.tab, 'plan')
  draft.stages = Array.from({ length: 13 }, (_, index) => ({ id: 'stage-' + index, title: '阶段' }))
  assert.equal(validateConfiguration({ draft, baseline, frozen: false, isAdmin: false })?.tab, 'plan')
})

test('preserves original 4xl sidebar, independent plan scroll and fixed footer with guarded close', () => {
  const dialog = readFileSync(new URL('../components/workspace-project-edit-dialog.tsx', import.meta.url), 'utf8')
  const fields = readFileSync(new URL('../components/project-configuration-fields.tsx', import.meta.url), 'utf8')
  assert.match(dialog, /size="4xl"/)
  for (const label of ['01 课题信息', '02 研究团队', '03 计划与排期']) assert.ok(dialog.includes(label))
  assert.match(dialog, /md:w-60/)
  assert.match(dialog, /flex shrink-0 items-center justify-between/)
  assert.match(fields, /yx-subtle-scrollbar min-h-0 flex-1.*overflow-y-auto/)
  assert.match(dialog, /<form noValidate/)
  assert.ok(dialog.includes("if (!busyRef.current) onClose()"))
  assert.match(dialog, /onClose={close}/)
  assert.ok(dialog.includes("if (!isAdmin) return"))
  assert.ok(dialog.includes("if (!ownerDirtyRef.current)"))
  assert.match(fields, /createIdempotencyKey/)
})

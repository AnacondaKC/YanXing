import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const directory = await mkdtemp(`${tmpdir()}/yanxing-example-identity-`)
process.env.YANXING_DATABASE_PATH = path.join(directory, 'example-identity.sqlite')

const { createOrUpdateUser } = await import('../lib/auth/session')
const { createProjectForUser, getProject, isExplicitExampleProject } = await import('../lib/db/repository')

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

test('example identity uses explicit IDs instead of title inference', () => {
  assert.equal(isExplicitExampleProject('project-sample'), true)
  assert.equal(isExplicitExampleProject('project-uuid-123'), false)
  const owner = createOrUpdateUser({ username: 'example-identity-owner', displayName: '示例身份负责人', password: 'password-123', role: 'researcher' })
  const project = createProjectForUser({
    title: '示例教学研究',
    objective: '验证真实课题不被标题判定为示例',
    description: '普通课题即使标题含示例也不应被隐藏',
    ownerName: owner.displayName,
  }, owner.id)
  assert.equal(project.isExample, false)
  assert.equal(getProject(project.id)?.isExample, false)
  assert.equal(isExplicitExampleProject(project.id), false)
})

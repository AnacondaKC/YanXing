import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
test('报告库与课题详情共用阶段逻辑，版本徽标不冒充阶段', async () => {
  const repository = await readFile(new URL('../components/reports-repository.tsx', import.meta.url), 'utf8')
  const dashboard = await readFile(new URL('../components/dashboard-view.tsx', import.meta.url), 'utf8')
  assert.match(repository, /reportStageLabel/)
  assert.match(repository, /reportStageLabel\(report\)/)
  assert.match(dashboard, /report\.labels\.stageLabel/)
  for (const source of [repository, dashboard]) {
    assert.doesNotMatch(source, /阶段[^\n]*report\.version|阶段[^\n]*latestReport\.version/)
    assert.doesNotMatch(source, /ProjectWithCapabilities|ReportVersion|project\?\.milestones/)
  }
})

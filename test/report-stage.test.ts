import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { getReportStageLabel } from '../lib/report-stage'

const milestones = [
  { id: 'opening', title: '开题论证' },
  { id: 'research', title: '事实调研' },
  { id: 'closing', title: '成果形成' },
]

test('报告阶段显示关联里程碑的自定义名称，而不是版本号', () => {
  const report = { milestoneId: 'research', version: 1 }
  assert.equal(getReportStageLabel(report, milestones), '事实调研')
  const revisedReport = { ...report, version: 9 }
  assert.equal(getReportStageLabel(revisedReport, milestones), '事实调研')
  assert.equal(getReportStageLabel({ milestoneId: 'opening' }, milestones), '开题论证')
  assert.equal(getReportStageLabel({ milestoneId: 'closing' }, milestones), '成果形成')
})

test('里程碑调整顺序后仍按 ID 显示原关联阶段名称', () => {
  assert.equal(getReportStageLabel({ milestoneId: 'research' }, [...milestones].reverse()), '事实调研')
  assert.equal(getReportStageLabel({ milestoneId: 'opening' }, [...milestones].reverse()), '开题论证')
})

test('未关联、关联失效或课题缺失时不根据版本推测阶段', () => {
  assert.equal(getReportStageLabel({}, milestones), '未分配')
  assert.equal(getReportStageLabel({ milestoneId: '' }, milestones), '未分配')
  assert.equal(getReportStageLabel({ milestoneId: 'deleted' }, milestones), '未分配')
  assert.equal(getReportStageLabel({ milestoneId: 'opening' }, []), '未分配')
  assert.equal(getReportStageLabel({ milestoneId: 'opening' }), '未分配')
})

test('阶段重命名后同步显示新名称，并处理空白标题', () => {
  const report = { milestoneId: 'research' }
  assert.equal(getReportStageLabel(report, [{ id: 'research', title: '  实地走访  ' }]), '实地走访')
  assert.equal(getReportStageLabel(report, [{ id: 'research', title: '  ' }]), '未分配')
})

test('报告库与课题详情共用阶段逻辑，版本徽标不冒充阶段', async () => {
  const repository = await readFile(new URL('../components/reports-repository.tsx', import.meta.url), 'utf8')
  const dashboard = await readFile(new URL('../components/dashboard-view.tsx', import.meta.url), 'utf8')
  for (const source of [repository, dashboard]) {
    assert.match(source, /import \{ getReportStageLabel \} from '@\/lib\/report-stage'/)
    assert.match(source, /getReportStageLabel\(report, project\?\.milestones\)/)
    assert.doesNotMatch(source, /阶段[^\n]*report\.version|阶段[^\n]*latestReport\.version/)
  }
  assert.ok(repository.includes('`V${p.latestReport.version}`'))
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { InsightEmptyState } from '../components/insight-empty-state'
import { InsightWorkspace, isInsightGenerationInFlight } from '../components/insight-workspace'
import { insightEmptyCopy, insightEmptyKind } from '../lib/insight-empty-state'
import type { ReportVersion } from '../modules/reports/domain'

const sampleReport: ReportVersion = {
  id: 'report-empty',
  projectId: 'project-empty',
  version: 3,
  title: '阶段研究报告',
  fileName: 'phase-report.docx',
  fileHash: 'empty-state-hash',
  paragraphCount: 80,
  characterCount: 20000,
  parseStatus: 'ready',
  createdAt: '2026-08-01T00:00:00Z',
  sourceUpdatedAt: '2026-08-01T00:00:00Z',
}

function reportWith(overrides: Partial<ReportVersion>): ReportVersion {
  return { ...sampleReport, ...overrides }
}

function renderInsightEmptyState(overrides: Partial<ComponentProps<typeof InsightEmptyState>> = {}) {
  return renderToStaticMarkup(createElement(InsightEmptyState, {
    canManage: true,
    generating: false,
    error: '',
    onGenerate() {},
    ...overrides,
  }))
}

function headingText(html: string) {
  const heading = html.match(/<h2[^>]*>([^<]*)<\/h2>/)
  assert.ok(heading, 'expected a single-text heading')
  return heading[1]
}

function borderedPanelClass(html: string) {
  const panel = html.match(/<section aria-label="报告洞察启动面板" class="([^"]*)"/)
  assert.ok(panel, 'expected the full-height insight empty panel')
  return panel[1]
}

function assertRedesignedChrome(html: string) {
  assert.match(html, /报告简页样式示意/)
  assert.match(html, /报告核心主旨/)
  assert.match(html, /核心论点/)
  assert.match(html, /关键论据/)
  assert.match(html, /报告建议/)
  assert.match(html, /5-10分钟阅读/)
  assert.doesNotMatch(html, /一页决策简报|核心判断|证据依据|行动建议|五分钟决策速读/)
  assert.match(html, /非实际生成内容/)
  assert.doesNotMatch(html, /blur-3xl|blur-2xl/)
  assert.doesNotMatch(html, /报告洞察已就绪|立论脉络与证据收束|研判要点与行动建议|五分钟报告决策速读/)
  const classNames = new Set(borderedPanelClass(html).split(/\s+/))
  assert.equal(classNames.has('h-full'), true)
  assert.equal(classNames.has('flex-1'), true)
  assert.equal(classNames.has('overflow-y-auto'), true)
  assert.doesNotMatch(html, /min-h-\[400px\]/)
}

test('insight empty state keeps the heading and action without the badge or feature cards', () => {
  const html = renderToStaticMarkup(createElement(InsightWorkspace, { canManage: true }))

  assert.match(html, /开启决策洞察/)
  assert.match(html, /前往上传报告/)
  assert.doesNotMatch(html, /报告洞察已就绪|立论脉络与证据收束|研判要点与行动建议|五分钟报告决策速读/)
})

test('read-only insight empty state still explains upload permissions', () => {
  const html = renderToStaticMarkup(createElement(InsightWorkspace, { canManage: false }))

  assert.match(html, /请联系课题负责人上传报告后再查看洞察/)
  assert.doesNotMatch(html, /<button/)
})

test('failed insight jobs are not treated as still generating', () => {
  assert.equal(isInsightGenerationInFlight({ job: { id: 'job-1', status: 'failed', errorMessage: '模型调用失败。' } }), false)
  assert.equal(isInsightGenerationInFlight({ job: { id: 'job-2', status: 'queued' } }), true)
  assert.equal(isInsightGenerationInFlight({ generating: true }), true)
})

test('insight empty copy stays calm and specific to the current gap', () => {
  assert.equal(insightEmptyKind(false, false), 'missing-report')
  assert.equal(insightEmptyKind(true, true), 'generating')
  assert.equal(insightEmptyKind(true, false), 'ready')

  const missing = insightEmptyCopy('missing-report')
  assert.match(missing.lead, /洞察/)
  assert.match(missing.highlight, /上传/)
  assert.match(missing.action, /上传/)

  const generating = insightEmptyCopy('generating')
  assert.match(generating.status, /生成/)
  assert.equal(generating.action, '正在生成')
  assert.match(generating.highlight, /简页/)

  const ready = insightEmptyCopy('ready')
  assert.equal(ready.lead, '生成报告洞察')
  assert.match(ready.action, /洞察/)
  assert.match(ready.highlight, /简页/)
})

test('ready empty state shows the lead alone with the selected report and brief figure', () => {
  const html = renderInsightEmptyState({ report: sampleReport })

  assert.equal(headingText(html), '生成报告洞察')
  assert.ok(html.includes('将报告中的论点、论据与建议整理成一页报告简页，约5-10分钟读完，帮助你快速了解报告的核心主旨。'))
  assert.match(html, /已选报告/)
  assert.match(html, />V3</)
  assert.ok(html.includes('phase-report.docx'))
  assert.match(html, /生成洞察/)
  assert.doesNotMatch(html, /五分钟报告速读|上传研究报告/)
  assertRedesignedChrome(html)
})

test('missing-report empty state keeps the original lead and upload action', () => {
  const html = renderInsightEmptyState()

  assert.equal(headingText(html), '开启决策洞察')
  assert.match(html, /决策洞察依据报告全文生成/)
  assert.match(html, /前往上传报告/)
  assert.doesNotMatch(html, /已选报告|生成报告洞察/)
  assertRedesignedChrome(html)
})

test('generating empty state announces status and hides action buttons', () => {
  const html = renderInsightEmptyState({ report: sampleReport, generating: true })

  assert.equal(headingText(html), '正在编排洞察')
  assert.match(html, /role="status"/)
  assert.match(html, /正在整理报告简页，完成后将自动进入阅读/)
  assert.doesNotMatch(html, /<button/)
  assert.doesNotMatch(html, /生成洞察|前往上传报告/)
  assertRedesignedChrome(html)
})

test('read-only empty states never render buttons with or without a report', () => {
  const missing = renderInsightEmptyState({ canManage: false })
  const ready = renderInsightEmptyState({ canManage: false, report: sampleReport })

  assert.match(missing, /请联系课题负责人上传报告后再查看洞察/)
  assert.match(ready, /请联系课题负责人启动洞察/)
  assert.doesNotMatch(missing, /<button/)
  assert.doesNotMatch(ready, /<button/)
  assertRedesignedChrome(missing)
  assertRedesignedChrome(ready)
})

test('historical reports cannot generate or retry even when an error is present', () => {
  const html = renderInsightEmptyState({
    report: sampleReport,
    canGenerateInsight: false,
    error: '模型调用失败。',
  })

  assert.match(html, /历史报告仅支持查看已经生成的洞察/)
  assert.match(html, /洞察生成异常/)
  assert.match(html, /模型调用失败/)
  assert.doesNotMatch(html, /<button/)
  assert.doesNotMatch(html, />重试</)
  assertRedesignedChrome(html)
})

test('empty-state errors offer retry that stays disabled while generating', () => {
  const idle = renderInsightEmptyState({ report: sampleReport, error: '模型调用失败。' })
  const busy = renderInsightEmptyState({ report: sampleReport, generating: true, error: '模型调用失败。' })

  assert.match(idle, /洞察生成异常/)
  assert.match(idle, />重试</)
  assert.doesNotMatch(idle, /disabled=""/)
  assert.match(busy, /role="status"/)
  assert.match(busy, /<button[^>]*disabled=""[^>]*>重试<\/button>/)
  assertRedesignedChrome(idle)
  assertRedesignedChrome(busy)
})

test('selected report prefers fileName, falls back to title, and keeps long names in markup', () => {
  const longFileName = `${'国家产业政策评估与区域协同研究报告'.repeat(4)}.pdf`
  const named = renderInsightEmptyState({
    report: reportWith({ fileName: longFileName, title: '短标题', version: 12 }),
  })
  const fallback = renderInsightEmptyState({
    report: reportWith({ fileName: '', title: '仅有标题的研究报告', version: 2 }),
  })

  assert.match(named, /已选报告/)
  assert.match(named, />V12</)
  assert.ok(named.includes(longFileName))
  assert.ok(named.includes(`title="${longFileName}"`))
  assert.doesNotMatch(named, /短标题/)
  assert.ok(fallback.includes('仅有标题的研究报告'))
  assert.match(fallback, />V2</)
  assertRedesignedChrome(named)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  analysisResultHint,
  analysisResultPlaceholder,
  resolveAnalysisResultDisplay,
} from '../modules/analysis/progress'
import {
  ResearchWorkbench,
  isWorkbenchAnalysisInFlight,
  resolveHistoricalWorkbenchTitle,
  resolveWorkbenchAnalysisAction,
} from '../components/research-workbench'
import { HeatmapVisualization } from '../components/research-visualization-card'
import { RESEARCH_METHODS } from '../modules/contracts/analysis'
import type { HeatmapData } from '../lib/rendering/visualizations'

test('idle workbench keeps update report next to the analysis action', () => {
  const scenarios: { label: string; props: Partial<ComponentProps<typeof ResearchWorkbench>> }[] = [
    { label: '启动分析', props: {} },
    { label: '更新分析', props: { report: { id: 'report-1', hasCompletedFullAnalysis: true } } },
    { label: '再次分析', props: { job: { status: 'failed', stage: 'page_analysis', stageIndex: 2 } } },
  ]
  for (const { label, props } of scenarios) {
    const markup = renderToStaticMarkup(createElement(ResearchWorkbench, {
      report: { id: 'report-1' }, analyzing: false, cancelling: false, canManage: true,
      onCancelAnalysis: async () => {}, onStartAnalysis: () => {}, onUpdateReport: () => {}, onEditProject: () => {},
      ...props,
    }))
    const buttons = [...markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0])
    assert.deepEqual(buttons.map(button => button.replace(/<[^>]+>/g, '')), [label, '更新报告', '修改课题'])
    assert.ok(markup.includes(buttons[0] + buttons[1]), 'analysis and update buttons must be adjacent siblings')
    assert.doesNotMatch(buttons[1], /class="[^"]*absolute/)
    assert.match(buttons[1], /aria-haspopup="dialog"/)
  }
})

test('active analysis only shows the stop action, including startup and cancellation', () => {
  const scenarios: Partial<ComponentProps<typeof ResearchWorkbench>>[] = [
    { analyzing: true },
    { job: { status: 'queued', stage: 'validating', stageIndex: 0 } },
    { job: { status: 'running', stage: 'page_analysis', stageIndex: 2 } },
    { job: { status: 'running', stage: 'page_analysis', stageIndex: 2 }, cancelling: true },
  ]
  for (const props of scenarios) {
    for (const viewingHistoricalReport of [false, true]) {
      const markup = renderToStaticMarkup(createElement(ResearchWorkbench, {
        report: { id: 'report-1' }, analyzing: false, cancelling: false, canManage: true,
        onCancelAnalysis: async () => {}, onStartAnalysis: () => {}, onUpdateReport: () => {}, onEditProject: () => {},
        viewingHistoricalReport,
        ...props,
      }))
      const buttons = [...markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0])
      assert.deepEqual(buttons.map(button => button.replace(/<[^>]+>/g, '')), [props.cancelling ? '停止中' : '停止'])
      assert.match(markup, /aria-live="polite"/)
      assert.doesNotMatch(markup, /更新报告/)
    }
  }
})

test('workbench leaves analysis-in-flight as soon as the job is terminal', () => {
  assert.equal(isWorkbenchAnalysisInFlight(true), true)
  assert.equal(isWorkbenchAnalysisInFlight(true, { status: 'queued' }), true)
  assert.equal(isWorkbenchAnalysisInFlight(true, { status: 'running' }), true)
  assert.equal(isWorkbenchAnalysisInFlight(true, { status: 'completed' }), false)
  assert.equal(isWorkbenchAnalysisInFlight(true, { status: 'failed' }), false)
  assert.equal(isWorkbenchAnalysisInFlight(false, { status: 'running' }), true)
  assert.equal(isWorkbenchAnalysisInFlight(false, { status: 'failed' }), false)
})

test('historical workbench keeps the full stage name available for responsive truncation', () => {
  assert.equal(resolveHistoricalWorkbenchTitle('成果验证'), '正在查看 成果验证')
  assert.equal(resolveHistoricalWorkbenchTitle('  产业调研阶段  '), '正在查看 产业调研阶段')
  assert.equal(resolveHistoricalWorkbenchTitle('一二三四五六七八九十一二三'), '正在查看 一二三四五六七八九十一二三')
  assert.equal(resolveHistoricalWorkbenchTitle(), '正在查看')
})

test('analysis action remains available after success and retries after failure', () => {
  assert.equal(resolveWorkbenchAnalysisAction({}), undefined)
  assert.deepEqual(resolveWorkbenchAnalysisAction({ report: {} }), { label: '启动分析', failed: false })
  assert.deepEqual(resolveWorkbenchAnalysisAction({ report: { hasCompletedFullAnalysis: true } }), { label: '更新分析', failed: false })

  assert.deepEqual(resolveWorkbenchAnalysisAction({
    report: {},
    job: { status: 'failed', errorMessage: '模型超时。' },
  }), { label: '再次分析', failed: true, errorMessage: '模型超时。' })
  assert.deepEqual(resolveWorkbenchAnalysisAction({
    report: { hasCompletedFullAnalysis: true },
    job: { status: 'failed' },
  }), { label: '再次分析', failed: true, errorMessage: '报告分析失败。' })
  assert.deepEqual(resolveWorkbenchAnalysisAction({
    report: {},
    job: { status: 'cancelled', errorMessage: '分析已停止。' },
  }), { label: '启动分析', failed: false })
})

test('analysis result display keeps previous data during rerun and marks stale after failure', () => {
  assert.equal(resolveAnalysisResultDisplay({ analyzing: true, hasData: false }), 'scanning')
  assert.equal(resolveAnalysisResultDisplay({ analyzing: true, hasData: true }), 'updating')
  assert.equal(resolveAnalysisResultDisplay({ analyzing: false, hasData: true }), 'ready')
  assert.equal(resolveAnalysisResultDisplay({ analyzing: false, hasData: true, jobStatus: 'failed' }), 'stale')
  assert.equal(resolveAnalysisResultDisplay({ analyzing: false, hasData: true, jobStatus: 'cancelled' }), 'stale')
  assert.equal(resolveAnalysisResultDisplay({ analyzing: false, hasData: false, jobStatus: 'failed' }), 'failed')
  assert.equal(resolveAnalysisResultDisplay({ analyzing: false, hasData: false, jobStatus: 'cancelled' }), 'cancelled')
  assert.equal(resolveAnalysisResultDisplay({ analyzing: false, hasData: false }), 'empty')
  assert.deepEqual(analysisResultHint('updating'), { label: '正在更新', tone: 'brand' })
  assert.deepEqual(analysisResultHint('stale'), { label: '仍显示上一版', tone: 'warning' })
  assert.equal(analysisResultHint('ready'), undefined)
  assert.equal(analysisResultPlaceholder('failed'), '分析未完成，请重新启动。')
  assert.equal(analysisResultPlaceholder('cancelled'), '分析已停止，可重新启动。')
  assert.equal(analysisResultPlaceholder('empty'), '暂无数据，请先启动AI分析。')
})

function heatmapFixture(rows: Array<{ id: string; label: string; values: number[] }>): HeatmapData {
  return {
    columns: [...RESEARCH_METHODS],
    rows: rows.map((row) => ({
      id: row.id,
      label: row.label,
      cells: row.values.map((value, index) => ({
        columnId: RESEARCH_METHODS[index]?.id ?? String(index),
        value,
        ratio: Math.max(0, Math.min(1, value / 100)),
      })),
    })),
  }
}

function heatmapHtml(data: HeatmapData, isExpanded?: boolean) {
  return renderToStaticMarkup(createElement(HeatmapVisualization, { data, isExpanded }))
}

function heatmapCells(html: string) {
  return [...html.matchAll(/<g><title>([^<]*)<\/title><rect ([^>]+)><\/rect><text ([^>]*)>([^<]*)<\/text><\/g>/g)].map((match) => ({
    title: match[1],
    rect: match[2],
    text: match[3],
    body: match[4],
  }))
}

test('heatmap native svg keeps original visx cell geometry, contrast and empty text', () => {
  const html = heatmapHtml(heatmapFixture([{ id: 'h1', label: '正文', values: [100, 55, 30, 0, 0, 45] }]))
  const cells = heatmapCells(html)
  assert.equal(cells.length, 6)
  assert.equal(html.includes('<g><title>正文 / 文献综述：100% 使用强度</title><rect x="74" y="40" width="52" height="30" rx="6" fill="var(--yx-brand)"></rect><text x="100" y="55" text-anchor="middle" dominant-baseline="central" fill="var(--yx-paper)" font-size="10" font-weight="700">100%</text></g>'), true)
  assert.equal(html.includes('<g><title>正文 / 定性分析：55% 使用强度</title><rect x="74" y="80" width="52" height="30" rx="6" fill="var(--yx-muted)"></rect><text x="100" y="95" text-anchor="middle" dominant-baseline="central" fill="var(--yx-paper)" font-size="10" font-weight="700">55%</text></g>'), true)
  assert.equal(html.includes('<g><title>正文 / 案例研究：0% 使用强度</title><rect x="74" y="160" width="52" height="30" rx="6" fill="var(--yx-paper)"></rect><text x="100" y="175" text-anchor="middle" dominant-baseline="central" fill="var(--yx-ink)" font-size="10" font-weight="700"></text></g>'), true)
  assert.match(html, /viewBox="0 0 152 294"/)
  assert.match(html, /overflow-auto p-2/)
  assert.doesNotMatch(html, /visx-heatmap/)

  const expanded = heatmapHtml(heatmapFixture([{ id: 'h1', label: '正文', values: [100, 55, 30, 0, 0, 45] }]), true)
  assert.equal(expanded.includes('<g><title>正文 / 文献综述：100% 使用强度</title><rect x="92" y="40" width="70" height="38" rx="6" fill="var(--yx-brand)"></rect><text x="127" y="59" text-anchor="middle" dominant-baseline="central" fill="var(--yx-paper)" font-size="12" font-weight="700">100%</text></g>'), true)

  const empty = heatmapHtml(heatmapFixture([]))
  assert.equal(heatmapCells(empty).length, 0)
  assert.match(empty, /viewBox="0 0 90 294"/)
  assert.match(empty, /<title>文献综述<\/title>文献综述/)
  assert.match(empty, /较少/)
  assert.match(empty, /较多/)

  const long = heatmapHtml(heatmapFixture([
    { id: 'h1', label: '绪论非常长的章节标题', values: [100, 55, 0, 12, 80, 1] },
    { id: 'h2', label: '方法', values: [0, 0, 0, 0, 0, 0] },
    { id: 'h3', label: '结论', values: [54, 55, 56, 99, 100, 40] },
  ]))
  assert.match(long, /<title>绪论非常长的章节标题<\/title>绪论非常…/)
  assert.equal(heatmapCells(long).length, 18)
  assert.equal(long.includes('<g><title>结论 / 对比分析：40% 使用强度</title><rect x="198" y="240" width="52" height="30" rx="6" fill="#b4b2ad"></rect><text x="224" y="255" text-anchor="middle" dominant-baseline="central" fill="var(--yx-ink)" font-size="10" font-weight="700">40%</text></g>'), true)

  const missing = heatmapHtml(heatmapFixture([{ id: 'h1', label: '正文', values: [100] }]))
  assert.equal(heatmapCells(missing).length, 6)
  assert.match(missing, /正文 \/ 对比分析：0% 使用强度/)
})

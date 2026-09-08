import assert from 'node:assert/strict'
import test from 'node:test'
import {
  analysisResultHint,
  analysisResultPlaceholder,
  resolveAnalysisResultDisplay,
} from '../modules/analysis/progress'
import {
  isWorkbenchAnalysisInFlight,
  resolveHistoricalWorkbenchTitle,
  resolveWorkbenchAnalysisAction,
} from '../components/research-workbench'

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

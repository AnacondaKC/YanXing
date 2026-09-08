import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FileText, Gauge } from 'lucide-react'
import { ErrorFallback } from '../components/error-fallback'
import { ReportCompletenessCard, ScoreMetricList, ScoreRing } from '../components/insight-cards'
import { EMPTY_SNAPSHOT } from '../lib/analysis-job-progress'
import { InfoCallout } from '../components/info-callout'
import { ProjectExecutiveHeader } from '../components/project-executive-header'
import { EmptyState } from '../components/ui/empty-state'
import { MindMapScanningSkeleton } from '../components/research-visualization-card'
import { workspaceErrorCopy } from '../lib/workspace-error'
import type { ProjectWithCapabilities } from '../modules/projects/domain'

test('error fallback renders the workspace recovery copy', () => {
  const html = renderToStaticMarkup(createElement(ErrorFallback, { onRetry() {} }))
  assert.match(html, new RegExp(workspaceErrorCopy.title))
  assert.match(html, new RegExp(workspaceErrorCopy.retry))
  assert.doesNotMatch(html, /emerald-/)
})

test('empty state uses paper tokens instead of decorative gradients', () => {
  const html = renderToStaticMarkup(createElement(EmptyState, {
    icon: FileText,
    title: '暂无报告',
    description: '上传后可查看分析。',
  }))
  assert.match(html, /暂无报告/)
  assert.match(html, /bg-yx-paper/)
  assert.doesNotMatch(html, /bg-gradient/)
  assert.doesNotMatch(html, /emerald-/)
})

test('example project header does not invent collaborator names', () => {
  const project: ProjectWithCapabilities = {
    id: 'project-sample',
    ownerId: 'user-1',
    title: '示例课题',
    objective: '研究目标',
    description: '研究背景',
    ownerName: '课题负责人',
    status: 'in_progress',
    milestones: [],
    isExample: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    canManage: true,
    canDelete: true,
  }
  const html = renderToStaticMarkup(createElement(ProjectExecutiveHeader, { project }))
  assert.match(html, /课题负责人/)
  assert.doesNotMatch(html, /李敏/)
  assert.doesNotMatch(html, /赵研/)
  assert.doesNotMatch(html, /协作者/)
})

test('completeness rings sweep a comet arc while analyzing', () => {
  const html = renderToStaticMarkup(createElement(ScoreRing, { score: 0, analyzing: true }))
  assert.match(html, /yx-completeness-ring__sweep/)
  assert.match(html, /评估中/)
  assert.doesNotMatch(html, /yx-bar-delay/)
  assert.doesNotMatch(html, /yx-score-ring-scan/)
})

test('completeness rings share one sweep instead of staggered progress', () => {
  const html = renderToStaticMarkup(createElement(ReportCompletenessCard, {
    snapshot: EMPTY_SNAPSHOT,
    analyzing: true,
    jobStatus: 'running',
  }))
  const ringSweeps = [...html.matchAll(/yx-completeness-ring__sweep/g)]
  assert.equal(ringSweeps.length, 6)
  assert.doesNotMatch(html, /yx-completeness-ring[^>]*yx-bar-delay/)
})

test('analyzing score metrics slide like the completeness bar from top to bottom', () => {
  const html = renderToStaticMarkup(createElement(ScoreMetricList, {
    dimensions: [
      { id: '研究价值', label: '研究价值', score: 0 },
      { id: '方法严谨', label: '方法严谨', score: 0 },
    ],
    hasDimensions: false,
    analyzing: true,
  }))
  assert.match(html, /yx-completeness-bar/)
  assert.match(html, /--yx-bar-delay:0ms/)
  assert.match(html, /--yx-bar-delay:1200ms/)
  assert.match(html, /--/)
  assert.doesNotMatch(html, /yx-score-measure/)
  assert.doesNotMatch(html, /yx-suggestion-bar/)
})

test('scanning callout types a line of ghost words with a caret', () => {
  const html = renderToStaticMarkup(createElement(InfoCallout, {
    icon: Gauge,
    label: '主要影响因素',
    scanning: true,
  }))
  assert.match(html, /yx-callout-type/)
  assert.match(html, /yx-callout-type__caret/)
  assert.doesNotMatch(html, /yx-suggestion-bar/)
  assert.doesNotMatch(html, /yx-callout-scan/)
})

test('mind map empty-state icon uses three third-layer nodes matching the second layer', () => {
  const html = renderToStaticMarkup(createElement(MindMapScanningSkeleton))
  const branches = [...html.matchAll(/fill="var\(--yx-brand\)"/g)]
  const leaves = [...html.matchAll(/width="64" height="24" rx="9" fill="var\(--yx-paper\)" stroke="var\(--yx-brand-bright\)"/g)]
  const leafLines = [...html.matchAll(/d="M232 \d+ H256"/g)]
  assert.equal(branches.length, 3)
  assert.equal(leaves.length, 3)
  assert.equal(leafLines.length, 3)
  assert.doesNotMatch(html, /width="20" height="16"/)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import type { VisualizationMindMapNode } from '../modules/contracts/analysis'
import {
  getMindMapDirection,
  getMindMapNodeGeometry,
  getNodeDisplayLabel,
  type MindMapDirection,
  type MindMapNodeKind,
} from '../lib/rendering/graph-layout'

const canvasPadding = 128

function node(label: string, children: VisualizationMindMapNode[] = [], id = label): VisualizationMindMapNode {
  return { id, label, children }
}

function nodeKind(item: VisualizationMindMapNode, depth: number): MindMapNodeKind {
  return depth === 0 ? 'root' : item.children.length ? 'branch' : 'leaf'
}

function getMindMapDepth(item: VisualizationMindMapNode): number {
  return item.children.length ? 1 + Math.max(...item.children.map(getMindMapDepth)) : 0
}

function legacyGetMindMapDirection(root: VisualizationMindMapNode): MindMapDirection {
  let leafCount = 0
  function countLeaves(item: VisualizationMindMapNode) {
    if (!item.children.length) leafCount += 1
    for (const child of item.children) countLeaves(child)
  }
  countLeaves(root)
  const maxDepth = getMindMapDepth(root)
  const count = Math.max(1, leafCount)
  let maxDepthWidth = 400
  let maxDepthHeight = 70
  let maxBreadthWidth = 40
  let maxBreadthHeight = 52
  function visit(item: VisualizationMindMapNode, depth: number) {
    const kind = nodeKind(item, depth)
    const hGeom = getMindMapNodeGeometry(kind, getNodeDisplayLabel(item.label, kind).length, 'left-to-right')
    const vGeom = getMindMapNodeGeometry(kind, getNodeDisplayLabel(item.label, kind).length, 'top-to-bottom')
    maxDepthWidth = Math.max(maxDepthWidth, vGeom.width)
    maxDepthHeight = Math.max(maxDepthHeight, vGeom.height)
    if (depth > 0) {
      maxBreadthWidth = Math.max(maxBreadthWidth, vGeom.width)
      maxBreadthHeight = Math.max(maxBreadthHeight, hGeom.height)
    }
    for (const child of item.children) visit(child, depth + 1)
  }
  visit(root, 0)
  const horizontalBreadthSpan = (count - 1) * (maxBreadthHeight + 16) + maxBreadthHeight
  const verticalBreadthSpan = (count - 1) * (maxBreadthWidth + 16) + maxBreadthWidth
  const horizontalDepthSpan = Math.max(maxDepthWidth + 160, (maxDepth + 1) * 220)
  const verticalDepthSpan = Math.max(maxDepthHeight + 160, (maxDepth + 1) * 160)
  const vWidth = verticalBreadthSpan + canvasPadding * 2
  const vHeight = verticalDepthSpan + canvasPadding * 2
  const hWidth = horizontalDepthSpan + canvasPadding * 2
  const hHeight = horizontalBreadthSpan + canvasPadding * 2
  if (vWidth < vHeight) return 'left-to-right'
  if (vWidth >= vHeight * 1.25) return 'top-to-bottom'
  const hScale = Math.min(960 / hWidth, 540 / hHeight)
  const vScale = Math.min(960 / vWidth, 540 / vHeight)
  return hScale >= vScale ? 'left-to-right' : 'top-to-bottom'
}

const trees: VisualizationMindMapNode[] = [
  node('根'),
  node('项目投资分析', [node('收益'), node('风险'), node('进度')]),
  node('深链', [node('一层', [node('二层', [node('三层', [node('四层')])])])]),
  node('宽树', Array.from({ length: 12 }, (_, index) => node(`分支${index + 1}`, [node(`叶${index + 1}A`), node(`叶${index + 1}B`)], `b${index}`))),
  node('超长标题用于触发截断与折行ABCDEFGHIJKLMNOPQRSTUVWXYZ', [node('很长的分支标签一二三四五六七八九十')]),
]

test('getMindMapDirection 单次遍历与原三趟统计方向完全一致', () => {
  for (const tree of trees) {
    assert.equal(getMindMapDirection(tree), legacyGetMindMapDirection(tree))
  }
})

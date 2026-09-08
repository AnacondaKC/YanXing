import type { VisualizationMindMapNode } from '@/modules/contracts/analysis'

export type MindMapDirection = 'left-to-right' | 'top-to-bottom'
export type MindMapNodeKind = 'root' | 'branch' | 'leaf'

export interface MindMapNodeGeometry {
  width: number
  height: number
  charStep: number
}

const canvasPadding = 128

/** 根节点单行最多容纳的字符数（字体 18px，节点宽度 400px，CJK 字符宽约 18px） */
const ROOT_MAX_LINE_CHARS = 20
/** 根节点每行文字的行高 */
export const ROOT_LINE_HEIGHT = 28

/** 根节点最多显示的字符数（超出部分截断隐藏） */
const ROOT_MAX_CHARS = 40
/** 分支节点最多显示的字符数（超出部分截断隐藏） */
const BRANCH_MAX_CHARS = 12
/** 叶节点最多显示的字符数（超出部分截断隐藏） */
const LEAF_MAX_CHARS = 10

/** 按节点类型截断标签：超出上限的字符不再渲染，末尾以省略号提示。供几何计算与渲染共用，保证两者一致。 */
export function getNodeDisplayLabel(label: string, kind: MindMapNodeKind): string {
  const maxChars = kind === 'root' ? ROOT_MAX_CHARS : kind === 'branch' ? BRANCH_MAX_CHARS : LEAF_MAX_CHARS
  return label.length > maxChars ? `${label.slice(0, maxChars - 1)}…` : label
}

/** 将根节点标题按固定宽度折行，供渲染与几何计算共用，保证两者一致 */
export function getRootLabelLines(label: string): string[] {
  const lines: string[] = []
  for (let i = 0; i < label.length; i += ROOT_MAX_LINE_CHARS) {
    lines.push(label.slice(i, i + ROOT_MAX_LINE_CHARS))
  }
  return lines.length ? lines : ['']
}

function nodeKind(node: VisualizationMindMapNode, depth: number): MindMapNodeKind {
  return depth === 0 ? 'root' : node.children.length ? 'branch' : 'leaf'
}

export function getMindMapNodeGeometry(kind: MindMapNodeKind, labelLength: number, direction: MindMapDirection = 'top-to-bottom'): MindMapNodeGeometry {
  if (kind === 'root') {
    const lines = Math.max(1, Math.ceil(labelLength / ROOT_MAX_LINE_CHARS))
    if (direction === 'left-to-right') {
      const width = Math.min(360, Math.max(140, labelLength * 16 + 32))
      return { width, height: Math.max(52, lines * ROOT_LINE_HEIGHT + 16), charStep: 0 }
    }
    return { width: 400, height: Math.max(70, lines * ROOT_LINE_HEIGHT + 16), charStep: 0 }
  }
  if (direction === 'left-to-right') {
    if (kind === 'branch') {
      const charStep = 13
      return { width: Math.max(76, labelLength * charStep + 24), height: 34, charStep }
    }
    const charStep = 12
    return { width: Math.max(64, labelLength * charStep + 20), height: 28, charStep }
  }
  if (kind === 'branch') {
    const charStep = 15
    return { width: 40, height: Math.max(52, labelLength * charStep + 16), charStep }
  }
  const charStep = 14
  return { width: 36, height: Math.max(44, labelLength * charStep + 14), charStep }
}

export function getMindMapDirection(root: VisualizationMindMapNode): MindMapDirection {
  let leafCount = 0
  let maxDepth = 0
  let maxDepthWidth = 400
  let maxDepthHeight = 70
  let maxBreadthWidth = 40
  let maxBreadthHeight = 52
  function visit(node: VisualizationMindMapNode, depth: number) {
    if (!node.children.length) leafCount += 1
    maxDepth = Math.max(maxDepth, depth)
    const kind = nodeKind(node, depth)
    const labelLength = getNodeDisplayLabel(node.label, kind).length
    const hGeom = getMindMapNodeGeometry(kind, labelLength, 'left-to-right')
    const vGeom = getMindMapNodeGeometry(kind, labelLength, 'top-to-bottom')
    maxDepthWidth = Math.max(maxDepthWidth, vGeom.width)
    maxDepthHeight = Math.max(maxDepthHeight, vGeom.height)
    if (depth > 0) {
      maxBreadthWidth = Math.max(maxBreadthWidth, vGeom.width)
      maxBreadthHeight = Math.max(maxBreadthHeight, hGeom.height)
    }
    for (const child of node.children) visit(child, depth + 1)
  }
  visit(root, 0)
  const count = Math.max(1, leafCount)
  const horizontalBreadthSpan = (count - 1) * (maxBreadthHeight + 16) + maxBreadthHeight
  const verticalBreadthSpan = (count - 1) * (maxBreadthWidth + 16) + maxBreadthWidth
  const horizontalDepthSpan = Math.max(maxDepthWidth + 160, (maxDepth + 1) * 220)
  const verticalDepthSpan = Math.max(maxDepthHeight + 160, (maxDepth + 1) * 160)

  const vWidth = verticalBreadthSpan + canvasPadding * 2
  const vHeight = verticalDepthSpan + canvasPadding * 2
  const hWidth = horizontalDepthSpan + canvasPadding * 2
  const hHeight = horizontalBreadthSpan + canvasPadding * 2

  // 1. 若纵向排版会导致“宽度小于高度”（细长高条形），在宽屏与卡片视口中会被过度缩放且两侧留白过大，必须选择横向展开
  if (vWidth < vHeight) {
    return 'left-to-right'
  }

  // 2. 若纵向排版“宽度明显大于高度”（层级浅且横向并列子分支很多），自顶向下纵向延伸能充分横向铺开各分支
  if (vWidth >= vHeight * 1.25) {
    return 'top-to-bottom'
  }

  // 3. 其它居中形态下，比较在标准宽屏视口下的缩放利用率（取文字呈现更大、留白更少的方向）
  const viewportW = 960
  const viewportH = 540
  const hScale = Math.min(viewportW / hWidth, viewportH / hHeight)
  const vScale = Math.min(viewportW / vWidth, viewportH / vHeight)
  return hScale >= vScale ? 'left-to-right' : 'top-to-bottom'
}

import { MAX_MINDMAP_CHILDREN, MAX_MINDMAP_DEPTH, MAX_MINDMAP_LABEL_LENGTH, MAX_MINDMAP_NODES } from '@/modules/contracts/analysis'

export interface MindMapNormalizationResult {
  payload: unknown
  repairedPaths: string[]
}

/** Only an unambiguous, non-root leaf may omit its empty child array. */
export function normalizePageMindMapPayload(payload: unknown): MindMapNormalizationResult {
  const repairedPaths: string[] = []
  if (!isRecord(payload)) return { payload, repairedPaths }
  let visitedNodes = 0

  function normalizeNode(node: unknown, depth: number, path: string): unknown {
    visitedNodes += 1
    if (visitedNodes > MAX_MINDMAP_NODES || depth >= MAX_MINDMAP_DEPTH || !isRecord(node)) return node
    if (depth > 0 && isOmittedLeaf(node)) {
      repairedPaths.push(`${path}/子节点`)
      return { ...node, '子节点': [] }
    }

    const children = node['子节点']
    if (!Array.isArray(children) || children.length > MAX_MINDMAP_CHILDREN) return node
    const normalizedChildren = children.map((child, index) => normalizeNode(child, depth + 1, `${path}/子节点/${index}`))
    return normalizedChildren.some((child, index) => child !== children[index])
      ? { ...node, '子节点': normalizedChildren }
      : node
  }

  const root = payload['思维导图']
  const normalizedRoot = normalizeNode(root, 0, '/思维导图')
  return {
    payload: normalizedRoot === root ? payload : { ...payload, '思维导图': normalizedRoot },
    repairedPaths,
  }
}

function isOmittedLeaf(node: Record<string, unknown>): boolean {
  const label = node['名称']
  return Object.keys(node).length === 1
    && Object.hasOwn(node, '名称')
    && typeof label === 'string'
    && label.length <= MAX_MINDMAP_LABEL_LENGTH
    && label.replace(/[\s\u200B\u200C\u200D\uFEFF]/gu, '').length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

import { Value } from 'typebox/value'
import type { TSchema } from 'typebox'
import { AiScoreDimensions, ReportCompletenessDimensions, type GateError } from '@/modules/contracts/analysis'
import { isLowInformationWordCloudKeyword, normalizeWordCloudKeyword, wordCloudKeywordKey } from '@/modules/analysis/word-cloud'

export interface GateResult<T> {
  accepted: boolean
  value?: T
  errors: GateError[]
}

const maxGateErrors = 50

export function validateModuleOutput<T>(input: { schema: TSchema; output: unknown; extra?: (output: unknown) => GateError[] }): GateResult<T> {
  const errors: GateError[] = []
  if (!Value.Check(input.schema, input.output)) {
    for (const error of Value.Errors(input.schema, input.output)) {
      const validationError = error as { path?: string; message: string; type?: string }
      errors.push({ code: 'SCHEMA_INVALID', path: (validationError.path || '/').slice(0, 200), message: validationError.message.slice(0, 500), expected: validationError.type?.slice(0, 200) })
      if (errors.length >= maxGateErrors) break
    }
    return { accepted: false, errors }
  }
  errors.push(...(input.extra?.(input.output) ?? []).slice(0, maxGateErrors))
  return errors.length ? { accepted: false, errors } : { accepted: true, value: input.output as T, errors: [] }
}

export function validatePageAnalysisOutput(output: unknown): GateError[] {
  if (!isRecord(output)) return []
  const errors: GateError[] = []
  validateFixedTable(output['综合评分'], AiScoreDimensions.map((dimension) => dimension.id), '/综合评分', '综合评分', errors)
  validateFixedTable(output['报告完整度'], ReportCompletenessDimensions.map((dimension) => dimension.id), '/报告完整度', '报告完整度', errors)
  if (isRecord(output['综合评分'])) validateNonBlank(output['综合评分']['主要影响因素'], '/综合评分/主要影响因素', '主要影响因素', errors)
  if (isRecord(output['报告完整度'])) validateNonBlank(output['报告完整度']['主要缺口'], '/报告完整度/主要缺口', '主要缺口', errors)
  const detailTitles = validatePageDetails(output['报告详情'], errors)
  validatePageMindMap(output['思维导图'], '/思维导图', 0, { count: 0 }, errors)
  validateWordCloudWords(output['词云'], '/词云', errors)
  validateHeatmapRows(output['热力图'], detailTitles, errors)
  validateSuggestions(output['AI建议'], errors)
  return errors.slice(0, maxGateErrors)
}

function validateFixedTable(value: unknown, expectedKeys: readonly string[], path: string, label: string, errors: GateError[]) {
  if (!isRecord(value)) return
  for (const key of expectedKeys) {
    if (!(key in value)) errors.push(gateError('MISSING_FIXED_SCORE', path, `${label}缺少固定字段 ${key}。`))
  }
}

function validatePageDetails(value: unknown, errors: GateError[]) {
  const exactTitles = new Set<string>()
  const normalizedTitles = new Set<string>()
  if (!isRecord(value)) return exactTitles
  validateNonBlank(value['完整度结论'], '/报告详情/完整度结论', '完整度结论', errors)
  if (!Array.isArray(value['章节'])) return exactTitles
  value['章节'].forEach((section, index) => {
    if (!isRecord(section)) return
    const title = section['标题']
    const summary = section['摘要']
    if (typeof title === 'string') {
      validateNonBlank(title, `/报告详情/章节/${index}/标题`, '章节标题', errors)
      const key = normalizeChapterTitle(title)
      if (key && normalizedTitles.has(key)) errors.push(gateError('DUPLICATE_REPORT_DETAIL_SECTION', `/报告详情/章节/${index}/标题`, `报告详情章节标题 ${title} 重复。`))
      if (key) normalizedTitles.add(key)
      if (isNonBlankText(title)) exactTitles.add(title)
    }
    validateNonBlank(summary, `/报告详情/章节/${index}/摘要`, '章节摘要', errors)
  })
  return exactTitles
}

function validatePageMindMap(node: unknown, path: string, depth: number, state: { count: number }, errors: GateError[]) {
  state.count += 1
  if (state.count > 200) {
    if (state.count === 201) errors.push(gateError('MINDMAP_NODE_LIMIT_EXCEEDED', path, '思维导图最多允许 200 个节点（包含根节点）。'))
    return
  }
  if (!isRecord(node)) { errors.push(gateError('INVALID_MINDMAP_NODE', path, '思维导图节点必须是对象。')); return }
  const unexpectedFields = Object.keys(node).filter((key) => !['名称', '子节点'].includes(key))
  unexpectedFields.forEach((key) => errors.push(gateError('UNEXPECTED_MINDMAP_FIELD', `${path}/${key}`, `思维导图节点不允许字段 ${key}。`)))
  if (typeof node['名称'] !== 'string' || !isNonBlankText(node['名称']) || node['名称'].length > 160) errors.push(gateError('INVALID_MINDMAP_LABEL', `${path}/名称`, '思维导图节点名称必须为不超过 160 个字符的非空文本。'))
  const children = node['子节点']
  if (!Array.isArray(children)) { errors.push(gateError('INVALID_MINDMAP_CHILDREN', `${path}/子节点`, '思维导图节点必须包含子节点数组。')); return }
  if (children.length > 12) errors.push(gateError('TOO_MANY_MINDMAP_CHILDREN', `${path}/子节点`, '单个思维导图节点最多包含 12 个子节点。'))
  if (depth === 0 && children.length === 0) errors.push(gateError('EMPTY_MINDMAP_ROOT', `${path}/子节点`, '思维导图根节点必须包含至少一个子节点。'))
  if (depth >= 4) { if (children.length > 0) errors.push(gateError('MINDMAP_DEPTH_EXCEEDED', `${path}/子节点`, '思维导图最多允许五层层级。')); return }
  children.slice(0, 12).forEach((child, index) => validatePageMindMap(child, `${path}/子节点/${index}`, depth + 1, state, errors))
}

function validateWordCloudWords(value: unknown, path: string, errors: GateError[]) {
  if (!Array.isArray(value)) return
  const labels = new Set<string>()
  value.forEach((word, index) => {
    if (typeof word !== 'string') return
    if (!isNonBlankText(word)) errors.push(gateError('BLANK_WORD_LABEL', `${path}/${index}`, '词云关键词不能是空白文本。'))
    const label = normalizeWordCloudKeyword(word)
    const key = wordCloudKeywordKey(label)
    if (key && labels.has(key)) errors.push(gateError('DUPLICATE_WORD_LABEL', `${path}/${index}`, `词云关键词 ${label} 重复。`))
    if (key) labels.add(key)
    if (isLowInformationWordCloudKeyword(label)) errors.push(gateError('LOW_INFORMATION_WORD', `${path}/${index}`, `词云关键词 ${label} 信息量不足。`))
  })
}

function validateHeatmapRows(value: unknown, detailTitles: ReadonlySet<string>, errors: GateError[]) {
  if (!Array.isArray(value)) return
  const labels = new Set<string>()
  value.forEach((row, index) => {
    if (!isRecord(row) || typeof row['章节'] !== 'string') return
    const title = row['章节']
    if (!isNonBlankText(title)) errors.push(gateError('BLANK_HEATMAP_CHAPTER', `/热力图/${index}/章节`, '热力图章节不能是空白文本。'))
    const key = normalizeChapterTitle(title)
    if (key && labels.has(key)) errors.push(gateError('DUPLICATE_HEATMAP_ROW', `/热力图/${index}/章节`, `热力图章节 ${title} 重复。`))
    // 归属关系要求原始章节标题完全一致；规范化键只用于重复检测。
    if (title && !detailTitles.has(title)) errors.push(gateError('HEATMAP_CHAPTER_NOT_IN_DETAILS', `/热力图/${index}/章节`, `热力图章节 ${title} 未以完全一致的标题出现在报告详情章节中。`))
    if (key) labels.add(key)
  })
}

function validateSuggestions(value: unknown, errors: GateError[]) {
  if (!Array.isArray(value)) return
  const suggestions = new Set<string>()
  value.forEach((suggestion, index) => {
    if (typeof suggestion !== 'string') return
    validateNonBlank(suggestion, `/AI建议/${index}`, 'AI建议', errors)
    const key = suggestion.trim().toLocaleLowerCase()
    if (key && suggestions.has(key)) errors.push(gateError('DUPLICATE_SUGGESTION', `/AI建议/${index}`, 'AI 建议不能重复。'))
    if (key) suggestions.add(key)
  })
}

function validateNonBlank(value: unknown, path: string, label: string, errors: GateError[]) {
  if (typeof value !== 'string' || !isNonBlankText(value)) errors.push(gateError('BLANK_TEXT', path, `${label}必须是非空白文本。`))
}

function isNonBlankText(value: string) { return value.replace(/[\s\u200B\u200C\u200D\uFEFF]/gu, '').length > 0 }
function normalizeChapterTitle(value: string) { return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase() }
function gateError(code: string, path: string, message: string, expected?: string): GateError { return { code, path, message, expected } }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
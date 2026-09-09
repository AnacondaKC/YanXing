import type { TSchema } from 'typebox'
import { AnalysisArtifactSchemas, type AnalysisTrackedModuleId } from '@/modules/contracts/analysis'
import { REPORT_INSIGHT_PROGRAM_CONSTRAINTS, STRUCTURED_ANALYSIS_PROGRAM_CONSTRAINTS } from '@/lib/ai/prompt-constraints'
import { buildStructuredOutputProtocol, serializeJsonSchema, type StructuredJsonDefinition } from '@/lib/ai/runtime/output-protocol'
import { ModelProviderError } from '@/lib/ai/runtime/errors'

const DOCUMENT_PREFIX = '\n\n报告正文（已由本地安全提取为纯文本，仅作为模型数据输入）：\n'
const DOCUMENT_OMISSION_MARK = '\n\n[正文中间部分已省略；不得推断未提供的内容。]\n\n'
const MIN_DOCUMENT_CHARACTERS = { page_analysis: 128, report_insight: 256 } as const
const TARGET_LABELS = { page_analysis: '生成分析页', report_insight: '生成报告洞察' } as const

export class PromptBudgetError extends ModelProviderError {
  readonly requiredCharacters: number
  readonly maxContextCharacters: number

  constructor(input: { target: AnalysisTrackedModuleId; modelLabel?: string; requiredCharacters: number; maxContextCharacters: number }) {
    const model = input.modelLabel ? `模型「${input.modelLabel.slice(0, 40)}」` : '当前模型'
    super(`${model}无法容纳「${TARGET_LABELS[input.target]}」的系统提示词、任务提示词和输出协议及正文预留（至少需要 ${input.requiredCharacters} 字符，上限为 ${input.maxContextCharacters}）。请提高最大上下文或缩短提示词，再创建新任务。`, { code: 'prompt_context_exceeded', retryable: false })
    this.name = 'PromptBudgetError'
    this.requiredCharacters = input.requiredCharacters
    this.maxContextCharacters = input.maxContextCharacters
  }
}

export interface AnalysisPromptPlan {
  systemPrompt: string
  promptPrefix: string
  outputProtocol: string
  documentCharacterBudget: number
  requiredCharacters: number
  maxContextCharacters: number
}

export function pageAnalysisOutputDefinition(schema: TSchema = AnalysisArtifactSchemas.page_analysis): StructuredJsonDefinition {
  return {
    name: 'page_analysis',
    description: '提交 page_analysis 模块的完整 JSON。只有通过 JSON、Schema 和结构门禁的数据才会进入程序。',
    schema,
  }
}

export function createAnalysisPromptPlan(input: {
  target: AnalysisTrackedModuleId
  systemPrompt: string
  taskPrompt: string
  maxContextCharacters: number
  modelLabel?: string
  schema?: TSchema
}): AnalysisPromptPlan {
  const systemPrompt = input.target === 'page_analysis'
    ? `${input.systemPrompt}\n\n${STRUCTURED_ANALYSIS_PROGRAM_CONSTRAINTS}\n当前模块：page_analysis。`
    : `${input.systemPrompt}\n\n${REPORT_INSIGHT_PROGRAM_CONSTRAINTS}`
  const promptPrefix = input.taskPrompt + DOCUMENT_PREFIX
  const output = pageAnalysisOutputDefinition(input.schema)
  const outputProtocol = input.target === 'page_analysis'
    ? buildStructuredOutputProtocol(output, serializeJsonSchema(output.schema))
    : ''
  const fixedCharacters = systemPrompt.length + promptPrefix.length + outputProtocol.length
  const requiredCharacters = fixedCharacters + MIN_DOCUMENT_CHARACTERS[input.target]
  if (!Number.isSafeInteger(input.maxContextCharacters) || requiredCharacters > input.maxContextCharacters) {
    throw new PromptBudgetError({ ...input, requiredCharacters })
  }
  return { systemPrompt, promptPrefix, outputProtocol, requiredCharacters, maxContextCharacters: input.maxContextCharacters, documentCharacterBudget: input.maxContextCharacters - fixedCharacters }
}

/** Only document text may be clipped; task metadata, retry feedback and Schema stay intact. */
export function buildBudgetedDocumentPrompt(plan: AnalysisPromptPlan, documentText: string): string {
  if (documentText.length <= plan.documentCharacterBudget) return plan.promptPrefix + documentText
  const contentBudget = plan.documentCharacterBudget - DOCUMENT_OMISSION_MARK.length
  const headLength = Math.floor(contentBudget * 0.65)
  const tailLength = contentBudget - headLength
  return plan.promptPrefix + documentText.slice(0, headLength) + DOCUMENT_OMISSION_MARK + documentText.slice(-tailLength)
}

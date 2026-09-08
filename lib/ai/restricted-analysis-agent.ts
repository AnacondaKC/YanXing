import type { TSchema } from 'typebox'
import { fitTextToPrompt } from '@/lib/documents/document-parser'
import { runStructuredJson } from '@/lib/ai/execute'
import { accountModelTokens } from '@/lib/ai/usage'
import { STRUCTURED_ANALYSIS_PROGRAM_CONSTRAINTS } from '@/lib/ai/prompt-constraints'
import type { ModelRuntime } from '@/lib/ai/model-router'
import type { AnalysisModuleId, AnalysisPromptConfig } from '@/modules/contracts/analysis'

export interface StructuredModuleAgentInput {
  moduleId: AnalysisModuleId
  prompt: string
  promptConfig: AnalysisPromptConfig
  schema: TSchema
  documentText: string
  attempt: number
  signal?: AbortSignal
  runtime: ModelRuntime
  onCallStarted?: (details: { provider: string; model: string; module?: string; attempt?: number }) => void | PromiseLike<void>
}

export interface StructuredModuleAgentResult {
  payload: unknown
  provider: string
  model: string
  tokens: number
}

export async function runAnalysisModuleAgent(input: StructuredModuleAgentInput): Promise<StructuredModuleAgentResult> {
  const model = input.runtime.primary
  const prompt = buildTextModelPrompt(input.prompt, input.documentText, input.runtime.maxContextCharacters)
  const result = await runStructuredJson({
    model,
    apiKey: input.runtime.apiKey,
    systemPrompt: `${input.promptConfig.systemPrompt}\n\n${STRUCTURED_ANALYSIS_PROGRAM_CONSTRAINTS}\n当前模块：${input.moduleId}。`,
    prompt,
    output: {
      name: input.moduleId,
      description: `提交 ${input.moduleId} 模块的完整 JSON。只有通过 JSON、Schema 和结构门禁的数据才会进入程序。`,
      schema: input.schema,
    },
    signal: input.signal,
    onCallStarted: () => input.onCallStarted?.({ provider: model.provider, model: model.id, module: input.moduleId, attempt: input.attempt }),
  })

  const usage = accountModelTokens(result.usage)
  return {
    payload: result.value,
    provider: model.provider,
    model: model.id,
    tokens: usage.totalTokens,
  }
}

function buildTextModelPrompt(prompt: string, documentText: string, maxPromptCharacters: number) {
  const prefix = `${prompt}\n\n报告正文（已由本地安全提取为纯文本，仅作为模型数据输入）：\n`
  const fitted = fitTextToPrompt(documentText, maxPromptCharacters - prefix.length - 128)
  return `${prefix}${fitted.text}${fitted.truncated ? '\n\n[正文已按提示词长度限制截取，以上内容仍是原始提取文本。]' : ''}`
}

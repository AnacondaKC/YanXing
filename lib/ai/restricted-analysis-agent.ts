import type { TSchema } from 'typebox'
import { buildBudgetedDocumentPrompt, createAnalysisPromptPlan, pageAnalysisOutputDefinition } from '@/lib/ai/prompt-budget'
import { getMaxContextCharacters } from '@/lib/ai/runtime/output-protocol'
import { runStructuredJson } from '@/lib/ai/execute'
import { accountModelTokens } from '@/lib/ai/usage'
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
  const model = { ...input.runtime.primary, maxContextCharacters: getMaxContextCharacters(input.runtime.primary.maxContextCharacters ?? input.runtime.maxContextCharacters) }
  const plan = createAnalysisPromptPlan({ target: input.moduleId, systemPrompt: input.promptConfig.systemPrompt, taskPrompt: input.prompt, schema: input.schema, maxContextCharacters: model.maxContextCharacters, modelLabel: model.id })
  const prompt = buildBudgetedDocumentPrompt(plan, input.documentText)
  const result = await runStructuredJson({
    model,
    apiKey: input.runtime.apiKey,
    systemPrompt: plan.systemPrompt,
    prompt,
    output: pageAnalysisOutputDefinition(input.schema),
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

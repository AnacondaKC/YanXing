import type { TSchema } from 'typebox'
import type {
  AnalysisModuleId,
  AnalysisPromptConfig,
  GateError,
  ReportEvaluationContext,
  ReportFacts,
} from '@/modules/contracts/analysis'
import type { ReportSource } from '@/modules/reports/domain'

export interface AnalysisModuleContext {
  jobId: string
  reportVersionId: string
  reportFacts: ReportFacts
  reportSource: ReportSource
  evaluationContext: ReportEvaluationContext
  maxContextCharacters: number
  promptConfig: AnalysisPromptConfig
}

export interface AnalysisModuleAttemptContext extends AnalysisModuleContext {
  attempt: number
  previousErrors: GateError[]
}

export interface AnalysisModuleDefinition {
  id: AnalysisModuleId
  schemaVersion: number
  promptVersion: string
  maxAttempts: number
  schema: TSchema
  buildPrompt(context: AnalysisModuleAttemptContext): string
}

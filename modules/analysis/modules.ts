import {
  AnalysisArtifactSchemas,
} from '@/modules/contracts/analysis'
import type { AnalysisModuleDefinition } from '@/modules/analysis/module'
import { buildPageAnalysisTaskPrompt } from '@/modules/analysis/prompt'

export const pageAnalysisModule: AnalysisModuleDefinition = {
  id: 'page_analysis',
  schemaVersion: 1,
  promptVersion: 'page-analysis-v1',
  maxAttempts: 3,
  schema: AnalysisArtifactSchemas.page_analysis,
  buildPrompt: (context) => buildPageAnalysisTaskPrompt({
    instructionPrompt: context.promptConfig.instructionPrompt,
    reportFacts: context.reportFacts,
    evaluationContext: context.evaluationContext,
    previousErrors: context.previousErrors,
  }),
}

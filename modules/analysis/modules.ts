import {
  AnalysisArtifactSchemas,
} from '@/modules/contracts/analysis'

export const pageAnalysisModule = {
  id: 'page_analysis' as const,
  schemaVersion: 1,
  promptVersion: 'page-analysis-v1',
  maxAttempts: 3,
  schema: AnalysisArtifactSchemas.page_analysis,
}

import { Type, type TSchema } from 'typebox'

export const AnalysisStages = [
  'validating',
  'page_analysis',
  'quality_gate',
  'completed',
] as const

export type AnalysisStage = (typeof AnalysisStages)[number]
export type AnalysisJobStatus = 'queued' | 'running' | 'failed' | 'cancelled' | 'completed'

export type AnalysisJobEventType = 'stage' | 'info' | 'module_started' | 'module_gating' | 'module_retrying' | 'module_accepted' | 'module_failed' | 'snapshot_updated' | 'completed' | 'failed' | 'cancelled'

/** 分析快照 payload 的当前 schema；未上线项目不保留历史版本号。 */
export const ANALYSIS_SNAPSHOT_SCHEMA_VERSION = 1

/** 启动完整分析时唯一的模型分析模块；所有分析页字段一次提交。 */
export const AnalysisModuleIds = ['page_analysis'] as const
export type AnalysisModuleId = (typeof AnalysisModuleIds)[number]

export const MAX_AI_SUGGESTIONS = 3

/** 思维导图层数和总节点数均包含根节点。 */
export const MAX_MINDMAP_DEPTH = 5
export const MAX_MINDMAP_NODES = 200
export const MAX_MINDMAP_CHILDREN = 12
export const MAX_MINDMAP_LABEL_LENGTH = 160

/** 词云产物数量：目标 60 项，至少 50 项才会发布。 */
export const MIN_WORD_CLOUD_KEYWORDS = 50
export const MAX_WORD_CLOUD_KEYWORDS = 60

/** 单页决策洞察最多允许的独立重新生成次数 */
export const MAX_INSIGHT_REGENERATIONS = 3

export type AnalysisTrackedModuleId = AnalysisModuleId | 'report_insight'

export interface AnalysisPromptConfig {
  target: AnalysisTrackedModuleId
  systemPrompt: string
  instructionPrompt: string
  version: number
  updatedAt: string
  updatedBy: string
}

/** 全局统一系统提示词：对所有分析环节统一生效，不再按环节单独设置。 */
export interface AnalysisGlobalSystemPrompt {
  systemPrompt: string
  version: number
  updatedAt: string
  updatedBy: string
}
export type AnalysisModuleStatus = 'pending' | 'running' | 'gating' | 'retrying' | 'accepted' | 'failed'

export const ReportCompletenessDimensions = [
  { id: '研究目标', label: '研究目标' },
  { id: '方法与数据', label: '方法与数据' },
  { id: '证据覆盖', label: '证据覆盖' },
  { id: '分析结构', label: '分析结构' },
  { id: '结论覆盖', label: '结论覆盖' },
  { id: '风险与建议', label: '风险与建议' },
] as const

export const AiScoreDimensions = [
  { id: '研究价值', label: '研究价值' },
  { id: '方法严谨', label: '方法严谨' },
  { id: '证据质量', label: '证据质量' },
  { id: '逻辑一致', label: '逻辑一致' },
  { id: '结论强度', label: '结论强度' },
  { id: '可执行性', label: '可执行性' },
] as const

export const RESEARCH_METHODS = [
  { id: 'literature_review', label: '文献综述' },
  { id: 'qualitative_analysis', label: '定性分析' },
  { id: 'quantitative_modeling', label: '定量建模' },
  { id: 'case_study', label: '案例研究' },
  { id: 'fieldwork_interview', label: '实地调研' },
  { id: 'comparative_analysis', label: '对比分析' },
] as const

export type AiScoreDimensionId = (typeof AiScoreDimensions)[number]['id']
export type ReportCompletenessDimensionId = (typeof ReportCompletenessDimensions)[number]['id']
export type ResearchMethodLabel = (typeof RESEARCH_METHODS)[number]['label']

/** Worker 在本地提取且分析实际需要的最小报告事实。 */
export interface ReportFacts {
  title: string
  paragraphCount: number
  characterCount: number
}

/** 本次分析实际采用的课题与阶段评价基准。 */
export interface ReportEvaluationContext {
  projectId: string
  projectTitle: string
  researchObjective: string
  researchBackground: string
  milestone: {
    id: string
    title: string
    targetDate: string
    workAndExpectedOutcomes: string
  }
}

export interface GateError {
  code: string
  path: string
  message: string
  expected?: string
}

export interface AnalysisModuleState {
  moduleId: AnalysisTrackedModuleId
  status: AnalysisModuleStatus
  attempt: number
  maxAttempts: number
  artifactId?: string
  gateErrors: GateError[]
  updatedAt: string
}

export interface AnalysisArtifactRecord {
  id: string
  jobId: string
  reportVersionId: string
  moduleId: AnalysisTrackedModuleId
  schemaVersion: number
  promptVersion: string
  attempt: number
  status: Extract<AnalysisModuleStatus, 'accepted' | 'failed'>
  payload?: unknown
  gateErrors: GateError[]
  provider?: string
  model?: string
  createdAt: string
  acceptedAt?: string
}

export interface AiScoreDimension {
  id: string
  label: string
  score: number
}

export interface AiScore {
  overall: number
  previousOverall?: number
  summary: string
  dimensions: AiScoreDimension[]
}

export interface ReportDetailSection {
  id: string
  title: string
  summary: string
}

export interface ReportDetailArtifact {
  sections: ReportDetailSection[]
  completenessConclusion: string
}

export interface ReportCompletenessDimension {
  id: ReportCompletenessDimensionId
  label: ReportCompletenessDimensionId
  score: number
}

export interface ReportCompletenessArtifact {
  overall: number
  dimensions: ReportCompletenessDimension[]
  mainGap: string
}

export interface VisualizationMindMapNode {
  id: string
  label: string
  children: VisualizationMindMapNode[]
}

export interface VisualizationWordCloudItem {
  id: string
  label: string
  weight: number
}

export interface VisualizationHeatmapRow {
  id: string
  label: string
  /** 按 RESEARCH_METHODS 固定顺序排列的使用强度。 */
  values: number[]
}

export interface VisualizationArtifact {
  mindMap: VisualizationMindMapNode
  wordCloud: VisualizationWordCloudItem[]
  heatmap: {
    rows: VisualizationHeatmapRow[]
  }
}

export interface AiSuggestion {
  id: string
  detail: string
}

/** 模型一次提交的分析页 JSON；固定名称作为对象键，服务端再补充前端所需的 ID 与派生值。 */
export interface PageAnalysisArtifact {
  '综合评分': AiScoreTable
  '报告详情': {
    '章节': PageAnalysisSection[]
    '完整度结论': string
  }
  '报告完整度': ReportCompletenessTable
  '思维导图': PageAnalysisMindMapNode
  '词云': string[]
  '热力图': PageAnalysisHeatmapRow[]
  'AI建议': string[]
}

export type AiScoreTable = {
  [key in AiScoreDimensionId]: number
} & { '主要影响因素': string }

export type ReportCompletenessTable = {
  [key in ReportCompletenessDimensionId]: number
} & { '主要缺口': string }

export interface PageAnalysisSection {
  '标题': string
  '摘要': string
}

export interface PageAnalysisMindMapNode {
  '名称': string
  '子节点': PageAnalysisMindMapNode[]
}

export type PageAnalysisHeatmapRow = {
  '章节': string
} & { [key in ResearchMethodLabel]: number }

/** 只包含当前前端会渲染的数据；评价基准保存在任务快照中，不进入展示快照。 */
export interface AnalysisSnapshotPayload {
  schemaVersion: number
  reportDetails: ReportDetailArtifact
  reportCompleteness: ReportCompletenessArtifact
  aiScore: AiScore
  suggestions: AiSuggestion[]
  visualization: VisualizationArtifact
}

const scoreProperties = Object.fromEntries(
  AiScoreDimensions.map((dimension) => [dimension.id, Type.Integer({ minimum: 0, maximum: 100 })]),
) as Record<AiScoreDimensionId, ReturnType<typeof Type.Integer>>

const completenessProperties = Object.fromEntries(
  ReportCompletenessDimensions.map((dimension) => [dimension.id, Type.Integer({ minimum: 0, maximum: 100 })]),
) as Record<ReportCompletenessDimensionId, ReturnType<typeof Type.Integer>>

const methodProperties = Object.fromEntries(
  RESEARCH_METHODS.map((method) => [method.label, Type.Integer({ minimum: 0, maximum: 100 })]),
) as Record<ResearchMethodLabel, ReturnType<typeof Type.Integer>>

const PageAnalysisScoreSchema = Type.Object({
  ...scoreProperties,
  '主要影响因素': Type.String({ minLength: 1, maxLength: 50 }),
}, { additionalProperties: false })

const PageAnalysisCompletenessSchema = Type.Object({
  ...completenessProperties,
  '主要缺口': Type.String({ minLength: 1, maxLength: 50 }),
}, { additionalProperties: false })

const PageAnalysisSectionSchema = Type.Object({
  '标题': Type.String({ minLength: 1, maxLength: 160 }),
  '摘要': Type.String({ minLength: 1, maxLength: 50 }),
}, { additionalProperties: false })

function buildPageMindMapSchema(): TSchema {
  const label = Type.String({ minLength: 1, maxLength: MAX_MINDMAP_LABEL_LENGTH })
  let nodeSchema: TSchema = Type.Object({
    '名称': label,
    '子节点': Type.Array(Type.Object({}, { additionalProperties: false }), { maxItems: 0, description: '叶子节点必须输出空数组 []。' }),
  }, { additionalProperties: false })
  for (let depth = MAX_MINDMAP_DEPTH - 1; depth >= 1; depth -= 1) {
    nodeSchema = Type.Object({
      '名称': label,
      '子节点': Type.Array(nodeSchema, { minItems: depth === 1 ? 1 : 0, maxItems: MAX_MINDMAP_CHILDREN }),
    }, { additionalProperties: false })
  }
  return nodeSchema
}

const PageAnalysisMindMapNodeSchema = buildPageMindMapSchema()

const PageAnalysisHeatmapRowSchema = Type.Object({
  '章节': Type.String({ minLength: 1, maxLength: 160 }),
  ...methodProperties,
}, { additionalProperties: false })

export const AnalysisArtifactSchemas = {
  page_analysis: Type.Object({
    '综合评分': PageAnalysisScoreSchema,
    '报告详情': Type.Object({
      '章节': Type.Array(PageAnalysisSectionSchema, { minItems: 1, maxItems: 24 }),
      '完整度结论': Type.String({ minLength: 1, maxLength: 50 }),
    }, { additionalProperties: false }),
    '报告完整度': PageAnalysisCompletenessSchema,
    '思维导图': PageAnalysisMindMapNodeSchema,
    '词云': Type.Array(Type.String({ minLength: 2, maxLength: 12 }), { minItems: MIN_WORD_CLOUD_KEYWORDS, maxItems: MAX_WORD_CLOUD_KEYWORDS }),
    '热力图': Type.Array(PageAnalysisHeatmapRowSchema, { minItems: 1, maxItems: 12 }),
    'AI建议': Type.Array(Type.String({ minLength: 1, maxLength: 800 }), { minItems: 1, maxItems: MAX_AI_SUGGESTIONS }),
  }, { additionalProperties: false }),
} as const

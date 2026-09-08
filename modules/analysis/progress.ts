import type { AnalysisJob } from '@/modules/analysis/domain'
import type { AnalysisJobStatus, AnalysisModuleState, AnalysisModuleStatus, AnalysisStage, AnalysisTrackedModuleId } from '@/modules/contracts/analysis'

interface AnalysisProgressStep {
  stage: AnalysisStage
  moduleId?: AnalysisTrackedModuleId
  label: string
  shortLabel: string
}

const ANALYSIS_PROGRESS_STEPS: readonly AnalysisProgressStep[] = [
  { stage: 'validating', label: '准备报告', shortLabel: '准备' },
  { stage: 'page_analysis', moduleId: 'page_analysis', label: '生成分析页', shortLabel: '分析' },
  { stage: 'quality_gate', label: '校验分析结果', shortLabel: '校验' },
  { stage: 'completed', label: '发布分析结果', shortLabel: '发布' },
]

export type AnalysisProgressNodeState = 'pending' | 'active' | 'completed' | 'failed' | 'cancelled'

export interface AnalysisProgressView {
  title: string
  detail?: string
  activeStepIndex: number
  nodes: Array<AnalysisProgressStep & { state: AnalysisProgressNodeState }>
}

export type AnalysisResultDisplay = 'empty' | 'scanning' | 'ready' | 'updating' | 'stale' | 'failed' | 'cancelled'

const PUBLISHED_JOB_STATUSES = new Set<AnalysisJob['status']>(['completed'])
const GENERATING_MODULE_STATUSES = new Set<AnalysisModuleStatus>(['running', 'retrying'])

export function buildAnalysisProgress(input: { job?: AnalysisJob; moduleStates?: AnalysisModuleState[] }): AnalysisProgressView {
  const currentJob = input.job
  const moduleStates = new Map((input.moduleStates ?? []).map((state) => [state.moduleId, state]))
  const waiting = !currentJob || currentJob.status === 'queued'
  const pageAnalysis = moduleStates.get('page_analysis')
  const activeStepIndex = waiting ? -1 : resolveActiveStepIndex(currentJob, pageAnalysis?.status)
  const nodes = ANALYSIS_PROGRESS_STEPS.map((step, index) => ({ ...step, state: resolveNodeState(step.moduleId, index, activeStepIndex, currentJob, moduleStates) }))
  return {
    title: progressTitle(currentJob, pageAnalysis, activeStepIndex),
    detail: progressDetail(currentJob, pageAnalysis),
    activeStepIndex,
    nodes,
  }
}

export function resolveAnalysisResultDisplay(input: {
  analyzing: boolean
  hasData: boolean
  jobStatus?: AnalysisJobStatus
}): AnalysisResultDisplay {
  if (input.analyzing) return input.hasData ? 'updating' : 'scanning'
  if (input.hasData) return input.jobStatus === 'failed' || input.jobStatus === 'cancelled' ? 'stale' : 'ready'
  if (input.jobStatus === 'failed') return 'failed'
  if (input.jobStatus === 'cancelled') return 'cancelled'
  return 'empty'
}

export function analysisResultHint(display: AnalysisResultDisplay) {
  if (display === 'updating') return { label: '正在更新', tone: 'brand' as const }
  if (display === 'stale') return { label: '仍显示上一版', tone: 'warning' as const }
  return undefined
}

export function analysisResultPlaceholder(display: AnalysisResultDisplay) {
  if (display === 'failed') return '分析未完成，请重新启动。'
  if (display === 'cancelled') return '分析已停止，可重新启动。'
  if (display === 'scanning') return '正在生成分析结果。'
  return '暂无数据，请先启动AI分析。'
}

export function isAnalysisResultScanning(display: AnalysisResultDisplay) {
  return display === 'scanning'
}

export function isAnalysisResultVisible(display: AnalysisResultDisplay) {
  return display === 'ready' || display === 'updating' || display === 'stale'
}

function resolveActiveStepIndex(job: AnalysisJob, moduleStatus: AnalysisModuleStatus | undefined) {
  if (job.stage === 'validating') return 0
  if (job.stage === 'page_analysis') return moduleStatus === 'gating' ? 2 : 1
  if (job.stage === 'quality_gate' || job.stage === 'completed') return 3
  return 0
}

function resolveNodeState(moduleId: AnalysisTrackedModuleId | undefined, index: number, activeStepIndex: number, job: AnalysisJob | undefined, moduleStates: Map<AnalysisTrackedModuleId, AnalysisModuleState>): AnalysisProgressNodeState {
  const jobStatus = job?.status
  const moduleStatus = moduleId ? moduleStates.get(moduleId)?.status : undefined
  if (moduleStatus === 'accepted' || moduleStatus === 'gating') return 'completed'
  if (moduleStatus === 'failed') return 'failed'
  if (moduleStatus && GENERATING_MODULE_STATUSES.has(moduleStatus)) {
    if (jobStatus === 'failed') return 'failed'
    if (jobStatus === 'cancelled') return 'cancelled'
    return 'active'
  }
  if (jobStatus && PUBLISHED_JOB_STATUSES.has(jobStatus) && index === ANALYSIS_PROGRESS_STEPS.length - 1) return 'completed'
  if (index === activeStepIndex) {
    if (jobStatus === 'failed') return 'failed'
    if (jobStatus === 'cancelled') return 'cancelled'
    return 'active'
  }
  if (index >= 0 && index < activeStepIndex) return 'completed'
  return 'pending'
}

function progressTitle(job: AnalysisJob | undefined, module: AnalysisModuleState | undefined, activeStepIndex: number) {
  if (!job) return '正在同步分析进度'
  if (job.status === 'queued') return '正在准备开始分析'
  if (job.status === 'completed') return '分析结果已发布'
  if (job.status === 'failed') return '报告分析失败'
  if (job.status === 'cancelled') return '报告分析已取消'
  if (module?.status === 'retrying') return '正在重新生成分析页'
  const step = ANALYSIS_PROGRESS_STEPS[activeStepIndex]
  if (!step) return '正在分析报告'
  if (step.stage === 'validating') return '正在准备报告中'
  return '正在' + step.label
}

function progressDetail(job: AnalysisJob | undefined, module: AnalysisModuleState | undefined) {
  if (!job) return undefined
  if (job.status === 'queued') return '已进入队列，稍后自动开始'
  if (job.status === 'failed') {
    const message = job.errorMessage?.trim()
    return message || undefined
  }
  if (module?.status === 'retrying' || (module?.status === 'running' && module.attempt > 1)) {
    const attempt = Math.max(1, module.attempt)
    const maxAttempts = Math.max(module.maxAttempts, attempt)
    const attemptLabel = '第 ' + attempt + '/' + maxAttempts + ' 次'
    const error = module.gateErrors[0]?.message?.trim()
    return error ? attemptLabel + ' · ' + error : attemptLabel
  }
  if (module?.status === 'gating') return '正在核对分析页是否完整'
  if (job.stage === 'validating') return '正在检查文件并提取正文'
  return undefined
}

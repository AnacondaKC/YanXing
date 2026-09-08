import type { AnalysisJob } from '@/modules/analysis/domain'
import { ANALYSIS_SNAPSHOT_SCHEMA_VERSION, AnalysisStages, AnalysisModuleIds } from '@/modules/contracts/analysis'
import type { AnalysisJobEventType, AnalysisModuleState, AnalysisSnapshotPayload, AnalysisStage, AnalysisTrackedModuleId, GateError } from '@/modules/contracts/analysis'

export type JobProgressEvent = {
  id?: number
  jobId?: string
  type: AnalysisJobEventType
  stage?: AnalysisStage
  moduleId?: AnalysisTrackedModuleId
  attempt?: number
  maxAttempts?: number
  errors?: GateError[]
  createdAt?: string
}

export const EMPTY_SNAPSHOT: AnalysisSnapshotPayload = {
  schemaVersion: ANALYSIS_SNAPSHOT_SCHEMA_VERSION,
  reportDetails: { sections: [], completenessConclusion: '启动分析后生成报告详情。' },
  reportCompleteness: { overall: 0, dimensions: [], mainGap: '启动分析后评估报告完整度。' },
  aiScore: { overall: 0, summary: '启动分析后生成综合评分。', dimensions: [] },
  suggestions: [],
  visualization: { mindMap: { id: 'root', label: '待上传报告', children: [] }, wordCloud: [], heatmap: { rows: [] } },
}

export function snapshotHasDisplayableResults(payload?: AnalysisSnapshotPayload) {
  if (!payload) return false
  return payload.reportDetails.sections.length > 0
    || payload.suggestions.length > 0
    || payload.aiScore.dimensions.length > 0
    || payload.reportCompleteness.dimensions.length > 0
    || payload.visualization.mindMap.children.length > 0
    || payload.visualization.wordCloud.length > 0
    || payload.visualization.heatmap.rows.length > 0
}

export function preferDisplayedAnalysisPayload(current: AnalysisSnapshotPayload | undefined, incoming: AnalysisSnapshotPayload) {
  if (!current || snapshotHasDisplayableResults(incoming) || !snapshotHasDisplayableResults(current)) return incoming
  return current
}

export function selectDisplayedAnalysisSnapshot<T extends { payload: AnalysisSnapshotPayload }>(published: T | undefined, partial: T | undefined) {
  if (partial && snapshotHasDisplayableResults(partial.payload)) return partial
  return published ?? partial
}

export const activeAnalysisJobStatuses = new Set<AnalysisJob['status']>(['queued', 'running'])
export const terminalAnalysisJobStatuses = new Set<AnalysisJob['status']>(['completed', 'failed', 'cancelled'])

const moduleStatusForEvent: Partial<Record<AnalysisJobEventType, AnalysisModuleState['status']>> = { module_started: 'running', module_gating: 'gating', module_retrying: 'retrying', module_accepted: 'accepted', module_failed: 'failed' }
const defaultPageAnalysisMaxAttempts = 3
const terminalModuleStatuses = new Set<AnalysisModuleState['status']>(['accepted', 'failed'])

const analysisEventTypes = new Set<AnalysisJobEventType>(['stage', 'info', 'module_started', 'module_gating', 'module_retrying', 'module_accepted', 'module_failed', 'snapshot_updated', 'completed', 'failed', 'cancelled'])
const analysisStageSet = new Set<string>(AnalysisStages)
const trackedModuleSet = new Set<string>([...AnalysisModuleIds, 'report_insight'])

export function parseJobProgressPayload(data: string): JobProgressEvent | undefined {
  try {
    const payload = JSON.parse(data) as unknown
    if (!isRecord(payload) || typeof payload.type !== 'string' || !analysisEventTypes.has(payload.type as AnalysisJobEventType)) return undefined
    if (payload.id !== undefined && parseEventId(payload.id) === undefined) return undefined
    if (payload.jobId !== undefined && (typeof payload.jobId !== 'string' || payload.jobId.trim().length === 0)) return undefined
    if (payload.stage !== undefined && (typeof payload.stage !== 'string' || !analysisStageSet.has(payload.stage))) return undefined
    if (payload.moduleId !== undefined && (typeof payload.moduleId !== 'string' || !trackedModuleSet.has(payload.moduleId))) return undefined
    if (payload.attempt !== undefined && !isNonNegativeInteger(payload.attempt)) return undefined
    if (payload.maxAttempts !== undefined && !isPositiveInteger(payload.maxAttempts)) return undefined
    if (payload.attempt !== undefined && payload.maxAttempts !== undefined && (payload.attempt as number) > (payload.maxAttempts as number)) return undefined
    if (payload.errors !== undefined && !Array.isArray(payload.errors)) return undefined
    if (payload.createdAt !== undefined && typeof payload.createdAt !== 'string') return undefined
    const errors = Array.isArray(payload.errors) ? payload.errors.filter(isGateError) : undefined
    const id = parseEventId(payload.id)
    return {
      ...(id === undefined ? {} : { id }),
      ...(payload.jobId === undefined ? {} : { jobId: payload.jobId as string }),
      type: payload.type as AnalysisJobEventType,
      stage: payload.stage as AnalysisStage | undefined,
      moduleId: payload.moduleId as AnalysisTrackedModuleId | undefined,
      ...(payload.attempt === undefined ? {} : { attempt: payload.attempt as number }),
      ...(payload.maxAttempts === undefined ? {} : { maxAttempts: payload.maxAttempts as number }),
      errors,
      createdAt: payload.createdAt as string | undefined,
    }
  } catch { return undefined }
}

export function parseJobProgressEvent(event: { data: string; lastEventId?: string; id?: string | number }): JobProgressEvent | undefined {
  const parsed = parseJobProgressPayload(event.data)
  if (!parsed) return undefined
  const rawEventId = event.lastEventId !== undefined && event.lastEventId !== '' ? event.lastEventId : event.id
  const streamId = rawEventId === undefined || rawEventId === '' ? undefined : parseEventId(rawEventId)
  if (streamId === undefined && parsed.id === undefined) return undefined
  if (streamId !== undefined && parsed.id !== undefined && parsed.id !== streamId) return undefined
  return { ...parsed, id: streamId ?? parsed.id }
}

export function isJobProgressEventNewer(event: JobProgressEvent, lastEventId?: number) {
  if (event.id === undefined) return false
  return lastEventId === undefined || event.id > lastEventId
}

export function analysisJobEventsPath(jobId: string, afterEventId?: number) {
  const path = '/api/jobs/' + jobId + '/events'
  if (afterEventId === undefined || !Number.isSafeInteger(afterEventId) || afterEventId < 0) return path
  return path + '?after=' + afterEventId
}

const terminalStatusByEvent = { completed: 'completed', failed: 'failed', cancelled: 'cancelled' } as const satisfies Partial<Record<AnalysisJobEventType, AnalysisJob['status']>>

export function applyJobProgressEventToJob(current: AnalysisJob | undefined, event: JobProgressEvent): AnalysisJob | undefined {
  if (!current || !isValidJobProgressEvent(event)) return current
  const terminalStatus = terminalStatusByEvent[event.type as keyof typeof terminalStatusByEvent]
  const moduleStatus = moduleStatusForEvent[event.type]
  if (event.jobId !== undefined && event.jobId !== current.id) return current
  if (terminalAnalysisJobStatuses.has(current.status)) return current
  const hasProgressUpdate = Boolean(terminalStatus || event.stage || moduleStatus || event.type === 'info' || event.type === 'snapshot_updated')
  if (!hasProgressUpdate) return current
  const stage = event.stage ?? current.stage
  if (!analysisStageSet.has(stage)) return current
  const promotesQueuedJob = Boolean(event.stage || moduleStatus)
  const status = terminalStatus ?? (promotesQueuedJob && current.status === 'queued' ? 'running' : current.status)
  const updatedAt = laterTimestamp(current.updatedAt, event.createdAt)
  return { ...current, status, stage, stageIndex: AnalysisStages.indexOf(stage), updatedAt }
}

export function applyJobProgressEventToModuleStates(current: AnalysisModuleState[], event: JobProgressEvent): AnalysisModuleState[] {
  const safeCurrent = current.filter((state) => state.moduleId === 'page_analysis')
  if (!isValidJobProgressEvent(event)) return safeCurrent
  const moduleId = event.moduleId
  const moduleStatus = moduleStatusForEvent[event.type]
  if (moduleId !== 'page_analysis' || !moduleStatus) return safeCurrent
  const index = safeCurrent.findIndex((state) => state.moduleId === moduleId)
  const previous = index >= 0 ? safeCurrent[index] : undefined
  if (previous && terminalModuleStatuses.has(previous.status)) return safeCurrent
  const attempt = nextModuleAttempt(moduleStatus, previous, event)
  const maxAttempts = Math.max(defaultPageAnalysisMaxAttempts, previous?.maxAttempts ?? 1, event.maxAttempts ?? 1, attempt)
  const resetErrors = moduleStatus === 'running' || moduleStatus === 'gating' || moduleStatus === 'accepted'
  const updatedAt = previous ? laterTimestamp(previous.updatedAt, event.createdAt) : event.createdAt ?? new Date().toISOString()
  const next: AnalysisModuleState = { moduleId, status: moduleStatus, attempt, maxAttempts, artifactId: previous?.artifactId, gateErrors: event.errors ?? (resetErrors ? [] : previous?.gateErrors ?? []), updatedAt }
  if (index < 0) return [...safeCurrent, next]
  const nextStates = [...safeCurrent]; nextStates[index] = next; return nextStates
}

function nextModuleAttempt(moduleStatus: AnalysisModuleState['status'], previous: AnalysisModuleState | undefined, event: JobProgressEvent) {
  if (event.attempt !== undefined) return event.attempt
  const previousAttempt = Math.max(0, previous?.attempt ?? 0)
  if (moduleStatus !== 'retrying') return Math.max(1, previousAttempt)
  if (previous?.status === 'retrying') return Math.max(2, previousAttempt)
  return Math.max(2, previousAttempt + 1)
}

export function shouldRefreshModuleProgressFromEvent(event: JobProgressEvent, previous: AnalysisModuleState | undefined) {
  return event.type === 'module_retrying' && event.attempt === undefined && previous?.status === 'retrying'
}

function isValidJobProgressEvent(event: JobProgressEvent): boolean {
  return analysisEventTypes.has(event.type)
    && (event.id === undefined || isNonNegativeInteger(event.id))
    && (event.jobId === undefined || (typeof event.jobId === 'string' && event.jobId.trim().length > 0))
    && (event.stage === undefined || analysisStageSet.has(event.stage))
    && (event.moduleId === undefined || trackedModuleSet.has(event.moduleId))
    && (event.attempt === undefined || isNonNegativeInteger(event.attempt))
    && (event.maxAttempts === undefined || isPositiveInteger(event.maxAttempts))
    && (event.attempt === undefined || event.maxAttempts === undefined || event.attempt <= event.maxAttempts)
    && (event.errors === undefined || event.errors.every(isGateError))
    && (event.createdAt === undefined || typeof event.createdAt === 'string')
}

function parseEventId(value: unknown): number | undefined {
  if (typeof value === 'number') return isNonNegativeInteger(value) ? value : undefined
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return isNonNegativeInteger(parsed) ? parsed : undefined
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0
}

function laterTimestamp(current: string, candidate: string | undefined) {
  return candidate && candidate > current ? candidate : current
}

function isGateError(value: unknown): value is GateError {
  if (!isRecord(value)) return false
  return typeof value.code === 'string' && typeof value.path === 'string' && typeof value.message === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
import type { AnalysisJob } from '@/modules/analysis/domain'
import { ANALYSIS_SNAPSHOT_SCHEMA_VERSION, type AnalysisSnapshotPayload } from '@/modules/contracts/analysis'

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

export const activeAnalysisJobStatuses = new Set<AnalysisJob['status']>(['queued', 'running'])

export function analysisJobEventsPath(jobId: string, afterEventId?: number) {
  const path = '/api/jobs/' + jobId + '/events'
  if (afterEventId === undefined || !Number.isSafeInteger(afterEventId) || afterEventId < 0) return path
  return path + '?after=' + afterEventId
}

import {
  RESEARCH_METHODS,
  type AnalysisSnapshotPayload,
  type VisualizationMindMapNode,
  type VisualizationWordCloudItem,
} from '@/modules/contracts/analysis'

export type WordCloudItem = VisualizationWordCloudItem

export interface HeatmapCell {
  columnId: string
  value: number
  ratio: number
}

export interface HeatmapRow {
  id: string
  label: string
  cells: HeatmapCell[]
}

export interface HeatmapData {
  columns: Array<{ id: string; label: string }>
  rows: HeatmapRow[]
}

export interface VisualizationData {
  mindMap: VisualizationMindMapNode
  wordCloud: WordCloudItem[]
  heatmap: HeatmapData
}

export function getVisualizationData(snapshot: AnalysisSnapshotPayload): VisualizationData {
  return {
    mindMap: snapshot.visualization.mindMap,
    wordCloud: snapshot.visualization.wordCloud,
    heatmap: {
      columns: [...RESEARCH_METHODS],
      rows: snapshot.visualization.heatmap.rows.map((row) => ({
        id: row.id,
        label: row.label,
        cells: row.values.map((value, index) => ({
          columnId: RESEARCH_METHODS[index]?.id ?? String(index),
          value,
          ratio: Math.max(0, Math.min(1, value / 100)),
        })),
      })),
    },
  }
}

import type { AnalysisJobStatus } from '@/modules/contracts/analysis'

export type ReportParseStatus = 'uploaded' | 'ready' | 'failed'

export type ReportDeliveryType = 'stage' | 'final'

export interface ReportVersion {
  id: string
  projectId: string
  milestoneId?: string
  deliveryType?: ReportDeliveryType
  version: number
  title: string
  fileName: string
  fileHash: string
  paragraphCount: number
  characterCount: number
  previousCharacterCount?: number
  parseStatus: ReportParseStatus
  latestJobStatus?: AnalysisJobStatus
  currentAnalysisId?: string
  hasCompletedFullAnalysis?: boolean
  createdAt: string
  sourceUpdatedAt: string
  previousVersionId?: string
  parseError?: string
}

export interface ReportHistoryEntry {
  report: ReportVersion
  aiScore?: number
  completeness?: number
}

export interface ReportSource {
  path: string
  fileName: string
  mimeType: string
  size: number
  sha256: string
}

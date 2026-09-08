import type { ReportVersion } from '@/modules/reports/domain'

export type KnowledgeItem = {
  id: string
  title: string
  fileName: string
  fileSize: number
  category: string
  description: string
  tags: string[]
  uploadedBy: string
  canDelete: boolean
  createdAt: string
  updatedAt: string
}

export type ReportWithProject = ReportVersion & {
  projectTitle: string
  projectOwnerName: string
  aiScore?: number
  completeness?: number
  sectionCount?: number
}

export type OverviewStats = {
  totalReportVersions: number
  totalCharacters: number
  knowledgeCount: number
  knowledgeCategoryCount: number
  weeklyNewReports: number
  weeklyNewKnowledge: number
  jobStats: { completed: number; failed: number; cancelled: number; running: number; queued: number }
  trends: {
    versions: number[]
    characters: number[]
    successRate: number[]
    knowledge: number[]
    averageScore: number[]
    analyzedProjects: number[]
  }
}

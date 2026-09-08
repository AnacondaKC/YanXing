export type ProjectProgressStatus = 'not_started' | 'in_progress' | 'at_risk' | 'completed'
export type ProjectStage = '开题中' | '调研中' | '推进中' | '已完成'
export type ProjectMemberRole = 'owner' | 'editor'

export interface Milestone {
  id: string
  title: string
  targetDate?: string
  description?: string
  status: ProjectProgressStatus
  reportIds?: string[]
}

export interface Project {
  id: string
  ownerId: string
  title: string
  objective: string
  description: string
  ownerName: string
  collaboratorNames?: string
  status: ProjectProgressStatus
  stage?: ProjectStage
  milestones: Milestone[]
  isExample?: boolean
  createdAt: string
  updatedAt: string
}

export interface ProjectReportSummary {
  version: number
  aiScore?: number
  completeness?: number
  characterCount?: number
}

/** 仅用于当前用户读取课题列表时的操作能力和最新版报告摘要，不写入 projects 表。 */
export interface ProjectWithCapabilities extends Project {
  /** 未加入课题的研究员可以查看所有课题，此时没有成员角色。 */
  memberRole?: ProjectMemberRole
  canManage: boolean
  canDelete: boolean
  latestReport?: ProjectReportSummary
}

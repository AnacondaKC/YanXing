export const notificationActions = {
  projectCreated: 'project_created',
  projectUpdated: 'project_updated',
  projectDeleted: 'project_deleted',
  reportUploaded: 'report_uploaded',
  reportAssigned: 'report_assigned',
  reportReplaced: 'report_replaced',
  reportDeleted: 'report_deleted',
  analysisStarted: 'analysis_started',
  analysisCancelled: 'analysis_cancelled',
  insightStarted: 'insight_started',
} as const

export type NotificationAction = typeof notificationActions[keyof typeof notificationActions]

export interface NotificationItem {
  id: string
  action: NotificationAction
  summary: string
  detail?: string
  actorName?: string
  projectId?: string
  projectTitle?: string
  reportId?: string
  reportTitle?: string
  createdAt: string
  read: boolean
}

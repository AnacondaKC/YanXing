'use client'

import type { ReactNode } from 'react'
import { ProjectExecutiveHeader } from '@/components/project-executive-header'
import type { WorkspaceProjectDetail } from '@/lib/workspace-submission'

export function WorkspaceProjectHeader({ detail, children }: {
  detail: WorkspaceProjectDetail
  children?: ReactNode
}) {
  const current = detail.stages.find(group => group.stage.id === detail.workflow.currentStageId)
  const stagePositionLabel = detail.workflow.completedAt ? '课题已完成' : current ? '阶段 ' + current.stage.ordinal + '/' + detail.stages.length : '暂无阶段'
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ProjectExecutiveHeader project={detail.project} stagePositionLabel={stagePositionLabel} />
      {children}
    </div>
  )
}


'use client'

import { useEffect, useState } from 'react'
import { useWorkspaceEntrance } from '@/components/use-workspace-entrance'
import type { ReportLoadState } from '@/lib/report-load-state'
import { ProjectFirstReportOnboarding } from '@/components/project-first-report-onboarding'
import { ReportOverviewCard, ResearchWorkbench } from '@/components/research-workbench'
import { AiScoreCard, AiSuggestionsCard, ReportCompletenessCard } from '@/components/insight-cards'
import {
  ResearchVisualizationCard,
  type VisualizationView,
} from '@/components/research-visualization-card'
import { applyFullscreenScrollLock } from '@/lib/workspace-scroll'
import type { AnalysisJob } from '@/modules/analysis/domain'
import type { AnalysisModuleState, AnalysisSnapshotPayload } from '@/modules/contracts/analysis'
import type { ProjectWithCapabilities } from '@/modules/projects/domain'
import type { ReportVersion } from '@/modules/reports/domain'

const REPORT_STAGE_LABELS = ['阶段一', '阶段二', '阶段三', '阶段四', '阶段五', '阶段六', '阶段七', '阶段八', '阶段九', '阶段十', '阶段十一', '阶段十二'] as const

export function DashboardView({
  project,
  report,
  reportState = 'ready',
  onRetryReportLoad,
  snapshot,
  analyzing,
  cancelling,
  job,
  moduleStates,
  canManage,
  viewingHistoricalReport,
  viewGeneration,
  onReturnToLatestReport,
  onReportUploaded,
  onProjectUpdated,
  onCancelAnalysis,
  onOpenProgress,
  onEditProject,
  onStartAnalysis,
}: {
  project?: ProjectWithCapabilities
  report?: ReportVersion
  reportState?: ReportLoadState
  onRetryReportLoad?: () => void
  snapshot: AnalysisSnapshotPayload
  analyzing: boolean
  cancelling: boolean
  job?: AnalysisJob
  moduleStates: AnalysisModuleState[]
  canManage: boolean
  viewingHistoricalReport?: boolean
  viewGeneration: number
  onReturnToLatestReport?: () => void
  onReportUploaded?: (report: ReportVersion, submitted: { projectId: string; viewGeneration: number }) => void
  onProjectUpdated?: (project: ProjectWithCapabilities) => void
  onCancelAnalysis: () => Promise<void>
  onOpenProgress?: (milestoneId?: string) => void
  onEditProject?: () => void
  onStartAnalysis?: (reportId?: string) => void
}) {
  const [activeVisualization, setActiveVisualization] = useState<VisualizationView>('mindmap')
  const [visualizationExpanded, setVisualizationExpanded] = useState(false)
  const jobStatus = job?.status
  const { entranceProps } = useWorkspaceEntrance(reportState === 'loading')

  useEffect(() => {
    if (!visualizationExpanded) return
    return applyFullscreenScrollLock(
      document.querySelector<HTMLElement>('section[aria-label="主工作区"]'),
      document.documentElement,
      document.body,
    )
  }, [visualizationExpanded])

  if (!report && reportState !== 'ready') {
    return (
      <div {...entranceProps} aria-busy={reportState === 'loading'} className="yx-detail flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-64 flex-1 flex-col items-center justify-center gap-4 rounded-lg border border-yx-line bg-yx-paper p-6 text-center">
          <p role="status" className="text-xs leading-6 text-yx-muted">
            {reportState === 'loading' ? '正在读取课题报告…' : '课题报告读取失败，请重试。'}
          </p>
          {reportState === 'error' && onRetryReportLoad && (
            <button type="button" onClick={onRetryReportLoad} className="rounded-md bg-yx-brand px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-yx-brand-hover">重新加载报告</button>
          )}
        </div>
      </div>
    )
  }

  if (!report) {
    return (
      <div {...entranceProps} className="yx-detail flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="yx-detail-fade flex min-h-0 flex-1 flex-col">
          <ProjectFirstReportOnboarding
            key={project?.id}
            project={project}
            canManage={canManage}
            analyzing={analyzing}
            viewGeneration={viewGeneration}
            onReportUploaded={onReportUploaded}
            onProjectUpdated={onProjectUpdated}
          />
        </div>
      </div>
    )
  }

  const reportMilestone = project?.milestones.find((milestone) => milestone.id === report.milestoneId)
  const reportStageIndex = project?.milestones.findIndex((milestone) => milestone.id === report.milestoneId) ?? -1
  const reportStageLabel = reportStageIndex >= 0 ? REPORT_STAGE_LABELS[reportStageIndex] : '未分配'

  return (
    <div {...entranceProps} className="yx-detail flex min-h-0 min-w-0 flex-col gap-3 sm:gap-4 lg:min-h-0 lg:flex-1">
      <div className="yx-dashboard-grid grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-3 sm:gap-4 xl:grid-cols-[minmax(0,1fr)_350px]">
        <div className="order-1 min-h-0 min-w-0 grid grid-cols-1 gap-3 sm:gap-4 xl:order-none xl:col-start-1 xl:col-span-1 xl:row-start-1 xl:grid-cols-2 xl:items-stretch xl:gap-4 xl:h-full">
          <AiScoreCard
            score={snapshot.aiScore}
            analyzing={analyzing}
            jobStatus={jobStatus}
            className="yx-detail-card xl:h-[289px] xl:min-h-0 xl:overflow-hidden xl:!py-[20px] xl:!px-[25px]"
          />
          <ReportOverviewCard report={report} stageLabel={reportStageLabel} snapshot={snapshot} analyzing={analyzing} jobStatus={jobStatus} className="yx-detail-card xl:h-[289px] xl:min-h-0 xl:overflow-hidden xl:!py-[20px] xl:!px-[25px]" />
        </div>
        <div className="order-3 min-h-0 min-w-0 flex flex-col gap-3 xl:order-none xl:col-start-2 xl:col-span-1 xl:row-start-1 xl:row-span-2 xl:w-[350px] xl:self-start xl:grid xl:grid-cols-1 xl:grid-rows-[subgrid] xl:gap-4 xl:h-full">
          <div className="flex min-w-0 flex-col gap-3 xl:row-start-1 xl:h-full xl:min-h-0 xl:gap-[5px] xl:w-[350px]">
            <ResearchWorkbench className="yx-detail-intro xl:shrink-0" analyzing={analyzing} cancelling={cancelling} job={job} moduleStates={moduleStates} canManage={canManage} report={report} viewingHistoricalReport={viewingHistoricalReport} historicalStageName={reportMilestone?.title} onReturnToLatestReport={onReturnToLatestReport} onCancelAnalysis={onCancelAnalysis} onOpenProgress={onOpenProgress} onEditProject={onEditProject} onStartAnalysis={onStartAnalysis} />
            <ReportCompletenessCard snapshot={snapshot} analyzing={analyzing} jobStatus={jobStatus} className="yx-detail-secondary w-full self-stretch overflow-hidden xl:h-[168px] xl:flex-none xl:!pt-[10px] xl:!pb-[20px]" />
          </div>
          <div className="min-h-0 min-w-0 xl:row-start-2 xl:self-stretch xl:w-[350px]">
            <AiSuggestionsCard snapshot={snapshot} analyzing={analyzing} jobStatus={jobStatus} className="yx-detail-secondary xl:h-full xl:min-h-0 xl:!pt-[20px] xl:!pb-[20px]" />
          </div>
        </div>
        <ResearchVisualizationCard
          snapshot={snapshot}
          analyzing={analyzing}
          jobStatus={jobStatus}
          className="yx-detail-fade order-5 xl:order-none xl:col-start-1 xl:col-span-1 xl:row-start-2 xl:h-full"
          activeView={activeVisualization}
          isExpanded={visualizationExpanded}
          onViewChange={setActiveVisualization}
          onToggleFullscreen={() => setVisualizationExpanded((expanded) => !expanded)}
        />
      </div>
    </div>
  )
}

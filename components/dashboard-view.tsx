'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { AnalysisEmptyPreview, WorkspaceEmptyPanel } from '@/components/workspace-empty-panel'
import { useWorkspaceEntrance } from '@/components/use-workspace-entrance'
import { ReportOverviewCard, ResearchWorkbench } from '@/components/research-workbench'
import { AiScoreCard, AiSuggestionsCard, ReportCompletenessCard } from '@/components/insight-cards'
import {
  ResearchVisualizationCard,
  type VisualizationView,
} from '@/components/research-visualization-card'
import { applyFullscreenScrollLock } from '@/lib/workspace-scroll'
import { EMPTY_SNAPSHOT, snapshotHasDisplayableResults } from '@/lib/analysis-job-progress'
import {
  analysisActionLabel,
  characterDeltaFromComparison,
  comparisonIsHidden,
  hasCompletedFullAnalysis,
  isTaskInFlight,
  presentAiScore,
  type WorkspaceReportCard,
} from '@/lib/workspace-submission'
import type { AnalysisSnapshotPayload } from '@/modules/contracts/analysis'
import type { SubmissionTask } from '@/modules/reports/submission-task-domain'

export type DashboardViewProps = {
  report?: WorkspaceReportCard
  snapshot?: AnalysisSnapshotPayload
  analysisTask?: SubmissionTask
  canManage: boolean
  viewingHistorical?: boolean
  cancellingAnalysis?: boolean
  onStartAnalysis?: () => void
  onCancelAnalysis: () => Promise<void>
  onReturnToLatest?: () => void
  onEditProject?: () => void
  onUpdateReport?: () => void
  emptyState?: ReactNode
}

export function DashboardView({
  report,
  snapshot,
  analysisTask,
  canManage,
  viewingHistorical,
  cancellingAnalysis,
  onStartAnalysis,
  onCancelAnalysis,
  onReturnToLatest,
  onEditProject,
  onUpdateReport,
  emptyState,
}: DashboardViewProps) {
  const [activeVisualization, setActiveVisualization] = useState<VisualizationView>('mindmap')
  const [visualizationExpanded, setVisualizationExpanded] = useState(false)
  const analyzing = isTaskInFlight(analysisTask)
  const displaySnapshot = snapshot && snapshotHasDisplayableResults(snapshot) ? snapshot : EMPTY_SNAPSHOT
  const jobStatus = analysisTask?.status
  const progressJob = analysisTask
    ? { status: analysisTask.status, stage: analysisTask.stage, stageIndex: analysisTask.stageIndex, errorMessage: analysisTask.errorCode }
    : undefined
  const { entering, entranceProps } = useWorkspaceEntrance()

  useEffect(() => {
    if (!visualizationExpanded) return
    return applyFullscreenScrollLock(
      document.querySelector<HTMLElement>('section[aria-label="主工作区"]'),
      document.documentElement,
      document.body,
    )
  }, [visualizationExpanded])

  if (!report) {
    return (
      <div {...entranceProps} className="yx-detail flex min-h-0 min-w-0 flex-1 flex-col">
        {emptyState ?? (
          <WorkspaceEmptyPanel
            label="分析工作台空状态"
            title="当前阶段还没有报告"
            description="提交更新或完结报告后，将在这里展示分析。"
            preview={<AnalysisEmptyPreview />}
          />
        )}
      </div>
    )
  }

  const previousCharacterCount = previousCharacterCountFrom(report)
  const presentedScore = presentAiScore(displaySnapshot.aiScore, report.comparison)

  return (
    <div {...entranceProps} className={`@container/report-board yx-detail flex min-h-0 min-w-0 flex-1 flex-col gap-3 sm:gap-4 lg:min-h-0 ${entering ? 'overflow-y-hidden' : 'overflow-y-auto'}`}>
      <div className="grid min-w-0 flex-none grid-cols-1 gap-3 sm:gap-4 @[1000px]/report-board:min-h-0 @[1000px]/report-board:flex-1 @[1000px]/report-board:grid-cols-[minmax(0,1fr)_350px] @[1000px]/report-board:grid-rows-[289px_minmax(25.375rem,1fr)]">
        <div className="order-1 grid min-w-0 grid-cols-1 gap-3 sm:gap-4 @[640px]/report-board:grid-cols-[repeat(2,minmax(280px,1fr))] @[1000px]/report-board:order-none @[1000px]/report-board:col-span-1 @[1000px]/report-board:col-start-1 @[1000px]/report-board:row-start-1 @[1000px]/report-board:h-full @[1000px]/report-board:min-h-0 @[1000px]/report-board:items-stretch @[1000px]/report-board:gap-4">
          <AiScoreCard
            score={presentedScore.score}
            scoreDelta={presentedScore.scoreDelta}
            analyzing={analyzing}
            jobStatus={jobStatus}
            className="yx-detail-card @[1000px]/report-board:h-[289px] @[1000px]/report-board:min-h-0 @[1000px]/report-board:overflow-hidden @[1000px]/report-board:!px-[25px] @[1000px]/report-board:!py-[20px]"
          />
          <ReportOverviewCard
            report={{ paragraphCount: report.paragraphCount, characterCount: report.characterCount, previousCharacterCount }}
            stageLabel={report.labels.stageLabel}
            snapshot={displaySnapshot}
            analyzing={analyzing}
            jobStatus={jobStatus}
            className="yx-detail-card @[1000px]/report-board:h-[289px] @[1000px]/report-board:min-h-0 @[1000px]/report-board:overflow-hidden @[1000px]/report-board:!px-[25px] @[1000px]/report-board:!py-[20px]"
          />
        </div>
        <div className="order-3 flex min-w-0 flex-col gap-3 @[1000px]/report-board:order-none @[1000px]/report-board:col-span-1 @[1000px]/report-board:col-start-2 @[1000px]/report-board:row-span-2 @[1000px]/report-board:row-start-1 @[1000px]/report-board:grid @[1000px]/report-board:h-full @[1000px]/report-board:min-h-0 @[1000px]/report-board:w-[350px] @[1000px]/report-board:grid-cols-1 @[1000px]/report-board:grid-rows-[subgrid] @[1000px]/report-board:gap-4 @[1000px]/report-board:self-start">
          <div className="flex min-w-0 flex-col gap-3 @[1000px]/report-board:row-start-1 @[1000px]/report-board:h-full @[1000px]/report-board:min-h-0 @[1000px]/report-board:w-[350px] @[1000px]/report-board:gap-[5px]">
            <ResearchWorkbench
              className="yx-detail-intro @[1000px]/report-board:shrink-0"
              analyzing={analyzing}
              cancelling={Boolean(cancellingAnalysis)}
              job={progressJob}
              canManage={canManage}
              report={{ id: report.id, hasCompletedFullAnalysis: hasCompletedFullAnalysis(report) }}
              viewingHistoricalReport={viewingHistorical}
              historicalStageName={report.labels.stageLabel}
              onReturnToLatestReport={onReturnToLatest}
              onCancelAnalysis={onCancelAnalysis}
              onEditProject={onEditProject}
              onUpdateReport={onUpdateReport}
              onStartAnalysis={analysisActionLabel(report.capabilities.analysisAction) ? () => onStartAnalysis?.() : undefined}
            />
            <ReportCompletenessCard snapshot={displaySnapshot} analyzing={analyzing} jobStatus={jobStatus} className="yx-detail-secondary w-full self-stretch overflow-hidden @[1000px]/report-board:h-[168px] @[1000px]/report-board:flex-none @[1000px]/report-board:!pt-[10px] @[1000px]/report-board:!pb-[20px]" />
          </div>
          <div className="min-h-0 min-w-0 @[1000px]/report-board:row-start-2 @[1000px]/report-board:w-[350px] @[1000px]/report-board:self-stretch">
            <AiSuggestionsCard snapshot={displaySnapshot} analyzing={analyzing} jobStatus={jobStatus} className="yx-detail-secondary @[1000px]/report-board:h-full @[1000px]/report-board:min-h-0 @[1000px]/report-board:!pt-[20px] @[1000px]/report-board:!pb-[20px]" />
          </div>
        </div>
        <ResearchVisualizationCard
          snapshot={displaySnapshot}
          analyzing={analyzing}
          jobStatus={jobStatus}
          className="yx-detail-fade order-5 @[1000px]/report-board:order-none @[1000px]/report-board:col-span-1 @[1000px]/report-board:col-start-1 @[1000px]/report-board:row-start-2 @[1000px]/report-board:h-full"
          activeView={activeVisualization}
          isExpanded={visualizationExpanded}
          onViewChange={setActiveVisualization}
          onToggleFullscreen={() => setVisualizationExpanded((expanded) => !expanded)}
        />
      </div>
    </div>
  )
}

function previousCharacterCountFrom(report: WorkspaceReportCard) {
  if (comparisonIsHidden(report.comparison)) return undefined
  const delta = characterDeltaFromComparison(report.comparison)
  return delta === undefined ? undefined : report.characterCount - delta
}

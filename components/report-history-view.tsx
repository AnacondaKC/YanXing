'use client'

import {
  Clock3,
  Milestone as MilestoneIcon,
  ArrowRight,
  Trash2,
  Replace,
  Upload,
} from 'lucide-react'
import { type ReactNode } from 'react'
import { EmptyPanelDecoration } from '@/components/ui/card-decoration'
import { useWorkspaceEntrance } from '@/components/use-workspace-entrance'
import { EmptyPanelAction, HistoryEmptyPreview, WorkspaceEmptyPanel, workspacePanelChromeClassName } from '@/components/workspace-empty-panel'
import { formatReportDate, formatReportTime, scoreTextClass } from '@/lib/format'
import {
  characterDeltaFromComparison,
  comparisonIsHidden,
  hasCompletedFullAnalysis,
  reportDeleteBlocked,
  SKIPPED_EMPTY_COPY,
  type WorkspaceReportCard,
  type WorkspaceStageGroup,
} from '@/lib/workspace-submission'
import type { ProjectStageRecord } from '@/modules/projects/stage-domain'

export type ReportHistoryViewProps = {
  groups: WorkspaceStageGroup[]
  selectedReportId?: string
  latestSubmissionId?: string
  onOpenReport: (report: WorkspaceReportCard) => void
  onDeleteReport?: (report: WorkspaceReportCard) => void
  onReplaceReport?: (report: WorkspaceReportCard) => void
  onUpload?: () => void
}

export function ReportHistoryView({
  groups,
  selectedReportId,
  latestSubmissionId,
  onOpenReport,
  onDeleteReport,
  onReplaceReport,
  onUpload,
}: ReportHistoryViewProps) {
  const { entranceProps } = useWorkspaceEntrance(false)
  const reportCount = groups.reduce((total, group) => total + group.reports.length, 0)
  const isEmpty = reportCount === 0 && !groups.some((group) => group.skippedEmpty)

  if (isEmpty) {
    return (
      <div {...entranceProps} className="yx-detail flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspaceEmptyPanel
          label="报告版本历史"
          title="暂无报告"
          description="提交报告后，报告记录将显示在这里。"
          action={onUpload ? (
            <EmptyPanelAction onClick={onUpload}>
              <Upload aria-hidden="true" className="h-4 w-4" />
              <span>前往上传报告</span>
              <ArrowRight aria-hidden="true" className="ml-2 h-4 w-4" />
            </EmptyPanelAction>
          ) : undefined}
          preview={<HistoryEmptyPreview />}
        />
      </div>
    )
  }

  return (
    <div {...entranceProps} className="yx-detail flex min-h-0 min-w-0 flex-1 flex-col">
      <section aria-label="报告版本历史" className={workspacePanelChromeClassName + ' overflow-hidden'}>
        <EmptyPanelDecoration />
        <div className="relative z-10 flex min-h-0 flex-1 flex-col">
          <div className="yx-detail-intro shrink-0 border-b border-yx-line px-5 py-5 sm:px-7">
            <ProjectProgressSummary groups={groups} />
          </div>
          <div className="yx-detail-content min-h-0 flex-1 overflow-y-auto px-2 py-2 sm:px-3 sm:py-3">
            <div className="@container/history divide-y divide-yx-line/70">
              {groups.map((group) => (
                <StageHistoryGroup
                  key={group.stage.id}
                  group={group}
                  selectedReportId={selectedReportId}
                  latestSubmissionId={latestSubmissionId}
                  onOpenReport={onOpenReport}
                  onDeleteReport={onDeleteReport}
                  onReplaceReport={onReplaceReport}
                />
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

function StageHistoryGroup({
  group,
  selectedReportId,
  latestSubmissionId,
  onOpenReport,
  onDeleteReport,
  onReplaceReport,
}: {
  group: WorkspaceStageGroup
  selectedReportId?: string
  latestSubmissionId?: string
  onOpenReport: (report: WorkspaceReportCard) => void
  onDeleteReport?: (report: WorkspaceReportCard) => void
  onReplaceReport?: (report: WorkspaceReportCard) => void
}) {
  if (group.skippedEmpty && group.reports.length === 0) {
    return (
      <article className="px-3 py-4 sm:px-4">
        <h3 className="text-xs font-semibold text-yx-ink">{group.stageLabel}</h3>
        <p className="mt-1.5 text-[10px] text-yx-muted">{SKIPPED_EMPTY_COPY}</p>
      </article>
    )
  }
  if (group.reports.length === 0) return null
  return (
    <>
      {group.reports.map((report) => {
        const canDelete = Boolean(onDeleteReport) && !reportDeleteBlocked({ canDelete: report.capabilities.canDelete })
        const canReplace = report.isCurrentCompletion && group.currentCompletionReportId === report.id
          && group.canSubmitCompletion && report.capabilities.canSubmitCompletion
        return (
          <HistoryRow
            key={report.id}
            report={report}
            stage={group.stage}
            active={report.id === selectedReportId}
            latest={report.id === latestSubmissionId}
            canDelete={canDelete}
            onOpen={() => onOpenReport(report)}
            onDelete={canDelete && onDeleteReport ? () => onDeleteReport(report) : undefined}
            onReplace={canReplace && onReplaceReport ? () => onReplaceReport(report) : undefined}
          />
        )
      })}
    </>
  )
}

function ProjectProgressSummary({ groups }: { groups: WorkspaceStageGroup[] }) {
  const stages = groups.map((group) => group.stage)
  const completedCount = stages.filter((stage) => stage.lifecycleStatus === 'completed').length
  const allCompleted = stages.length > 0 && completedCount === stages.length
  const activeIndex = stages.findIndex((stage) => stage.lifecycleStatus === 'in_progress')
  const nextIndex = stages.findIndex((stage) => stage.lifecycleStatus !== 'completed')
  const currentIndex = allCompleted ? stages.length - 1 : activeIndex >= 0 ? activeIndex : nextIndex
  const currentStage = currentIndex >= 0 ? stages[currentIndex] : undefined
  const currentLabel = !currentStage
    ? '暂无阶段计划'
    : allCompleted
      ? '全部阶段已完成'
      : '第 ' + (currentIndex + 1) + ' 阶段 · ' + currentStage.title

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-yx-brand-soft text-yx-brand">
            <MilestoneIcon className="h-4.5 w-4.5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-yx-ink">课题阶段进度</h2>
            <p className="mt-0.5 text-[10px] text-yx-muted">共 {stages.length} 个阶段，已完成 {completedCount} 个</p>
          </div>
        </div>
        <div className="text-right">
          <div className="text-lg font-bold leading-none text-yx-ink tabular-nums">{currentIndex >= 0 ? currentIndex + 1 : 0}<span className="ml-1 text-xs font-medium text-yx-faint">/ {stages.length}</span></div>
          <div className="mt-1 text-[9px] text-yx-faint">阶段位置</div>
        </div>
      </div>

      <div className="mt-4 flex min-w-0 flex-wrap items-center gap-2">
        <span className="shrink-0 rounded-md bg-yx-brand-soft px-2 py-1 text-[9px] font-semibold text-yx-brand-strong">当前阶段</span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-yx-ink" title={currentLabel}>{currentLabel}</span>
      </div>

      {groups.length > 0 && (
        <div className="mt-3 flex gap-1.5" aria-label={'共 ' + stages.length + ' 个阶段，当前第 ' + (currentIndex + 1) + ' 阶段'}>
          {groups.map((group, index) => {
            const completed = group.stage.lifecycleStatus === 'completed'
            const current = index === currentIndex && !allCompleted
            return (
              <span
                key={group.stage.id}
                className={'h-2 min-w-0 flex-1 rounded-full ' + (completed ? 'bg-yx-brand' : current ? 'bg-yx-brand/45' : 'bg-yx-hover')}
                title={'阶段 ' + (index + 1) + '：' + group.stage.title + '，' + (group.skippedEmpty ? SKIPPED_EMPTY_COPY : completed ? '已完成' : current ? '进行中' : '未开始')}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

function HistoryRow({
  report,
  stage,
  active,
  latest,
  canDelete,
  onOpen,
  onDelete,
  onReplace,
}: {
  report: WorkspaceReportCard
  stage: ProjectStageRecord
  active: boolean
  latest: boolean
  canDelete: boolean
  onOpen: () => void
  onDelete?: () => void
  onReplace?: () => void
}) {
  const status = reportHistoryStatus(report)
  const characterDelta = comparisonIsHidden(report.comparison) ? undefined : characterDeltaFromComparison(report.comparison)

  return (
    <article
      aria-current={active ? 'true' : undefined}
      className={'grid grid-cols-2 items-center gap-x-3 gap-y-3 px-3 py-3 transition-colors sm:px-4 @min-[1200px]/history:grid-cols-[400px_minmax(0,1fr)_9rem_3.25rem_3.25rem_5.5rem_4.5rem_auto] ' + (active ? 'bg-yx-brand-soft/50' : 'hover:bg-yx-surface/90')}
    >
      <div className="col-span-2 min-w-0 overflow-hidden @min-[1200px]/history:col-span-1">
        <div className="min-w-0 max-w-[400px]">
          <div className="flex min-w-0 items-center">
            <h3 className="min-w-0 flex-1 truncate text-xs font-semibold text-yx-ink" title={report.title}>{report.title}</h3>
          </div>
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
            <HistoryBadge tone="stage" title={stageBadgeLabel(stage)}>{stageBadgeLabel(stage)}</HistoryBadge>
            <HistoryBadge tone="role">{report.labels.roleLabel}</HistoryBadge>
            <HistoryBadge tone="version">{'V' + report.stageVersion}</HistoryBadge>
            {report.isCurrentCompletion ? <HistoryBadge tone="completion">当前完结</HistoryBadge> : null}
            {latest ? <HistoryBadge tone="latest">最近提交</HistoryBadge> : null}
            {active ? <HistoryBadge tone="viewing">正在查看</HistoryBadge> : null}
          </div>
        </div>
      </div>
      <div aria-hidden="true" className="hidden min-w-0 @min-[1200px]/history:block" />

      <HistoryMetric label="时间">
        <div className="flex items-center gap-1.5 tabular-nums">
          <Clock3 className="h-3 w-3 shrink-0 text-yx-faint @min-[1200px]/history:hidden" />
          <time dateTime={report.submittedAt} className="whitespace-nowrap text-[11px] font-medium leading-5 text-yx-ink">{formatReportDate(report.submittedAt)} {formatReportTime(report.submittedAt)}</time>
        </div>
      </HistoryMetric>

      <HistoryMetric label="AI评分">
        {report.aiScore === undefined
          ? <UnavailableMetric />
          : <div className={'text-xs font-semibold leading-5 tabular-nums ' + scoreTextClass(report.aiScore)}>{report.aiScore}<span className="ml-0.5 text-[9px] font-medium text-yx-faint">分</span></div>}
      </HistoryMetric>

      <HistoryMetric label="完整度">
        {report.completeness === undefined
          ? <UnavailableMetric />
          : <div className={'text-xs font-semibold leading-5 tabular-nums ' + scoreTextClass(report.completeness)}>{report.completeness}<span className="ml-0.5 text-[9px] font-medium text-yx-faint">%</span></div>}
      </HistoryMetric>

      <HistoryMetric label="字数">
        <div className="flex flex-wrap items-baseline justify-end gap-x-1 leading-5 tabular-nums">
          <span className="text-xs font-semibold text-yx-ink">
            {report.characterCount.toLocaleString('zh-CN')}
          </span>
          {characterDelta !== undefined && (
            <span className={'text-[10px] font-medium ' + (characterDelta >= 0 ? 'text-yx-brand-hover' : 'text-yx-warning-text')}>
              {(characterDelta >= 0 ? '+' : '-') + Math.abs(characterDelta).toLocaleString('zh-CN')}
            </span>
          )}
        </div>
      </HistoryMetric>

      <div className="flex min-w-0 items-center justify-end">
        <span className={'inline-flex h-6 max-w-full items-center justify-center whitespace-nowrap rounded-md px-2 text-[10px] font-semibold ' + status.className}>
          {status.label}
        </span>
      </div>

      <div className="col-span-2 flex min-w-0 items-center justify-end gap-2 @min-[1200px]/history:col-span-1">
        <button
          type="button"
          onClick={onOpen}
          className={'flex h-7.5 min-w-0 items-center justify-center gap-1.5 rounded-lg bg-yx-brand px-3 text-[10px] font-semibold text-white shadow-2xs transition-colors hover:bg-yx-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yx-brand ' + (canDelete || onReplace ? 'flex-1 @min-[1200px]/history:flex-none' : 'w-full @min-[1200px]/history:w-auto')}
        >
          <span className="whitespace-nowrap">查看报告</span>
          <ArrowRight className="h-3 w-3 shrink-0 text-white" />
        </button>
        {onReplace ? (
          <button
            type="button"
            onClick={onReplace}
            aria-label={'替换完结报告 V' + report.stageVersion}
            title={'替换完结报告 V' + report.stageVersion}
            className="flex h-7.5 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-yx-line px-2.5 text-[10px] font-semibold text-yx-brand transition-colors hover:border-yx-brand hover:bg-yx-brand-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yx-brand"
          >
            <Replace aria-hidden="true" className="h-3 w-3 shrink-0" />
            <span>替换</span>
          </button>
        ) : null}
        {canDelete && onDelete ? (
          <button
            type="button"
            onClick={onDelete}
            aria-label={'删除报告 V' + report.stageVersion}
            title={'删除报告 V' + report.stageVersion}
            className="flex h-7.5 w-7.5 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent text-[10px] font-semibold text-yx-muted transition-colors hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500 sm:w-auto sm:px-2.5"
          >
            <Trash2 className="h-3 w-3 shrink-0" />
            <span className="hidden sm:inline">删除</span>
          </button>
        ) : null}
      </div>
    </article>
  )
}

function HistoryMetric({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex min-w-0 flex-col items-end overflow-hidden text-right"><div className="mb-1 text-[9px] font-medium leading-none text-yx-faint">{label}</div>{children}</div>
}

const historyBadgeToneClass = {
  stage: 'border-yx-brand/15 bg-yx-brand-soft text-yx-brand-strong',
  role: 'border-yx-warning/20 bg-yx-warning-soft text-yx-warning-text',
  version: 'border-yx-line bg-yx-surface text-yx-ink-soft',
  completion: 'border-yx-ink/15 bg-yx-ink/5 text-yx-ink',
  latest: 'border-yx-brand/20 bg-yx-brand/10 text-yx-brand',
  viewing: 'border-yx-brand/25 bg-yx-brand-tint text-yx-brand-strong',
} as const

function HistoryBadge({
  tone,
  title,
  children,
}: {
  tone: keyof typeof historyBadgeToneClass
  title?: string
  children: ReactNode
}) {
  return (
    <span title={title} className={'inline-flex h-5 max-w-full min-w-0 shrink-0 items-center justify-center whitespace-nowrap rounded-md border px-1.5 text-[9px] font-medium leading-none ' + historyBadgeToneClass[tone]}>
      <span className="truncate">{children}</span>
    </span>
  )
}

function stageBadgeLabel(stage: Pick<ProjectStageRecord, 'ordinal' | 'title'>) {
  return '阶段 ' + String(stage.ordinal).padStart(2, '0') + ' · ' + stage.title
}

function UnavailableMetric() {
  return <div className="text-[10px] font-medium leading-5 text-yx-faint">暂无数据</div>
}

export function reportHistoryStatus(report: Pick<WorkspaceReportCard, 'aiScore' | 'capabilities'>) {
  if (report.capabilities.analysisAction === 'retry') return { label: '分析失败', className: 'bg-yx-warning text-white' }
  if (hasCompletedFullAnalysis(report)) return { label: '分析完成', className: 'bg-yx-brand text-white' }
  if (report.capabilities.analysisAction === 'none') return { label: '尚未分析', className: 'bg-yx-surface text-yx-muted' }
  return { label: '待分析', className: 'bg-yx-surface text-yx-muted' }
}

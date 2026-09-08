'use client'

import { type CSSProperties } from 'react'
import { ArrowUpToLine, BookOpen, FileCheck2, FileText, Pencil, Sparkles, TrendingUp, X } from 'lucide-react'
import { AnalysisResultHint } from '@/components/analysis-result-hint'
import { InfoCallout } from '@/components/info-callout'
import { WorkbenchCardDecoration } from '@/components/ui/card-decoration'
import type { AnalysisJob } from '@/modules/analysis/domain'
import {
  analysisResultPlaceholder,
  buildAnalysisProgress,
  isAnalysisResultScanning,
  isAnalysisResultVisible,
  resolveAnalysisResultDisplay,
  type AnalysisProgressNodeState,
} from '@/modules/analysis/progress'
import type { AnalysisJobStatus, AnalysisModuleState, AnalysisSnapshotPayload, ReportDetailSection } from '@/modules/contracts/analysis'
import { activeAnalysisJobStatuses } from '@/lib/analysis-job-progress'
import { formatReportCharacters } from '@/lib/format'
import type { ReportVersion } from '@/modules/reports/domain'

export function isWorkbenchAnalysisInFlight(analyzing: boolean, job?: Pick<AnalysisJob, 'status'>) {
  if (job) return activeAnalysisJobStatuses.has(job.status)
  return analyzing
}

export function resolveHistoricalWorkbenchTitle(stageName?: string) {
  const normalizedStageName = stageName?.trim() ?? ''
  return normalizedStageName ? `正在查看 ${normalizedStageName}` : '正在查看'
}

export type WorkbenchAnalysisAction = {
  label: '启动分析' | '更新分析' | '再次分析'
  failed: boolean
  errorMessage?: string
}

export function resolveWorkbenchAnalysisAction(input: {
  report?: Pick<ReportVersion, 'hasCompletedFullAnalysis'>
  job?: Pick<AnalysisJob, 'status' | 'errorMessage'>
}): WorkbenchAnalysisAction | undefined {
  if (!input.report) return undefined
  if (input.job?.status === 'failed') {
    return {
      label: '再次分析',
      failed: true,
      errorMessage: input.job.errorMessage?.trim() || '报告分析失败。',
    }
  }
  return {
    label: input.report.hasCompletedFullAnalysis ? '更新分析' : '启动分析',
    failed: false,
  }
}


export function ReportOverviewCard({ report, stageLabel, snapshot, analyzing, jobStatus, className }: { report: ReportVersion; stageLabel: string; snapshot: AnalysisSnapshotPayload; analyzing?: boolean; jobStatus?: AnalysisJobStatus; className?: string }) {
  const completenessConclusion = snapshot.reportDetails?.completenessConclusion
  const reportDetails = snapshot.reportDetails
  const sections = reportDetails?.sections ?? []
  const characterDelta = report.previousCharacterCount !== undefined ? report.characterCount - report.previousCharacterCount : 0
  const display = resolveAnalysisResultDisplay({ analyzing: Boolean(analyzing), hasData: sections.length > 0, jobStatus })
  const scanning = isAnalysisResultScanning(display)
  const showSections = isAnalysisResultVisible(display)

  return (
    <div className={`yx-dashboard-card relative overflow-hidden flex flex-col min-h-0 !py-[20px] !px-[25px] ${className ?? ''}`}>
      <WorkbenchCardDecoration kind="details" />
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
      <div className="mb-2 flex shrink-0 items-start justify-between gap-2 sm:mb-2 xl:mb-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden sm:gap-2">
          <FileText className="h-[21px] w-[21px] shrink-0 text-yx-ink sm:h-[26px] sm:w-[26px]" />
          <div className="min-w-0 flex-1 overflow-hidden">
            <h2 className="text-sm font-semibold text-yx-ink sm:text-base">报告详情</h2>
            <p className="mt-px text-[9px] text-yx-muted sm:text-[10px]">报告结构以及章节等主要内容</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 self-center text-[9px] font-medium sm:text-[10px]">
          <AnalysisResultHint display={display} />
          {!scanning && display !== 'updating' && display !== 'stale' ? (
            <span className={characterDelta > 0 ? 'text-yx-brand' : characterDelta < 0 ? 'text-yx-warning' : 'text-yx-faint'}>
              {characterDelta > 0 ? '↑ ' + formatReportCharacters(characterDelta) : characterDelta < 0 ? '↓ ' + formatReportCharacters(Math.abs(characterDelta)) : '0'} 字 · 较上一版
            </span>
          ) : null}

        </div>
      </div>
      <div className="grid grid-cols-4 gap-1.5 sm:gap-2 shrink-0">
        <ReportStat label="阶段" value={stageLabel} />
        <ReportStat label="段落" value={report.paragraphCount + '段'} />
        <ReportStat label="字符" value={formatReportCharacters(report.characterCount)} />
        <ReportStat label="章节" value={showSections ? sections.length + '章' : '—'} />
      </div>
      {showSections ? (
        <div className="yx-data-in yx-no-scrollbar mt-1.5 min-h-0 flex-1 overflow-y-auto xl:mt-2"><div className="grid items-start gap-1 sm:grid-cols-2">{sections.map((section, index) => <ReportDetailSectionRow key={section.id} index={index + 1} section={section} />)}</div></div>
      ) : (
        <div className="yx-no-scrollbar mt-1.5 min-h-0 flex-1 overflow-y-auto xl:mt-2">
          <div className="grid items-start gap-1 sm:grid-cols-2">
            {[['w-4/5', 'w-2/3'], ['w-3/4', 'w-1/2'], ['w-5/6', 'w-3/5'], ['w-2/3', 'w-1/2']].map((bars, index) => (
              <div key={index} className="flex h-[37px] min-w-0 flex-col justify-center gap-1.5 rounded-md bg-yx-surface px-2">
                {bars.map((width, barIndex) => (
                  scanning ? (
                    <div key={width} className={'yx-suggestion-bar !h-1.5 ' + width} style={{ '--yx-bar-delay': (index * 180 + barIndex * 120) + 'ms' } as CSSProperties} />
                  ) : (
                    <div key={width} className={'h-1.5 rounded-full bg-yx-line ' + width} />
                  )
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="mt-2 w-full min-w-0 max-w-full shrink-0"><InfoCallout icon={FileCheck2} label="完整度结论" text={showSections && completenessConclusion ? completenessConclusion : analysisResultPlaceholder(display)} tone="muted" scanning={scanning} scanDelay="220ms" /></div>
      </div>
    </div>
  )
}



export function ResearchWorkbench({ className, analyzing, cancelling, job, moduleStates, canManage, report, viewingHistoricalReport, historicalStageName, onReturnToLatestReport, onCancelAnalysis, onOpenProgress, onEditProject, onStartAnalysis }: { className?: string; analyzing: boolean; cancelling: boolean; job?: AnalysisJob; moduleStates: AnalysisModuleState[]; canManage: boolean; report: ReportVersion; viewingHistoricalReport?: boolean; historicalStageName?: string; onReturnToLatestReport?: () => void; onCancelAnalysis: () => Promise<void>; onOpenProgress?: (milestoneId?: string) => void; onEditProject?: () => void; onStartAnalysis?: (reportId?: string) => void }) {
  const mode = viewingHistoricalReport ? 'historical-view' : 'subsequent-upload'
  const progress = buildAnalysisProgress({ job, moduleStates })
  const showProgress = isWorkbenchAnalysisInFlight(analyzing, job)
  const analysisAction = showProgress || viewingHistoricalReport ? undefined : resolveWorkbenchAnalysisAction({ report, job })

  const actionTitle = !canManage
    ? '查看当前报告'
    : analysisAction?.failed
      ? '报告分析失败'
      : analysisAction?.label === '启动分析'
        ? '报告已上传，待启动分析'
        : '上传后续报告'

  const surfaceClass = mode === 'historical-view'
    ? 'from-yx-brand-hover via-yx-brand to-yx-brand-strong text-white shadow-md'
    : 'from-yx-brand via-yx-brand to-yx-brand-hover'

  return (
    <div className={`relative isolate h-[96px] min-w-0 w-full self-start overflow-hidden rounded-xl bg-gradient-to-br ${surfaceClass} p-0 text-white shadow-md sm:h-[104px] xl:h-[116px] ${className ?? ''}`}>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -bottom-16 -right-14 h-36 w-36 rounded-full border border-white/15 bg-white/[0.035]" />
        <div className="absolute -bottom-10 right-2 h-32 w-32 rounded-full border border-white/10" />
      </div>
      <div className="absolute inset-x-[18px] top-[18px] z-10 flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-[8px] font-semibold uppercase tracking-[0.14em] text-white sm:text-[9px]">
          <BookOpen className="h-3 w-3 shrink-0 text-white" />
          研究工作台
        </div>
      </div>
      {showProgress ? (
        <AnalysisProgressMonitor
          progress={progress}
          canCancel={canManage && isWorkbenchAnalysisInFlight(analyzing, job)}
          cancelling={cancelling}
          onCancel={onCancelAnalysis}
        />
      ) : mode === 'historical-view' ? (
        <>
          <div className="absolute inset-x-[18px] top-[34px] bottom-[42px] z-10 flex min-w-0 flex-col items-start justify-center gap-0.5">
            <HistoricalWorkbenchTitle stageName={historicalStageName} />
          </div>
          <div className="absolute bottom-[12px] left-[18px] z-10 flex flex-wrap items-center gap-2">
            {onReturnToLatestReport && (
              <button
                type="button"
                onClick={onReturnToLatestReport}
                className="inline-flex items-center gap-1.5 rounded-full bg-yx-paper px-3.5 py-1.5 text-[10px] font-bold text-yx-brand shadow-md ring-1 ring-white/70 transition-colors hover:bg-yx-brand-soft"
              >
                <ArrowUpToLine className="h-3.5 w-3.5 text-yx-brand" />
                <span>返回当前成果</span>
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="absolute inset-x-[18px] top-[34px] bottom-[42px] z-10 flex min-w-0 flex-col items-start justify-center gap-0.5">
            <h3 className="max-w-full truncate text-base font-bold leading-tight text-white sm:text-lg" title={actionTitle}>{actionTitle}</h3>
            {analysisAction?.failed && analysisAction.errorMessage ? (
              <p className="max-w-full truncate text-[9px] font-medium text-white/80 sm:text-[10px]" title={analysisAction.errorMessage}>{analysisAction.errorMessage}</p>
            ) : null}
          </div>
          {canManage && <div className="absolute bottom-[12px] left-[18px] z-10 flex flex-wrap items-center gap-2">
            {analysisAction && onStartAnalysis && (
              <button
                type="button"
                onClick={() => onStartAnalysis(report.id)}
                className="inline-flex items-center gap-1.5 rounded-full bg-yx-paper px-3.5 py-1.5 text-[10px] font-bold text-yx-brand shadow-md ring-1 ring-white/70 transition-all hover:bg-yx-brand-soft active:scale-95"
              >
                <Sparkles className="h-3.5 w-3.5 text-yx-brand" />
                <span>{analysisAction.label}</span>
              </button>
            )}
            {onOpenProgress && (
              <button
                type="button"
                onClick={() => onOpenProgress()}
                title="更新课题进展"
                aria-label="更新课题进展"
                className="inline-flex items-center gap-1.5 rounded-full bg-yx-paper px-4 py-1.5 text-[10px] font-bold text-yx-brand shadow-md ring-1 ring-white/70 transition-colors hover:bg-yx-brand-soft"
              >
                <TrendingUp className="h-3.5 w-3.5 text-yx-brand" />
                课题进展
              </button>
            )}
            {onEditProject && (
              <button
                type="button"
                onClick={onEditProject}
                className="inline-flex items-center gap-1 rounded-full bg-yx-paper px-3.5 py-1.5 text-[10px] font-semibold text-yx-brand shadow-md ring-1 ring-white/70 transition-colors hover:bg-yx-brand-soft"
              >
                <Pencil className="h-3.5 w-3.5 text-yx-brand" />
                修改课题
              </button>
            )}
          </div>}
        </>
      )}
    </div>
  )
}

function HistoricalWorkbenchTitle({ stageName }: { stageName?: string }) {
  const normalizedStageName = stageName?.trim() ?? ''
  const title = resolveHistoricalWorkbenchTitle(normalizedStageName)

  return (
    <h3 className="flex max-w-full min-w-0 items-center gap-1.5 text-base font-bold leading-tight text-white sm:text-lg" title={title}>
      <span className="shrink-0">正在查看</span>
      {normalizedStageName ? <span className="min-w-0 truncate">{normalizedStageName}</span> : null}
    </h3>
  )
}

function AnalysisProgressMonitor({ progress, canCancel, cancelling, onCancel }: { progress: ReturnType<typeof buildAnalysisProgress>; canCancel: boolean; cancelling: boolean; onCancel: () => Promise<void> }) {
  const waiting = progress.activeStepIndex < 0
  const statusText = progress.detail ? progress.title + '。' + progress.detail : progress.title

  return (
    <div className="yx-rise-in absolute inset-x-[18px] bottom-[10px] top-[34px] z-10 flex min-w-0 flex-col" aria-live="polite" aria-atomic="true">
      <div className="flex min-h-0 min-w-0 flex-1 items-center gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-bold leading-tight text-white sm:text-base" title={statusText}>{progress.title}<span className="yx-progress-ellipsis" /></h3>
          {progress.detail ? <p className="mt-0.5 truncate text-[9px] font-medium text-white/75 sm:text-[10px]" title={progress.detail}>{progress.detail}</p> : null}
        </div>
        {canCancel && <button type="button" onClick={() => void onCancel()} disabled={cancelling} aria-label={cancelling ? '正在停止分析' : '停止分析'} title={cancelling ? '正在停止分析' : '停止分析'} className="inline-flex shrink-0 items-center gap-1 self-center rounded-full bg-yx-warning px-2 py-1 text-[8px] font-semibold text-white shadow-sm ring-1 ring-white/35 transition-colors hover:bg-yx-warning-text disabled:cursor-wait disabled:opacity-70 sm:px-2.5 sm:text-[9px]"><X className="h-3 w-3" />{cancelling ? '停止中' : '停止'}</button>}
      </div>
      <div className="mt-1 min-w-0 shrink-0">
        {waiting ? (
          <div>
            <div className="yx-indeterminate-track h-1.5 min-w-0 rounded-full bg-black/15" role="progressbar" aria-label={statusText}>
              <div className="yx-indeterminate-bar bg-white/80" />
            </div>
            <ol className="mt-1 grid grid-cols-4 gap-1" aria-hidden="true">
              {progress.nodes.map((node) => (
                <li key={node.stage} className="truncate text-center text-[8px] font-medium text-white/55 sm:text-[9px]">{node.shortLabel}</li>
              ))}
            </ol>
          </div>
        ) : (
          <ol className="grid min-w-0 grid-cols-4 gap-1" aria-label="报告分析步骤进度">
            {progress.nodes.map((node) => (
              <li key={node.stage} className="min-w-0" aria-current={node.state === 'active' ? 'step' : undefined} aria-label={node.label + '：' + analysisProgressNodeStatusLabel(node.state)} title={node.label + '：' + analysisProgressNodeStatusLabel(node.state)}>
                <div className={'h-1.5 min-w-0 rounded-full transition-colors ' + analysisProgressSegmentClass(node.state)} />
                <span className={'mt-0.5 block truncate text-center text-[8px] font-medium sm:text-[9px] ' + (node.state === 'active' || node.state === 'completed' ? 'text-white' : node.state === 'failed' ? 'text-yx-warning-soft' : 'text-white/55')}>{node.shortLabel}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

function analysisProgressSegmentClass(state: AnalysisProgressNodeState) {
  if (state === 'completed') return 'bg-yx-paper'
  if (state === 'active') return 'yx-shimmer bg-yx-paper'
  if (state === 'failed') return 'bg-yx-warning-soft'
  if (state === 'cancelled') return 'bg-white/35'
  return 'bg-black/15'
}

function analysisProgressNodeStatusLabel(state: AnalysisProgressNodeState) {
  if (state === 'completed') return '已完成'
  if (state === 'active') return '正在进行'
  if (state === 'failed') return '未通过校验'
  if (state === 'cancelled') return '已取消'
  return '等待执行'
}

function ReportStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex h-[32px] min-w-0 items-center justify-between gap-1 rounded-md px-2 bg-yx-surface border-transparent">
      <span className="shrink-0 text-[9px] sm:text-[10px] text-yx-muted font-medium">{label}</span>
      <span className="truncate text-right text-[11px] font-bold sm:text-xs tabular-nums text-yx-ink">{value}</span>
    </div>
  )
}

function ReportDetailSectionRow({ index, section }: { index: number; section: ReportDetailSection }) {
  return (
    <div className="flex h-[37px] min-w-0 items-center gap-1.5 overflow-hidden rounded-md border border-transparent bg-yx-surface px-1.5 py-0.5 transition-all hover:bg-yx-hover">
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-yx-brand text-[8.5px] font-bold text-white">
        {index}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[9.5px] font-semibold leading-tight text-yx-ink" title={section.title}>
          {section.title}
        </div>
        <p className="mt-0.5 line-clamp-1 text-[8.5px] leading-tight text-yx-ink-soft" title={section.summary}>
          {section.summary}
        </p>
      </div>
    </div>
  )
}



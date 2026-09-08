'use client'

import {
  AlertCircle,
  ArrowRight,
  Clock3,
  FileText,
  Milestone as MilestoneIcon,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useWorkspaceEntrance } from '@/components/use-workspace-entrance'
import { apiFetch } from '@/lib/client-request'
import { formatReportDate, formatReportTime, scoreTextClass } from '@/lib/format'
import type { Milestone, ProjectWithCapabilities } from '@/modules/projects/domain'
import type { ReportHistoryEntry, ReportVersion } from '@/modules/reports/domain'
import { canDeleteReportFromHistory, canReplaceReportFromHistory } from '@/modules/reports/history-policy'

type ReportHistoryResponse = {
  latestReportId?: string
  entries?: ReportHistoryEntry[]
  total?: number
  hasMore: boolean
  error?: string
}

type ReportHistoryViewProps = {
  project: ProjectWithCapabilities
  activeReportId?: string
  onOpenReport: (report: ReportVersion) => void
  onDeleteReport: (report: ReportVersion) => void
  onReplaceReport: (report: ReportVersion) => void
  refreshKey?: number
}

export function ReportHistoryView({ project, activeReportId, onOpenReport, onDeleteReport, onReplaceReport, refreshKey = 0 }: ReportHistoryViewProps) {
  const [entries, setEntries] = useState<ReportHistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const { entranceProps } = useWorkspaceEntrance(loading)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const requestSequenceRef = useRef(0)
  const loadMoreControllerRef = useRef<AbortController | undefined>(undefined)

  useEffect(() => {
    const requestSequence = ++requestSequenceRef.current
    const controller = new AbortController()
    loadMoreControllerRef.current?.abort()
    loadMoreControllerRef.current = undefined
    setLoading(true)
    setLoadingMore(false)
    setError('')
    setHasMore(false)
    apiFetch(`/api/projects/${project.id}/reports/history?limit=50&offset=0`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as ReportHistoryResponse | null
        if (controller.signal.aborted || requestSequence !== requestSequenceRef.current) return
        if (!response.ok) throw new Error(body?.error ?? '报告历史读取失败。')
        const nextEntries = body?.entries ?? []
        const nextTotal = body?.total ?? nextEntries.length
        setEntries(nextEntries)
        setTotal(nextTotal)
        setHasMore(body?.hasMore === true)
      })
      .catch((loadError: unknown) => {
        if (controller.signal.aborted || requestSequence !== requestSequenceRef.current) return
        setEntries([])
        setTotal(0)
        setHasMore(false)
        setError(loadError instanceof Error ? loadError.message : '报告历史读取失败。')
      })
      .finally(() => {
        if (!controller.signal.aborted && requestSequence === requestSequenceRef.current) setLoading(false)
      })
    return () => {
      controller.abort()
      if (loadMoreControllerRef.current) {
        loadMoreControllerRef.current.abort()
        loadMoreControllerRef.current = undefined
      }
    }
  }, [project.id, refreshKey, reloadKey])

  async function loadMore() {
    if (loadingMore || !hasMore) return
    const requestSequence = requestSequenceRef.current
    const controller = new AbortController()
    loadMoreControllerRef.current = controller
    setLoadingMore(true)
    try {
      const response = await apiFetch(`/api/projects/${project.id}/reports/history?limit=50&offset=${entries.length}`, { cache: 'no-store', signal: controller.signal })
      const body = await response.json().catch(() => null) as ReportHistoryResponse | null
      if (controller.signal.aborted || requestSequence !== requestSequenceRef.current) return
      if (!response.ok) throw new Error(body?.error ?? '更多报告历史读取失败。')
      const nextEntries = body?.entries ?? []
      const nextTotal = body?.total ?? total
      setEntries((current) => [...current, ...nextEntries.filter((entry) => !current.some((item) => item.report.id === entry.report.id))])
      setTotal(nextTotal)
      setHasMore(body?.hasMore === true)
    } catch (loadError) {
      if (!controller.signal.aborted && requestSequence === requestSequenceRef.current) setError(loadError instanceof Error ? loadError.message : '更多报告历史读取失败。')
    } finally {
      if (loadMoreControllerRef.current === controller) loadMoreControllerRef.current = undefined
      if (!controller.signal.aborted && requestSequence === requestSequenceRef.current) setLoadingMore(false)
    }
  }

  const historyReports = entries.map((entry) => entry.report)

  return (
    <section {...entranceProps} aria-label="报告版本历史" className="yx-detail min-w-0">
      <ProjectProgressSummary project={project} />
      <div aria-busy={loading} className={`mt-4 min-w-0 ${loading ? '' : 'yx-detail-content'}`}>
        {loading ? (
          <HistorySkeleton />
        ) : error ? (
          <div role="alert" className="flex min-h-56 items-center justify-center p-6 text-center">
            <div className="max-w-sm">
              <AlertCircle className="mx-auto h-7 w-7 text-[var(--yx-warning)]" />
              <h3 className="mt-3 text-sm font-semibold text-yx-ink">报告列表加载失败</h3>
              <p className="mt-1.5 text-[10px] leading-relaxed text-gray-500">{error}</p>
              <button type="button" onClick={() => setReloadKey((key) => key + 1)} className="mx-auto mt-4 flex h-9 items-center gap-1.5 rounded-md bg-black px-3.5 text-[10px] font-semibold text-white transition-colors hover:bg-gray-800">
                <RefreshCw className="h-3.5 w-3.5" />重新加载
              </button>
            </div>
          </div>
        ) : entries.length ? (
          <div className="grid gap-3 sm:gap-4">
            {entries.map((entry) => (
              <HistoryRow
                key={entry.report.id}
                entry={entry}
                milestones={project.milestones}
                active={entry.report.id === activeReportId}
                canDelete={project.canDelete && canDeleteReportFromHistory(entry.report, project.milestones, historyReports)}
                canReplace={project.canManage && canReplaceReportFromHistory(entry.report, project.milestones, historyReports)}
                onOpen={() => onOpenReport(entry.report)}
                onDelete={() => onDeleteReport(entry.report)}
                onReplace={() => onReplaceReport(entry.report)}
              />
            ))}
            {hasMore ? (
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void loadMore()}
                className="mx-auto rounded-md border border-yx-line bg-yx-paper px-4 py-2 text-xs font-semibold text-yx-muted transition-colors hover:bg-yx-hover disabled:cursor-wait disabled:opacity-60"
              >
                {loadingMore ? '正在加载…' : `加载更多（${entries.length}/${total}）`}
              </button>
            ) : null}
          </div>
        ) : (
          <div className="flex min-h-56 items-center justify-center p-6 text-center">
            <div>
              <FileText className="mx-auto h-8 w-8 text-gray-200" />
              <h3 className="mt-3 text-sm font-semibold text-gray-700">暂无报告</h3>
              <p className="mt-1 text-[10px] text-gray-400">上传报告后，报告记录将显示在这里。</p>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

function ProjectProgressSummary({ project }: { project: ProjectWithCapabilities }) {
  const milestones = project.milestones ?? []
  const completedCount = milestones.filter((milestone) => milestone.status === 'completed').length
  const allCompleted = milestones.length > 0 && completedCount === milestones.length
  const activeIndex = milestones.findIndex((milestone) => milestone.status === 'in_progress' || milestone.status === 'at_risk')
  const nextIndex = milestones.findIndex((milestone) => milestone.status !== 'completed')
  const currentIndex = allCompleted ? milestones.length - 1 : activeIndex >= 0 ? activeIndex : nextIndex
  const currentMilestone = currentIndex >= 0 ? milestones[currentIndex] : undefined
  const currentLabel = !currentMilestone
    ? '暂无阶段计划'
    : allCompleted
      ? '全部阶段已完成'
      : `第 ${currentIndex + 1} 阶段 · ${currentMilestone.title}`

  return (
    <div className="yx-detail-intro rounded-lg border border-yx-line bg-yx-paper p-4 shadow-2xs sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-50 text-yx-ink">
            <MilestoneIcon className="h-4.5 w-4.5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-yx-ink">课题阶段进度</h2>
            <p className="mt-0.5 text-[10px] text-gray-500">共 {milestones.length} 个阶段，已完成 {completedCount} 个</p>
          </div>
        </div>
        <div className="text-right">
          <div className="text-lg font-bold leading-none text-yx-ink tabular-nums">{currentIndex >= 0 ? currentIndex + 1 : 0}<span className="ml-1 text-xs font-medium text-gray-400">/ {milestones.length}</span></div>
          <div className="mt-1 text-[9px] text-gray-400">阶段位置</div>
        </div>
      </div>

      <div className="mt-4 flex min-w-0 flex-wrap items-center gap-2">
        <span className="shrink-0 rounded-md bg-gray-100 px-2 py-1 text-[9px] font-semibold text-yx-ink-soft">当前阶段</span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-yx-ink" title={currentLabel}>{currentLabel}</span>
      </div>

      {milestones.length > 0 && (
        <div className="mt-3 flex gap-1.5" aria-label={`共 ${milestones.length} 个阶段，当前第 ${currentIndex + 1} 阶段`}>
          {milestones.map((milestone, index) => {
            const completed = milestone.status === 'completed'
            const current = index === currentIndex && !allCompleted
            return (
              <span
                key={milestone.id}
                className={`h-2 min-w-0 flex-1 rounded-full ${completed ? 'bg-yx-brand' : current ? 'bg-yx-brand/45' : 'bg-gray-200'}`}
                title={`阶段 ${index + 1}：${milestone.title}，${completed ? '已完成' : current ? '进行中' : '未开始'}`}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

function HistoryRow({ entry, milestones, active, canDelete, canReplace, onOpen, onDelete, onReplace }: { entry: ReportHistoryEntry; milestones: Milestone[]; active: boolean; canDelete: boolean; canReplace: boolean; onOpen: () => void; onDelete: () => void; onReplace: () => void }) {
  const { report, aiScore, completeness } = entry
  const milestoneIndex = milestones.findIndex((milestone) => milestone.id === report.milestoneId)
  const milestone = milestoneIndex >= 0 ? milestones[milestoneIndex] : undefined
  const status = reportHistoryStatus(report)
  const characterDelta = report.previousCharacterCount === undefined
    ? undefined
    : report.characterCount - report.previousCharacterCount
  const hasCharacterCount = report.parseStatus === 'ready'

  return (
    <article
      aria-current={active ? 'true' : undefined}
      className={`relative grid grid-cols-2 items-center gap-4 rounded-lg border border-yx-line bg-yx-paper px-3 py-4 shadow-2xs transition-colors hover:bg-gray-50 sm:px-4 xl:py-3.5 ${canDelete || canReplace ? 'xl:grid-cols-[minmax(14rem,1fr)_repeat(5,minmax(0,8rem))_11.5rem]' : 'xl:grid-cols-[minmax(14rem,1fr)_repeat(5,minmax(0,8rem))_7.5rem]'}`}
    >
      <div className="col-span-2 min-w-0 xl:col-span-1">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center">
            <h3 className="min-w-0 flex-1 truncate text-xs font-semibold text-yx-ink" title={report.title}>{report.title}</h3>
          </div>
          <div className="mt-1.5 flex min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden">
            <span className="shrink-0 whitespace-nowrap rounded-md bg-yx-warning px-1.5 py-0.5 text-[8px] font-semibold text-white">
              {milestone ? `阶段 ${String(milestoneIndex + 1).padStart(2, '0')}` : '未分配阶段'}
            </span>
            {milestone ? (
              <>
                <span className="max-w-full truncate whitespace-nowrap rounded-md bg-yx-brand px-1.5 py-0.5 text-[8px] font-bold text-white" title={milestone.title}>{milestone.title}</span>
                <span className="shrink-0 whitespace-nowrap rounded-md bg-yx-brand px-1.5 py-0.5 text-[8px] font-bold text-white">{report.deliveryType === 'final' ? '最终办结' : '阶段办结'}</span>
              </>
            ) : (
              <span className="min-w-0 truncate text-[9px] text-yx-muted">该报告尚未关联课题阶段</span>
            )}
            <VersionLabel active={active} />
          </div>
        </div>
      </div>

      <HistoryMetric label="时间">
        <div className="flex items-center gap-1.5 tabular-nums">
          <Clock3 className="h-3 w-3 shrink-0 text-gray-300 xl:hidden" />
          <div className="whitespace-nowrap text-[13px] font-semibold leading-5 text-yx-ink">{formatReportDate(report.createdAt)} {formatReportTime(report.createdAt)}</div>
        </div>
      </HistoryMetric>

      <HistoryMetric label="AI评分">
        {aiScore === undefined
          ? <UnavailableMetric report={report} />
          : <div className={`text-[13px] font-semibold leading-5 tabular-nums ${scoreTextClass(aiScore)}`}>{aiScore}<span className="ml-0.5 text-[9px] font-medium text-gray-400">分</span></div>}
      </HistoryMetric>

      <HistoryMetric label="完整度">
        {completeness === undefined
          ? <UnavailableMetric report={report} />
          : <div className={`text-[13px] font-semibold leading-5 tabular-nums ${scoreTextClass(completeness)}`}>{completeness}<span className="ml-0.5 text-[9px] font-medium text-gray-400">%</span></div>}
      </HistoryMetric>

      <HistoryMetric label="字数">
        {hasCharacterCount ? (
          <div className="flex items-baseline justify-center gap-1 leading-5 tabular-nums">
            <span className="text-[13px] font-semibold text-yx-ink">
              {report.characterCount.toLocaleString('zh-CN')}
            </span>
            {characterDelta !== undefined && (
              <span className={`text-[10px] font-medium ${characterDelta >= 0 ? 'text-emerald-600' : 'text-orange-600'}`}>
                {characterDelta >= 0 ? '+' : '-'}{Math.abs(characterDelta).toLocaleString('zh-CN')}
              </span>
            )}
          </div>
        ) : <span className="text-[10px] font-medium text-gray-400">{report.parseStatus === 'failed' ? '--' : '计算中'}</span>}
      </HistoryMetric>

      <div className="flex min-w-0 items-center justify-center">
        <span className={`inline-flex h-7.5 max-w-full items-center justify-center rounded-lg px-2.5 text-[10px] font-semibold ${status.className}`}>
          {status.label}
        </span>
      </div>

      <div className="flex min-w-0 items-center justify-end gap-2">
        <button
          type="button"
          onClick={onOpen}
          className={`flex h-7.5 min-w-0 items-center justify-center gap-1.5 rounded-lg bg-yx-brand px-3 text-[10px] font-semibold text-white shadow-2xs transition-colors hover:bg-yx-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yx-brand ${canDelete || canReplace ? 'flex-1 xl:flex-none' : 'w-full xl:w-auto'}`}
        >
          <span className="whitespace-nowrap">查看报告</span>
          <ArrowRight className="h-3 w-3 shrink-0 text-white" />
        </button>
        {canReplace && (
          <button
            type="button"
            onClick={onReplace}
            aria-label={`替换报告 V${report.version}`}
            title={`替换报告 V${report.version}`}
            className="flex h-7.5 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 text-[10px] font-semibold text-yx-brand-hover transition-colors hover:border-emerald-300 hover:bg-emerald-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yx-brand"
          >
            <RefreshCw className="h-3 w-3 shrink-0" />
            <span>替换</span>
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            onClick={onDelete}
            aria-label={`删除报告 V${report.version}`}
            title={`删除报告 V${report.version}`}
            className="flex h-7.5 w-7.5 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent text-[10px] font-semibold text-yx-muted transition-colors hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500 sm:w-auto sm:px-2.5"
          >
            <Trash2 className="h-3 w-3 shrink-0" />
            <span className="hidden sm:inline">删除</span>
          </button>
        )}
      </div>
    </article>
  )
}

function HistoryMetric({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex min-w-0 flex-col items-center text-center"><div className="mb-1.5 text-[9px] font-medium leading-none text-gray-400">{label}</div>{children}</div>
}

function VersionLabel({ active }: { active: boolean }) {
  if (!active) return null
  return <span className="shrink-0 whitespace-nowrap rounded-md bg-yx-ink px-1.5 py-0.5 text-[8px] font-semibold text-white">正在查看</span>
}

function UnavailableMetric({ report }: { report: ReportVersion }) {
  const detail = report.latestJobStatus === 'running' || report.latestJobStatus === 'queued'
    ? '分析中'
    : '暂无数据'
  return <div><div className="text-[13px] font-semibold leading-5 text-gray-300">--</div><div className="mt-0.5 text-[8px] text-gray-400">{detail}</div></div>
}

export function reportHistoryStatus(report: ReportVersion) {
  if (report.parseStatus === 'failed') return { label: '解析失败', className: 'bg-yx-warning text-white' }
  if (report.latestJobStatus === 'failed') return { label: '分析失败', className: 'bg-yx-warning text-white' }
  if (report.latestJobStatus === 'cancelled') return { label: '分析已取消', className: 'bg-yx-hover text-yx-muted' }
  if (report.latestJobStatus === 'queued' || report.latestJobStatus === 'running') {
    return { label: '分析中', className: 'bg-yx-warning text-white' }
  }
  if (report.parseStatus !== 'ready') return { label: '尚未分析', className: 'bg-yx-surface text-yx-muted' }
  if (report.hasCompletedFullAnalysis) return { label: '分析完成', className: 'bg-yx-brand text-white' }
  return { label: '待分析', className: 'bg-yx-surface text-yx-muted' }
}


function HistorySkeleton() {
  return <div aria-label="正在加载报告历史" className="grid gap-3 sm:gap-4">{Array.from({ length: 4 }, (_, index) => <div key={index} className="grid grid-cols-[2.2fr_1fr_1fr] gap-4 rounded-lg border border-yx-line bg-yx-paper px-4 py-4 shadow-2xs"><div className="h-9 animate-pulse rounded-md bg-gray-100" /><div className="h-9 animate-pulse rounded-md bg-gray-100" /><div className="h-9 animate-pulse rounded-md bg-gray-100" /></div>)}</div>
}

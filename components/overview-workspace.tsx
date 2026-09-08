'use client'

import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  FolderPlus,
  Layers3,
  Loader2,
  Minus,
  Pencil,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Upload,
} from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { EmptyState } from '@/components/ui/empty-state'
import { formatCharacters, formatDate, formatMetric, formatRelativeTime, scoreTextClass } from '@/lib/format'
import { cumulativeTrend, runningAverageValues, trendDirectionOf, type TrendDirection } from '@/lib/overview-trends'
import { CardAura } from '@/components/ui/card-decoration'
import type { KnowledgeItem, OverviewStats, ReportWithProject } from '@/components/workspace-types'
import type { ProjectWithCapabilities } from '@/modules/projects/domain'

type QualityBand = 'excellent' | 'good' | 'weak' | 'unanalyzed'

const qualityBandMeta: Record<QualityBand, { label: string; bar: string; dot: string; text: string }> = {
  excellent: { label: '优秀 ≥ 80', bar: 'bg-yx-brand', dot: 'bg-yx-brand', text: 'text-yx-brand-hover' },
  good: { label: '良好 60–79', bar: 'bg-yx-brand-bright', dot: 'bg-yx-brand-bright', text: 'text-yx-brand-hover' },
  weak: { label: '待提升 < 60', bar: 'bg-yx-warning', dot: 'bg-yx-warning', text: 'text-yx-warning-text' },
  unanalyzed: { label: '待分析', bar: 'bg-yx-line', dot: 'bg-yx-line', text: 'text-yx-faint' },
}

function qualityBandOf(score: number | undefined): QualityBand {
  if (score === undefined) return 'unanalyzed'
  if (score >= 80) return 'excellent'
  if (score >= 60) return 'good'
  return 'weak'
}

function timestampsNear(left: string, right: string, ms = 2500) {
  const a = new Date(left).getTime()
  const b = new Date(right).getTime()
  if (Number.isNaN(a) || Number.isNaN(b)) return false
  return Math.abs(a - b) <= ms
}

type ProjectActivityKind = 'analyzing' | 'analyzed' | 'failed' | 'upload' | 'edit' | 'created'

type ProjectActivity = {
  id: string
  project: ProjectWithCapabilities
  report?: ReportWithProject
  kind: ProjectActivityKind
  at: string
  label: string
  detail: string
}

const projectActivityMeta: Record<ProjectActivityKind, { icon: typeof Sparkles; iconWrap: string; iconClass: string }> = {
  analyzing: { icon: Loader2, iconWrap: 'bg-yx-brand', iconClass: 'h-3.5 w-3.5 animate-spin text-white' },
  analyzed: { icon: Sparkles, iconWrap: 'bg-yx-brand', iconClass: 'h-3.5 w-3.5 text-white' },
  failed: { icon: AlertTriangle, iconWrap: 'bg-yx-warning', iconClass: 'h-3.5 w-3.5 text-white' },
  upload: { icon: Upload, iconWrap: 'bg-yx-brand', iconClass: 'h-3.5 w-3.5 text-white' },
  edit: { icon: Pencil, iconWrap: 'bg-yx-ink', iconClass: 'h-3.5 w-3.5 text-white' },
  created: { icon: FolderPlus, iconWrap: 'bg-yx-ink', iconClass: 'h-3.5 w-3.5 text-white' },
}

function versionLabel(version: number) {
  return 'v' + String(version).padStart(2, '0')
}

function reportActivityAt(report: ReportWithProject) {
  return report.sourceUpdatedAt || report.createdAt
}

function latestProjectActivity(project: ProjectWithCapabilities, projectReports: ReportWithProject[]): ProjectActivity {
  const latestReport = projectReports[0]
  const analyzingReport = projectReports.find((report) => report.latestJobStatus === 'queued' || report.latestJobStatus === 'running')
  const looksLikeUpload = projectReports.some((report) => timestampsNear(project.updatedAt, reportActivityAt(report)))
  const isFreshCreate = timestampsNear(project.updatedAt, project.createdAt)

  if (analyzingReport) {
    return { id: project.id, project, report: analyzingReport, kind: 'analyzing', at: reportActivityAt(analyzingReport), label: '正在分析', detail: versionLabel(analyzingReport.version) }
  }

  let activity: ProjectActivity
  if (latestReport?.latestJobStatus === 'failed') {
    activity = { id: project.id, project, report: latestReport, kind: 'failed', at: reportActivityAt(latestReport), label: '分析失败', detail: versionLabel(latestReport.version) }
  } else if (latestReport?.latestJobStatus === 'cancelled') {
    activity = { id: project.id, project, report: latestReport, kind: 'failed', at: reportActivityAt(latestReport), label: '分析已取消', detail: versionLabel(latestReport.version) }
  } else if (latestReport && (latestReport.aiScore !== undefined || latestReport.hasCompletedFullAnalysis)) {
    activity = { id: project.id, project, report: latestReport, kind: 'analyzed', at: reportActivityAt(latestReport), label: '完成分析', detail: latestReport.aiScore !== undefined ? latestReport.aiScore + ' 分' : versionLabel(latestReport.version) }
  } else if (latestReport) {
    activity = { id: project.id, project, report: latestReport, kind: 'upload', at: reportActivityAt(latestReport), label: '上传报告', detail: versionLabel(latestReport.version) }
  } else if (!isFreshCreate) {
    activity = { id: project.id, project, kind: 'edit', at: project.updatedAt, label: '更新课题', detail: '课题信息已修改' }
  } else {
    activity = { id: project.id, project, kind: 'created', at: project.createdAt, label: '新设立课题', detail: '等待上传报告' }
  }

  if (activity.kind !== 'analyzing' && !isFreshCreate && !looksLikeUpload && project.updatedAt > activity.at) {
    return { id: project.id, project, kind: 'edit', at: project.updatedAt, label: '更新课题', detail: '课题信息已修改' }
  }
  return activity
}

function greetingOf(date: Date) {
  const hour = date.getHours()
  if (hour < 5) return '夜深了'
  if (hour < 9) return '早上好'
  if (hour < 12) return '上午好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

function dynamicOverviewSubtitle(params: {
  runningJobs: number
  queuedJobs: number
  atRiskCount: number
  activeProjectsCount: number
  totalReportVersions: number
  weeklyNewReports: number
  averageAiScore: number
  hasProjects: boolean
  hasReports: boolean
}) {
  const {
    runningJobs,
    queuedJobs,
    atRiskCount,
    activeProjectsCount,
    totalReportVersions,
    weeklyNewReports,
    averageAiScore,
    hasProjects,
    hasReports,
  } = params

  if (!hasProjects) {
    return '当前暂无在研课题，建议创建新课题以开启全流程分析与报告追踪。'
  }
  if (!hasReports) {
    return `已纳管 ${activeProjectsCount} 个在研课题，上传首份报告即可自动触发全维度 AI 深度分析。`
  }
  const pendingJobs = runningJobs + queuedJobs
  if (pendingJobs > 0) {
    return `当前有 ${pendingJobs} 个分析任务正在处理中，分析结果与质量评分将实时同步。`
  }
  if (atRiskCount > 0) {
    return `共有 ${activeProjectsCount} 个在研课题，其中 ${atRiskCount} 个课题评分偏低或存在风险，建议优先查阅。`
  }
  if (weeklyNewReports > 0) {
    return `近 7 天已更新 ${weeklyNewReports} 版报告，平均 AI 分析得分为 ${averageAiScore ? `${averageAiScore} 分` : '--'}，研究进展活跃。`
  }
  if (averageAiScore >= 80) {
    return `在研课题整体质量表现优秀（平均 ${averageAiScore} 分），持续为研究决策提供高质量支撑。`
  }
  return `全库纳管 ${activeProjectsCount} 个在研课题与 ${totalReportVersions} 版研报，AI 深度分析与质量全景保持最新。`
}

function HeroTrendMark({ direction }: { direction: TrendDirection }) {
  const meta = direction === 'up'
    ? { icon: TrendingUp, label: '上升' }
    : direction === 'down'
      ? { icon: TrendingDown, label: '下降' }
      : { icon: Minus, label: '持平' }
  const Icon = meta.icon
  return (
    <span className="inline-flex" title={`近 7 日${meta.label}`} aria-label={`近 7 日${meta.label}`}>
      <Icon className="h-3.5 w-3.5 text-white" />
    </span>
  )
}

function runningAverageTrend(events: Array<{ at: string; value: number }>) {
  return runningAverageValues(events).map((value) => Math.round(value))
}

/** 与顶部指标卡一致的底部面板容器：无描边白卡 + 悬停提升。 */
const PANEL_SHELL = 'relative overflow-hidden rounded-lg border border-yx-line bg-yx-paper p-5 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-[border-color,box-shadow] duration-200 hover:border-yx-brand/25 hover:shadow-[0_12px_28px_-14px_color-mix(in srgb, var(--yx-brand-strong) 25%, transparent)]'

type PanelKind = 'quality' | 'reports' | 'knowledge'

/** 右下角主题插画：与报告版本总数等指标卡同一位置、同一透明度。 */
function PanelDecoration({ kind }: { kind: PanelKind }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <CardAura showTopHighlight={false} />

      {kind === 'quality' ? (
        <svg className="absolute -bottom-1 right-1.5 h-[3.75rem] w-[3.75rem] text-yx-brand/42" viewBox="0 0 56 56" fill="none">
          <circle cx="28" cy="28" r="20" stroke="currentColor" strokeWidth="1.3" opacity="0.35" />
          <circle cx="28" cy="28" r="13.5" stroke="currentColor" strokeWidth="1.3" opacity="0.55" />
          <circle cx="28" cy="28" r="7" fill="color-mix(in srgb, var(--yx-brand) 10%, transparent)" stroke="currentColor" strokeWidth="1.3" />
          <path d="M28 8v40M8 28h40" stroke="currentColor" strokeWidth="1" opacity="0.22" />
          <path d="M28 14 36.5 26.5 28 39 19.5 26.5Z" fill="color-mix(in srgb, var(--yx-brand) 14%, transparent)" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          <circle cx="28" cy="26.5" r="2.1" fill="currentColor" />
        </svg>
      ) : null}

      {kind === 'reports' ? (
        <svg className="absolute -bottom-1.5 -right-1 h-[3.75rem] w-[3.75rem] text-yx-brand/45" viewBox="0 0 56 56" fill="none">
          <rect x="10" y="10" width="26" height="32" rx="5" transform="rotate(-14 23 26)" fill="color-mix(in srgb, var(--yx-brand) 8%, transparent)" stroke="currentColor" strokeWidth="1.4" />
          <rect x="14" y="10" width="26" height="32" rx="5" transform="rotate(-5 27 26)" fill="color-mix(in srgb, var(--yx-brand) 10%, transparent)" stroke="currentColor" strokeWidth="1.4" />
          <rect x="18" y="12" width="26" height="32" rx="5" fill="var(--yx-brand-soft)" stroke="currentColor" strokeWidth="1.4" />
          <path d="M24 22h14M24 27h10M24 32h12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.55" />
        </svg>
      ) : null}

      {kind === 'knowledge' ? (
        <svg className="absolute -bottom-0.5 right-1 h-12 w-14 text-yx-brand/42" viewBox="0 0 56 48" fill="none">
          <path d="M28 12v26" stroke="currentColor" strokeWidth="1.3" />
          <path d="M28 12c-7-4.5-18-4-22 1v25c5-4.5 15-5 22 .5 7-5.5 17-5 22-.5V13c-4-5-15-5.5-22-1Z" fill="color-mix(in srgb, var(--yx-brand) 8%, transparent)" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M14 20h9M14 25h7M33 20h9M33 25h7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" opacity="0.55" />
        </svg>
      ) : null}
    </div>
  )
}

/** 迷你数量磁贴：色点标签 + 大数字 + 右侧走势。 */
function MiniCountTile({
  label,
  count,
  unit,
  dotClass,
  chart,
}: {
  label: string
  count: number
  unit: string
  dotClass: string
  chart?: ReactNode
}) {
  return (
    <div className="flex items-end justify-between gap-1.5 rounded-xl bg-yx-surface px-2.5 py-2 ring-1 ring-inset ring-black/[0.02]">
      <div className="min-w-0">
        <span className="flex items-center gap-1.5 text-[9px] font-medium text-yx-muted"><span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />{label}</span>
        <div className="mt-1 leading-none tabular-nums text-yx-ink"><span className="text-base font-bold">{count}</span><span className="ml-1 align-middle text-[8.5px] font-medium text-yx-faint">{unit}</span></div>
      </div>
      {chart}
    </div>
  )
}

/** 磁贴内嵌迷你折线，适配约 120px 宽的双列格子。 */
function MiniSparkline({
  points,
  gradientId,
  label,
  stroke = 'var(--yx-brand)',
}: {
  points: number[]
  gradientId: string
  label: string
  stroke?: string
}) {
  const width = 48
  const height = 20
  const pad = 1.5
  const values = points.length > 1 ? points : points.length === 1 ? [points[0], points[0]] : [0, 0]
  const min = Math.min(...values)
  const max = Math.max(...values)
  const flat = max === min
  const range = flat ? 1 : max - min
  const coords = values.map((point, index) => {
    const x = pad + (index * (width - pad * 2)) / (values.length - 1)
    const y = flat ? height / 2 : height - pad - ((point - min) / range) * (height - pad * 2)
    return [x, y] as const
  })
  const linePath = coords.map((coord, index) => (index === 0 ? 'M' : 'L') + coord[0].toFixed(1) + ',' + coord[1].toFixed(1)).join(' ')
  const areaPath = linePath + ' L' + coords[coords.length - 1][0].toFixed(1) + ',' + height + ' L' + coords[0][0].toFixed(1) + ',' + height + ' Z'
  const last = coords[coords.length - 1]
  const hasData = points.some((point) => point > 0)

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="mb-0.5 h-5 w-12 shrink-0 overflow-visible" role="img" aria-label={label}>
      <title>{label}</title>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      {hasData && <path d={areaPath} fill={`url(#${gradientId})`} />}
      <path d={linePath} fill="none" stroke={hasData ? stroke : 'var(--yx-line)'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray={hasData ? undefined : '2 3'} />
      {hasData && <circle cx={last[0]} cy={last[1]} r="1.8" fill={stroke} stroke="var(--yx-paper)" strokeWidth="0.9" />}
    </svg>
  )
}

/** 面板内嵌指标行：与顶部「报告版本总数」卡片同一套数字 + 走势图结构。 */
function MetricSparkRow({
  label,
  value,
  helper,
  valueClassName = 'text-yx-ink',
  chart,
}: {
  label: string
  value: string
  helper: string
  valueClassName?: string
  chart: ReactNode
}) {
  return (
    <div className="mt-3">
      <span className="text-[10px] font-semibold text-yx-muted">{label}</span>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div className={`text-[24px] font-bold leading-none tracking-tight tabular-nums ${valueClassName}`}>{value}</div>
        {chart}
      </div>
      <div className="mt-1.5 truncate text-[9.5px] text-yx-faint" title={helper}>{helper}</div>
    </div>
  )
}

/** 报告质量折线：真实呈现最近可用评分，数据不足时仍保持稳定布局。 */
function PanelTrendChart({ points, gradientId, label }: { points: number[]; gradientId: string; label: string }) {
  const width = 96
  const height = 28
  const pad = 2
  const values = points.length > 1 ? points : points.length === 1 ? [points[0], points[0]] : [0, 0]
  const min = Math.min(...values)
  const max = Math.max(...values)
  const flat = max === min
  const range = flat ? 1 : max - min
  const coords = values.map((point, index) => {
    const x = pad + (index * (width - pad * 2)) / (values.length - 1)
    const y = flat ? height / 2 : height - pad - ((point - min) / range) * (height - pad * 2)
    return [x, y] as const
  })
  const linePath = coords.map((coord, index) => (index === 0 ? 'M' : 'L') + coord[0].toFixed(1) + ',' + coord[1].toFixed(1)).join(' ')
  const areaPath = linePath + ' L' + coords[coords.length - 1][0].toFixed(1) + ',' + height + ' L' + coords[0][0].toFixed(1) + ',' + height + ' Z'
  const last = coords[coords.length - 1]
  const hasData = points.length > 0

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-7 w-[5.5rem] shrink-0 overflow-visible" role="img" aria-label={label}>
      <title>{label}</title>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--yx-brand)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--yx-brand)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {hasData && <path d={areaPath} fill={`url(#${gradientId})`} />}
      <path d={linePath} fill="none" stroke={hasData ? 'var(--yx-brand)' : 'var(--yx-line)'} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" strokeDasharray={hasData ? undefined : '3 3'} />
      {hasData && <circle cx={last[0]} cy={last[1]} r="2.2" fill="var(--yx-brand-hover)" stroke="var(--yx-paper)" strokeWidth="1" />}
    </svg>
  )
}

/** 知识沉淀柱图：复用后端近 7 日累计趋势，空数据也显示基线而非塌陷。 */
function PanelBarChart({ points, label }: { points: number[]; label: string }) {
  const values = points.length ? points.slice(-7) : [0, 0, 0, 0, 0, 0, 0]
  const max = Math.max(...values, 1)
  const width = 96
  const height = 28
  const chartBottom = 26
  const barWidth = 7
  const gap = (width - values.length * barWidth) / Math.max(values.length - 1, 1)

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-7 w-[5.5rem] shrink-0 overflow-visible" role="img" aria-label={label}>
      <title>{label}</title>
      {values.map((point, index) => {
        const barHeight = point > 0 ? Math.max(5, (point / max) * 22) : 3
        const x = index * (barWidth + gap)
        return <rect key={index} x={x} y={chartBottom - barHeight} width={barWidth} height={barHeight} rx="3.5" fill="var(--yx-brand)" opacity={0.22 + ((index + 1) / values.length) * 0.6} />
      })}
    </svg>
  )
}

type StatCardKind = 'versions' | 'characters' | 'success' | 'knowledge'

function StatCardDecoration({ kind }: { kind: StatCardKind }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <CardAura showTopHighlight={false} />

      {kind === 'versions' ? (
        <svg className="absolute -bottom-1.5 -right-1 h-[3.75rem] w-[3.75rem] text-yx-brand/45" viewBox="0 0 56 56" fill="none">
          <rect x="10" y="10" width="26" height="32" rx="5" transform="rotate(-14 23 26)" fill="color-mix(in srgb, var(--yx-brand) 8%, transparent)" stroke="currentColor" strokeWidth="1.4" />
          <rect x="14" y="10" width="26" height="32" rx="5" transform="rotate(-5 27 26)" fill="color-mix(in srgb, var(--yx-brand) 10%, transparent)" stroke="currentColor" strokeWidth="1.4" />
          <rect x="18" y="12" width="26" height="32" rx="5" fill="var(--yx-brand-soft)" stroke="currentColor" strokeWidth="1.4" />
          <path d="M24 22h14M24 27h10M24 32h12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.55" />
        </svg>
      ) : null}

      {kind === 'characters' ? (
        <svg className="absolute bottom-1.5 right-1.5 h-12 w-12 text-yx-brand/40" viewBox="0 0 48 48" fill="none">
          <rect x="10" y="6" width="28" height="36" rx="5" fill="color-mix(in srgb, var(--yx-brand) 7%, transparent)" stroke="currentColor" strokeWidth="1.4" />
          <path d="M16 16h16M16 22h16M16 28h11M16 34h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      ) : null}

      {kind === 'success' ? (
        <svg className="absolute bottom-1.5 right-1.5 h-12 w-12 text-yx-brand/40" viewBox="0 0 48 48" fill="none">
          <rect x="12" y="10" width="24" height="32" rx="5" fill="color-mix(in srgb, var(--yx-brand) 7%, transparent)" stroke="currentColor" strokeWidth="1.4" />
          <rect x="18" y="7" width="12" height="6" rx="2" fill="var(--yx-brand-soft)" stroke="currentColor" strokeWidth="1.3" />
          <path d="M17 22.5 19.5 25 24 20M17 31.5 19.5 34 24 29" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M27 23h6M27 32h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.55" />
        </svg>
      ) : null}

      {kind === 'knowledge' ? (
        <svg className="absolute -bottom-0.5 right-1 h-12 w-14 text-yx-brand/42" viewBox="0 0 56 48" fill="none">
          <path d="M28 12v26" stroke="currentColor" strokeWidth="1.3" />
          <path d="M28 12c-7-4.5-18-4-22 1v25c5-4.5 15-5 22 .5 7-5.5 17-5 22-.5V13c-4-5-15-5.5-22-1Z" fill="color-mix(in srgb, var(--yx-brand) 8%, transparent)" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M14 20h9M14 25h7M33 20h9M33 25h7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" opacity="0.55" />
        </svg>
      ) : null}
    </div>
  )
}

function StatTrendSparkline({ points, gradientId }: { points: number[]; gradientId: string }) {
  const width = 96
  const height = 28
  const pad = 2
  if (points.length < 2) return null
  const min = Math.min(...points)
  const max = Math.max(...points)
  const flat = max === min
  const range = flat ? 1 : max - min
  const coords = points.map((point, index) => {
    const x = pad + (index * (width - pad * 2)) / (points.length - 1)
    const y = flat ? height / 2 : height - pad - ((point - min) / range) * (height - pad * 2)
    return [x, y] as const
  })
  const linePath = coords.map((c, i) => (i === 0 ? 'M' : 'L') + c[0].toFixed(1) + ',' + c[1].toFixed(1)).join(' ')
  const areaPath = linePath + ' L' + coords[coords.length - 1][0].toFixed(1) + ',' + height + ' L' + coords[0][0].toFixed(1) + ',' + height + ' Z'
  const last = coords[coords.length - 1]
  return (
    <svg viewBox={'0 0 ' + width + ' ' + height} className="h-7 w-[5.5rem] max-w-[46%] shrink-0 overflow-visible" aria-label="近 7 日趋势">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--yx-brand)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--yx-brand)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={'url(#' + gradientId + ')'} />
      <path d={linePath} fill="none" stroke="var(--yx-brand)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="2.2" fill="var(--yx-brand-hover)" stroke="var(--yx-paper)" strokeWidth="1" />
    </svg>
  )
}

export function OverviewWorkspace({
  projects,
  stats: overviewStats,
  recentReports,
  activityReports,
  knowledgeItems,
  upstreamError,
  userName,
  onSelect,
  onNavigate,
  onOpenReport,
}: {
  projects: ProjectWithCapabilities[]
  stats?: OverviewStats
  recentReports: ReportWithProject[]
  activityReports: ReportWithProject[]
  knowledgeItems: KnowledgeItem[]
  upstreamError?: string
  userName?: string
  onSelect: (project: ProjectWithCapabilities) => void
  onNavigate: (nav: 'reports' | 'knowledge') => void
  onOpenReport: (report: ReportWithProject, project: ProjectWithCapabilities) => void
}) {
  const analyzedProjects = useMemo(() => projects.filter((project) => project.latestReport?.aiScore !== undefined), [projects])
  const { averageAiScore, averageCompleteness } = useMemo(() => {
    if (!analyzedProjects.length) return { averageAiScore: 0, averageCompleteness: 0 }
    const totals = analyzedProjects.reduce((result, project) => ({
      aiScore: result.aiScore + (project.latestReport?.aiScore ?? 0),
      completeness: result.completeness + (project.latestReport?.completeness ?? 0),
    }), { aiScore: 0, completeness: 0 })
    return {
      averageAiScore: Math.round(totals.aiScore / analyzedProjects.length),
      averageCompleteness: Math.round(totals.completeness / analyzedProjects.length),
    }
  }, [analyzedProjects])
  const reportsByProject = useMemo(() => {
    const result = new Map<string, ReportWithProject[]>()
    for (const report of activityReports) {
      const reports = result.get(report.projectId)
      if (reports) reports.push(report)
      else result.set(report.projectId, [report])
    }
    return result
  }, [activityReports])

  const qualityBands = useMemo(() => {
    const bands: Record<QualityBand, ProjectWithCapabilities[]> = { excellent: [], good: [], weak: [], unanalyzed: [] }
    for (const project of projects) bands[qualityBandOf(project.latestReport?.aiScore)].push(project)
    return bands
  }, [projects])

  const { analyzedTrend, unanalyzedTrend } = useMemo(() => {
    const analyzed = overviewStats?.trends.analyzedProjects
      ?? cumulativeTrend(projects.flatMap((project) => project.latestReport?.aiScore === undefined ? [] : [{ at: project.updatedAt, value: 1 }]))
    const created = cumulativeTrend(projects.map((project) => ({ at: project.createdAt, value: 1 })))
    return {
      analyzedTrend: analyzed,
      unanalyzedTrend: created.map((total, index) => Math.max(0, total - (analyzed[index] ?? 0))),
    }
  }, [overviewStats?.trends.analyzedProjects, projects])

  const { bestProject, weakestProject } = useMemo(() => ({
    bestProject: analyzedProjects.reduce<ProjectWithCapabilities | undefined>((best, project) => (best && (best.latestReport?.aiScore ?? 0) >= (project.latestReport?.aiScore ?? 0) ? best : project), undefined),
    weakestProject: analyzedProjects.reduce<ProjectWithCapabilities | undefined>((weakest, project) => (weakest && (weakest.latestReport?.aiScore ?? 100) <= (project.latestReport?.aiScore ?? 100) ? weakest : project), undefined),
  }), [analyzedProjects])

  const recentKnowledge = useMemo(() => knowledgeItems.slice(0, 4), [knowledgeItems])
  const recentProjectActivities = useMemo(
    () => projects.reduce<ProjectActivity[]>((recent, project) => {
      const activity = latestProjectActivity(project, reportsByProject.get(project.id) ?? [])
      const insertAt = recent.findIndex((item) => item.at < activity.at)
      if (insertAt < 0 && recent.length >= 4) return recent
      recent.splice(insertAt < 0 ? recent.length : insertAt, 0, activity)
      if (recent.length > 4) recent.pop()
      return recent
    }, []),
    [projects, reportsByProject],
  )
  const recentReportScores = useMemo(() => recentReports
    .flatMap((report) => report.aiScore === undefined ? [] : [report.aiScore])
    .reverse(), [recentReports])
  const recentReportAverage = recentReportScores.length
    ? Math.round(recentReportScores.reduce((total, score) => total + score, 0) / recentReportScores.length)
    : undefined
  const loadedKnowledgeCategoryCount = useMemo(() => new Set(knowledgeItems.map((item) => item.category).filter(Boolean)).size, [knowledgeItems])
  const knowledgeCategoryCount = overviewStats?.knowledgeCategoryCount ?? loadedKnowledgeCategoryCount
  const knowledgeTotal = overviewStats?.knowledgeCount ?? knowledgeItems.length
  const activeProjects = useMemo(() => projects.filter((project) => project.status !== 'completed'), [projects])
  const atRiskProjects = useMemo(() => projects.filter((project) => project.status === 'at_risk'), [projects])
  const atRiskCount = atRiskProjects.length
  const loadedWeeklyNewReports = useMemo(() => {
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000
    return recentReports.filter((report) => new Date(report.createdAt).getTime() >= weekAgo).length
  }, [recentReports])
  const loadedWeeklyNewKnowledge = useMemo(() => {
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000
    return knowledgeItems.filter((item) => new Date(item.createdAt).getTime() >= weekAgo).length
  }, [knowledgeItems])
  const weeklyNewReports = overviewStats?.weeklyNewReports ?? loadedWeeklyNewReports
  const weeklyNewKnowledge = overviewStats?.weeklyNewKnowledge ?? loadedWeeklyNewKnowledge
  const jobTotal = overviewStats ? overviewStats.jobStats.completed + overviewStats.jobStats.failed + overviewStats.jobStats.cancelled : 0
  const jobSuccessRate = overviewStats && jobTotal ? Math.round((overviewStats.jobStats.completed / jobTotal) * 100) : undefined

  const now = new Date()
  const weekDay = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()]
  const heroTrendByLabel = useMemo(() => {
    const activeSeries = cumulativeTrend(activeProjects.map((project) => ({ at: project.createdAt, value: 1 })))
    const atRiskSeries = cumulativeTrend(atRiskProjects.map((project) => ({ at: project.updatedAt, value: 1 })))
    const scoreSeries = overviewStats?.trends.averageScore
      ?? runningAverageTrend(recentReports.flatMap((report) => report.aiScore === undefined ? [] : [{ at: report.createdAt, value: report.aiScore }]))
    return {
      在研课题: trendDirectionOf(activeSeries),
      报告版本: trendDirectionOf(overviewStats?.trends?.versions ?? []),
      平均AI评分: analyzedProjects.length ? trendDirectionOf(scoreSeries) : 'flat' as const,
      需关注: trendDirectionOf(atRiskSeries),
    }
  }, [activeProjects, analyzedProjects.length, atRiskProjects, overviewStats?.trends.averageScore, overviewStats?.trends.versions, recentReports])
  const heroKpis = [
    { label: '在研课题', value: String(activeProjects.length), trend: heroTrendByLabel.在研课题 },
    { label: '报告版本', value: String(overviewStats?.totalReportVersions ?? 0), trend: heroTrendByLabel.报告版本 },
    { label: '平均AI评分', value: analyzedProjects.length ? String(averageAiScore) : '--', trend: heroTrendByLabel.平均AI评分 },
    { label: '需关注', value: String(atRiskCount), highlight: atRiskCount > 0, trend: heroTrendByLabel.需关注 },
  ]

  const trendByKind: Record<StatCardKind, number[]> = {
    versions: overviewStats?.trends?.versions ?? [],
    characters: overviewStats?.trends?.characters ?? [],
    success: overviewStats?.trends?.successRate ?? [],
    knowledge: overviewStats?.trends?.knowledge ?? [],
  }

  const statCards = [
    { kind: 'versions' as const, label: '报告版本总数', value: String(overviewStats?.totalReportVersions ?? 0).padStart(2, '0'), helper: weeklyNewReports ? `近 7 天新增 ${weeklyNewReports} 版` : '累计上传的报告版本' },
    { kind: 'characters' as const, label: '累计报告字数', value: formatCharacters(overviewStats?.totalCharacters ?? 0), helper: '全部报告字符数总和' },
    { kind: 'success' as const, label: '分析任务成功率', value: jobSuccessRate === undefined ? '--' : `${jobSuccessRate}%`, helper: overviewStats ? `成功 ${overviewStats.jobStats.completed} · 失败 ${overviewStats.jobStats.failed} · 取消 ${overviewStats.jobStats.cancelled}${overviewStats.jobStats.running ? ` · 运行中 ${overviewStats.jobStats.running}` : ''}${overviewStats.jobStats.queued ? ` · 排队中 ${overviewStats.jobStats.queued}` : ''}` : '加载中' },
    { kind: 'knowledge' as const, label: '知识库资料', value: String(overviewStats?.knowledgeCount ?? knowledgeItems.length).padStart(2, '0'), helper: '行业研报与政策文件' },
  ]

  const dynamicSubtitle = useMemo(() => {
    return dynamicOverviewSubtitle({
      runningJobs: overviewStats?.jobStats.running ?? 0,
      queuedJobs: overviewStats?.jobStats.queued ?? 0,
      atRiskCount,
      activeProjectsCount: activeProjects.length,
      totalReportVersions: overviewStats?.totalReportVersions ?? recentReports.length,
      weeklyNewReports,
      averageAiScore,
      hasProjects: projects.length > 0,
      hasReports: (overviewStats?.totalReportVersions ?? recentReports.length) > 0,
    })
  }, [
    overviewStats?.jobStats.running,
    overviewStats?.jobStats.queued,
    overviewStats?.totalReportVersions,
    atRiskCount,
    activeProjects.length,
    recentReports.length,
    weeklyNewReports,
    averageAiScore,
    projects.length,
  ])

  return (
    <div className="space-y-6">
      <h1 className="sr-only">总览</h1>
      {upstreamError && <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">{upstreamError}</div>}
      {/* ═══ 英雄区：品牌渐变横幅 ═══ */}
      <section aria-label="工作概览" className="relative overflow-hidden rounded-xl bg-gradient-to-br from-yx-brand-deep via-yx-brand-strong to-yx-brand px-6 py-7 text-white shadow-[0_20px_50px_-20px_color-mix(in srgb, var(--yx-brand-strong) 55%, transparent)] sm:px-9 sm:py-8">
        <div className="pointer-events-none absolute inset-0 opacity-[0.12]" style={{ backgroundImage: 'radial-gradient(rgba(255,255,255,0.9) 1px, transparent 1px)', backgroundSize: '20px 20px' }} />
        <div className="pointer-events-none absolute -right-20 -top-28 h-72 w-72 rounded-full bg-white/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 right-40 h-52 w-52 rounded-full border border-white/15" />
        <div className="pointer-events-none absolute -bottom-10 right-24 h-28 w-28 rounded-full border border-white/10" />

        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-white/70">{now.getFullYear()} 年 {now.getMonth() + 1} 月 {now.getDate()} 日 · 星期{weekDay}</p>
            <h2 className="mt-2.5 text-2xl font-bold tracking-tight sm:text-[28px]">{greetingOf(now)}{userName ? `，${userName}` : ''}</h2>
            <p className="mt-1.5 max-w-xl text-[12.5px] leading-6 text-white/80">{dynamicSubtitle}</p>
            <div className="mt-5 flex flex-wrap items-center gap-2.5">
              <button type="button" onClick={() => onNavigate('reports')} className="flex items-center gap-1.5 rounded-full bg-yx-paper px-4 py-2 text-[11px] font-bold text-yx-brand-hover shadow-lg shadow-black/10 transition-colors hover:bg-white/80"><ArrowUpRight className="h-3.5 w-3.5 text-yx-brand-hover" />进入报告库</button>
              <button type="button" onClick={() => onNavigate('knowledge')} className="flex items-center gap-1.5 rounded-full border border-white/25 bg-white/10 px-4 py-2 text-[11px] font-semibold text-white backdrop-blur transition-colors hover:bg-white/20">进入知识库<ArrowUpRight className="h-3.5 w-3.5 text-white" /></button>
            </div>
          </div>
          <div className="flex shrink-0 divide-x divide-white/15 rounded-lg border border-white/15 bg-white/[0.07] backdrop-blur-sm">
            {heroKpis.map((kpi) => (
              <div key={kpi.label} className="px-4 py-3.5 text-center sm:px-6">
                <div className="flex items-center justify-center gap-1.5">
                  <div className={`text-xl font-bold tabular-nums sm:text-2xl ${kpi.highlight ? 'text-amber-300' : 'text-white'}`}>{kpi.value}</div>
                  <HeroTrendMark direction={kpi.trend} />
                </div>
                <div className="mt-0.5 text-[9.5px] font-medium tracking-wide text-white/70">{kpi.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ 趋势指标卡 ═══ */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
        {statCards.map((stat) => (
          <div key={stat.label} className="relative overflow-hidden rounded-lg border border-yx-line bg-yx-paper p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-[border-color,box-shadow] duration-200 hover:border-yx-brand/25 hover:shadow-[0_12px_28px_-14px_color-mix(in srgb, var(--yx-brand-strong) 25%, transparent)]">
            <StatCardDecoration kind={stat.kind} />
            <div className="relative z-10">
              <span className="text-[10px] font-semibold text-yx-muted">{stat.label}</span>
              <div className="mt-2 flex items-end gap-6 pr-6">
                <div className="text-[24px] font-bold leading-none tracking-tight text-yx-ink tabular-nums">{stat.value}</div>
                <StatTrendSparkline points={trendByKind[stat.kind]} gradientId={"yxStatTrend-" + stat.kind} />
              </div>
              <div className="mt-1.5 truncate pr-12 text-[9.5px] text-yx-faint" title={stat.helper}>{stat.helper}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 items-stretch gap-3 sm:gap-4 xl:grid-cols-4">
          {/* 分析质量全景 */}
          <section aria-label="分析质量全景" className={`${PANEL_SHELL} col-span-2 h-full`}>
            <PanelDecoration kind="quality" />
            <div className="relative z-10 pb-6">
            <SectionHeader icon={Sparkles} title="分析质量全景" compact badge={projects.length ? `已分析 ${analyzedProjects.length}/${projects.length}` : undefined} />
            <div className="mt-4 flex items-center gap-4">
              <ScoreGauge value={analyzedProjects.length ? averageAiScore : 0} empty={!analyzedProjects.length} />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="rounded-xl bg-yx-brand-soft/60 px-3 py-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[9px] font-semibold tracking-wide text-yx-muted">平均完整度</span>
                    <span className="text-lg font-bold leading-none tabular-nums text-yx-ink">{analyzedProjects.length ? `${averageCompleteness}%` : '--'}</span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/90">
                    <div className="h-full rounded-full bg-gradient-to-r from-yx-brand-bright to-yx-brand-hover transition-all duration-500" style={{ width: `${analyzedProjects.length ? Math.min(Math.max(averageCompleteness, 0), 100) : 0}%` }} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <MiniCountTile
                    label="已分析"
                    count={analyzedProjects.length}
                    unit="个课题"
                    dotClass="bg-yx-brand"
                    chart={<MiniSparkline points={analyzedTrend} gradientId="yxAnalyzedTrend" label="近 7 日已分析课题累计走势" />}
                  />
                  <MiniCountTile
                    label="待分析"
                    count={qualityBands.unanalyzed.length}
                    unit="个课题"
                    dotClass="bg-yx-line"
                    chart={<MiniSparkline points={unanalyzedTrend} gradientId="yxUnanalyzedTrend" label="近 7 日待分析课题累计走势" stroke="var(--yx-faint)" />}
                  />
                </div>
              </div>
            </div>

            <div className="mt-5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[10px] font-bold text-yx-ink">质量分布</span>
                <span className="text-[8.5px] text-yx-faint">按各课题最新报告评分</span>
              </div>
              <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-yx-line ring-1 ring-inset ring-black/[0.03]">
                {(Object.keys(qualityBandMeta) as QualityBand[]).map((band) => {
                  const count = qualityBands[band].length
                  if (!count || !projects.length) return null
                  return <span key={band} className={`h-full transition-all duration-500 ${qualityBandMeta[band].bar}`} style={{ width: `${(count / projects.length) * 100}%` }} title={`${qualityBandMeta[band].label}：${count}`} />
                })}
              </div>
              <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
                {(Object.keys(qualityBandMeta) as QualityBand[]).map((band) => {
                  const count = qualityBands[band].length
                  const pct = projects.length ? Math.round((count / projects.length) * 100) : 0
                  return (
                    <li key={band} className="flex min-w-0 items-center gap-1.5 text-[9.5px]">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${qualityBandMeta[band].dot}`} />
                      <span className="min-w-0 flex-1 truncate text-yx-muted">{qualityBandMeta[band].label}</span>
                      <span className={`font-bold tabular-nums ${qualityBandMeta[band].text}`}>{count}</span>
                      <span className="w-8 text-right text-[8.5px] tabular-nums text-yx-faint">{pct}%</span>
                    </li>
                  )
                })}
              </ul>
            </div>

            {(bestProject || weakestProject) && (
              <div className="mt-4 space-y-1 border-t border-yx-hover pt-3">
                {bestProject && (
                  <button type="button" onClick={() => onSelect(bestProject)} className="group flex w-full items-center gap-2.5 rounded-xl px-1.5 py-1.5 text-left transition-colors hover:bg-yx-brand-soft">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-yx-brand"><TrendingUp className="h-3.5 w-3.5 text-white" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] font-semibold text-yx-ink transition-colors group-hover:text-yx-brand-hover" title={bestProject.title}>{bestProject.title}</span>
                      <span className="mt-0.5 block text-[8.5px] text-yx-faint">质量标杆 · 评分最高</span>
                    </span>
                    <span className="shrink-0 rounded-full bg-yx-brand-soft px-2 py-0.5 text-[11px] font-bold tabular-nums text-yx-brand-hover">{formatMetric(bestProject.latestReport?.aiScore)}</span>
                    <ArrowUpRight className="h-3 w-3 shrink-0 text-yx-faint transition-colors group-hover:text-yx-brand-hover" />
                  </button>
                )}
                {weakestProject && weakestProject.id !== bestProject?.id && (
                  <button type="button" onClick={() => onSelect(weakestProject)} className="group flex w-full items-center gap-2.5 rounded-xl px-1.5 py-1.5 text-left transition-colors hover:bg-amber-50/80">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-yx-warning"><AlertTriangle className="h-3.5 w-3.5 text-white" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] font-semibold text-yx-ink transition-colors group-hover:text-yx-warning-text" title={weakestProject.title}>{weakestProject.title}</span>
                      <span className="mt-0.5 block text-[8.5px] text-yx-faint">重点关注 · 评分待提升</span>
                    </span>
                    <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-bold tabular-nums text-yx-warning-text">{formatMetric(weakestProject.latestReport?.aiScore)}</span>
                    <ArrowUpRight className="h-3 w-3 shrink-0 text-yx-faint transition-colors group-hover:text-yx-warning-text" />
                  </button>
                )}
              </div>
            )}
            </div>
          </section>

          {/* 最新报告动态 */}
          <section aria-label="最新报告动态" className={`${PANEL_SHELL} col-span-2 h-full sm:col-span-1`}>
            <PanelDecoration kind="reports" />
            <div className="relative z-10 flex h-full flex-col pb-8">
            <SectionHeader icon={Layers3} title="最新报告动态" compact action={(
              <button type="button" onClick={() => onNavigate('reports')} className="flex items-center gap-0.5 text-[10px] font-semibold text-yx-muted transition-colors hover:text-yx-brand-hover">报告库<ArrowRight className="h-3 w-3" /></button>
            )} />
            <MetricSparkRow
              label={recentReports.length ? `近 ${recentReports.length} 版平均分` : '近期平均分'}
              value={formatMetric(recentReportAverage)}
              helper={recentReportScores.length ? `${recentReportScores.length} 版已分析` : weeklyNewReports ? `近 7 天新增 ${weeklyNewReports} 版` : '上传报告后将显示评分走势'}
              valueClassName={scoreTextClass(recentReportAverage)}
              chart={<PanelTrendChart points={recentReportScores} gradientId="yxRecentReportScoreTrend" label={`最近 ${recentReportScores.length} 版报告评分趋势`} />}
            />
            {recentProjectActivities.length ? (
              <ul className="mt-3 space-y-0.5 border-t border-yx-hover pt-2">
                {recentProjectActivities.map((activity) => {
                  const Icon = projectActivityMeta[activity.kind].icon
                  return (
                    <li key={activity.id}>
                      <button
                        type="button"
                        onClick={() => { if (activity.report) onOpenReport(activity.report, activity.project); else onSelect(activity.project) }}
                        className="group flex w-full items-center gap-2.5 rounded-xl px-1.5 py-2 text-left transition-colors hover:bg-yx-surface"
                      >
                        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-transform duration-200 group-hover:scale-105 ${projectActivityMeta[activity.kind].iconWrap}`}>
                          <Icon className={projectActivityMeta[activity.kind].iconClass} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11.5px] font-semibold text-yx-ink" title={activity.project.title}>{activity.project.title}</span>
                          <span className="mt-0.5 block truncate text-[9px] text-yx-faint">{activity.label} · {activity.detail} · {formatRelativeTime(activity.at)}</span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <EmptyState icon={Layers3} description="暂无课题动态，上传报告、更新课题或开始分析后将在此呈现。" className="mt-2 min-h-[8.5rem] flex-1 border-yx-line bg-yx-surface py-4" />
            )}
            </div>
          </section>

          {/* 知识库动态 */}
          <section aria-label="知识库动态" className={`${PANEL_SHELL} col-span-2 h-full sm:col-span-1`}>
            <PanelDecoration kind="knowledge" />
            <div className="relative z-10 flex h-full flex-col pb-8">
            <SectionHeader icon={BookOpen} title="知识库动态" compact action={(
              <button type="button" onClick={() => onNavigate('knowledge')} className="flex items-center gap-0.5 text-[10px] font-semibold text-yx-muted transition-colors hover:text-yx-brand-hover">知识库<ArrowRight className="h-3 w-3" /></button>
            )} />
            <MetricSparkRow
              label="资料规模"
              value={String(knowledgeTotal).padStart(2, '0')}
              helper={weeklyNewKnowledge ? `近 7 天新增 ${weeklyNewKnowledge} 份 · ${knowledgeCategoryCount} 个分类` : knowledgeCategoryCount ? `${knowledgeCategoryCount} 个分类 · 行业研报与政策文件` : '行业研报与政策文件'}
              chart={<PanelBarChart points={trendByKind.knowledge} label="近 7 日知识库资料累计趋势" />}
            />
            {recentKnowledge.length ? (
              <ul className="mt-3 space-y-0.5 border-t border-yx-hover pt-2">
                {recentKnowledge.map((item) => (
                  <li key={item.id}>
                    <button type="button" onClick={() => onNavigate('knowledge')} className="group flex w-full items-center gap-2.5 rounded-xl px-1.5 py-2 text-left transition-colors hover:bg-yx-surface">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-yx-brand transition-transform duration-200 group-hover:scale-105"><BookOpen className="h-3.5 w-3.5 text-white" /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11.5px] font-semibold text-yx-ink" title={item.title}>{item.title}</span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-[9px] text-yx-faint"><span className="rounded-full bg-yx-hover px-1.5 py-0.5 text-[8px] font-medium text-yx-muted">{item.category}</span>{item.uploadedBy} · {formatDate(item.createdAt)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={BookOpen} description="暂无参考资料，进入知识库上传行业研报与政策文件。" className="mt-2 min-h-[8.5rem] flex-1 border-yx-line bg-yx-surface py-4" />
            )}
            </div>
          </section>
      </div>
    </div>
  )
}

function SectionHeader({ icon: Icon, title, badge, action, compact = false }: { icon: React.ComponentType<{ className?: string }>; title: string; badge?: string; action?: React.ReactNode; compact?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-3 ${compact ? '' : 'mb-3.5'}`}>
      <h2 className="flex items-center gap-2 text-[13px] font-bold text-yx-ink">
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-yx-brand"><Icon className="h-3.5 w-3.5 text-white" /></span>
        {title}
        {badge && <span className="rounded-full bg-yx-surface px-2 py-0.5 text-[9.5px] font-semibold text-yx-muted ring-1 ring-yx-line">{badge}</span>}
      </h2>
      {action}
    </div>
  )
}

function ScoreGauge({ value, empty }: { value: number; empty?: boolean }) {
  const radius = 52
  const strokeWidth = 10
  const circumference = 2 * Math.PI * radius
  const clamped = Math.min(Math.max(value, 0), 100)
  const offset = circumference * (1 - clamped / 100)
  const angle = (clamped / 100) * Math.PI * 2
  const knobX = 60 + radius * Math.cos(angle)
  const knobY = 60 + radius * Math.sin(angle)
  return (
    <div className="relative h-[122px] w-[122px] shrink-0">
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
        <defs>
          <linearGradient id="yxScoreGaugeGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="var(--yx-brand-bright)" />
            <stop offset="100%" stopColor="var(--yx-brand-hover)" />
          </linearGradient>
        </defs>
        <circle cx="60" cy="60" r={radius + 6} fill="none" stroke="var(--yx-hover)" strokeWidth="1" strokeDasharray="1 6" strokeLinecap="round" />
        <circle cx="60" cy="60" r={radius} fill="none" stroke="var(--yx-hover)" strokeWidth={strokeWidth} />
        {!empty && (
          <>
            <circle cx="60" cy="60" r={radius} fill="none" stroke="url(#yxScoreGaugeGradient)" strokeWidth={strokeWidth} strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset} className="transition-all duration-700" />
            <circle cx={knobX} cy={knobY} r="4" fill={value < 60 ? 'var(--yx-warning)' : 'var(--yx-brand-hover)'} stroke="var(--yx-paper)" strokeWidth="1.5" />
          </>
        )}
      </svg>
      <div className={`absolute inset-[17px] flex flex-col items-center justify-center rounded-full bg-gradient-to-b shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_10px_18px_-12px_color-mix(in srgb, var(--yx-brand-hover) 38%, transparent)] ring-1 ${
        empty
          ? 'from-yx-paper to-yx-hover ring-black/[0.04]'
          : value < 60
            ? 'from-yx-paper to-amber-50 ring-amber-100/80'
            : 'from-yx-paper to-yx-brand-soft ring-yx-brand-tint/70'
      }`}>
        <span
          className={`text-[29px] font-bold leading-none tracking-[-0.05em] tabular-nums ${
            empty
              ? 'text-yx-faint'
              : value < 60
                ? 'text-yx-warning-text'
                : 'bg-gradient-to-b from-yx-brand-strong to-yx-brand bg-clip-text text-transparent'
          }`}
        >
          {empty ? '--' : value}
        </span>
        <span className={`mt-1.5 h-px w-7 bg-gradient-to-r from-transparent to-transparent ${
          empty ? 'via-yx-line' : value < 60 ? 'via-amber-400/80' : 'via-yx-brand-bright'
        }`} />
        <span className={`mt-1 text-[7.5px] font-semibold tracking-[0.18em] ${
          empty ? 'text-yx-faint' : value < 60 ? 'text-yx-warning-text/70' : 'text-yx-brand-hover/80'
        }`}>AI 评分</span>
      </div>
    </div>
  )
}


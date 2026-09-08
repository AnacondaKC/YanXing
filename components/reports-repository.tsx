'use client'

import { ArrowUpRight, BookOpen, ChevronDown, ChevronRight, Download, FileText, FolderKanban, Gauge, List, Search, Sparkles, Type, UserRound, Users } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CardAura, GroupCardDecoration } from '@/components/ui/card-decoration'
import { RepositoryLoading, type RepositoryDataState } from '@/components/repository-loading'
import { useRepositoryEntrance } from '@/components/use-repository-entrance'
import { EmptyState } from '@/components/ui/empty-state'
import { CellCaption, RepositoryStatCell } from '@/components/ui/repository-stats'
import { CustomSelect } from '@/components/ui/select'
import { fetchAllPages } from '@/lib/client-request'
import { formatReportCharacters, formatReportDate, scoreTextClass } from '@/lib/format'
import { cumulativeTrend, runningAverageValues } from '@/lib/overview-trends'
import type { ProjectWithCapabilities } from '@/modules/projects/domain'
import type { ReportVersion } from '@/modules/reports/domain'
import type { ReportWithProject } from '@/components/workspace-types'

export function ReportsRepositoryWorkspace({
  projects,
  onOpenReport,
  onSelectProject,
}: {
  projects: ProjectWithCapabilities[]
  onOpenReport: (report: ReportVersion, project: ProjectWithCapabilities, mode: 'content' | 'dashboard') => void
  onSelectProject: (project: ProjectWithCapabilities) => void
}) {
  const [reports, setReports] = useState<ReportWithProject[]>([])
  const [loading, setLoading] = useState(true)
  const [hasLoaded, setHasLoaded] = useState(false)
  const { entering, finishEntrance } = useRepositoryEntrance(loading)
  const [loadError, setLoadError] = useState('')
  const initialLoading = loading && !hasLoaded
  const dataState: RepositoryDataState = hasLoaded ? 'ready' : loading ? 'loading' : 'error'
  const [search, setSearch] = useState('')
  const [projectFilter, setProjectFilter] = useState('all')
  const [expandedProjectIds, setExpandedProjectIds] = useState<string[]>([])
  const loadSequenceRef = useRef(0)
  const loadControllerRef = useRef<AbortController | undefined>(undefined)

  const fetchReports = useCallback(async () => {
    const requestSequence = ++loadSequenceRef.current
    loadControllerRef.current?.abort()
    const controller = new AbortController()
    loadControllerRef.current = controller
    setLoading(true)
    try {
      const result = await fetchAllPages<ReportWithProject>('/api/reports', 'reports', { cache: 'no-store', signal: controller.signal })
      if (controller.signal.aborted || requestSequence !== loadSequenceRef.current) return
      setReports(result.items)
      setHasLoaded(true)
      setLoadError('')
    } catch {
      if (controller.signal.aborted || requestSequence !== loadSequenceRef.current) return
      setLoadError('报告列表读取失败，请重试；已加载的内容会继续保留。')
    } finally {
      if (loadControllerRef.current === controller) loadControllerRef.current = undefined
      if (!controller.signal.aborted && requestSequence === loadSequenceRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchReports()
    return () => {
      loadSequenceRef.current += 1
      loadControllerRef.current?.abort()
    }
  }, [fetchReports])

  const projectOptions = useMemo(() => [
    {
      value: 'all',
      label: `全部所属课题 (${projects.length})`,
      textLabel: '全部所属课题',
      icon: FolderKanban,
    },
    ...projects.map((p) => ({
      value: p.id,
      label: p.title,
      textLabel: p.title,
      icon: FolderKanban,
      badge: p.latestReport ? `阶段${p.latestReport.version}` : undefined,
      badgeTone: 'gray' as const,
    })),
  ], [projects])

  const filteredReports = useMemo(() => reports.filter((report) => {
    const matchesSearch =
      report.title.toLowerCase().includes(search.toLowerCase()) ||
      report.fileName.toLowerCase().includes(search.toLowerCase()) ||
      report.projectTitle.toLowerCase().includes(search.toLowerCase())
    if (!matchesSearch) return false
    if (projectFilter !== 'all' && report.projectId !== projectFilter) return false
    return true
  }), [reports, search, projectFilter])

  const groupedReports = useMemo(() => {
    const groups = new Map<string, { projectId: string; projectTitle: string; reports: ReportWithProject[] }>()
    for (const report of filteredReports) {
      const existing = groups.get(report.projectId)
      if (existing) existing.reports.push(report)
      else groups.set(report.projectId, {
        projectId: report.projectId,
        projectTitle: report.projectTitle,
        reports: [report],
      })
    }
    for (const group of groups.values()) {
      group.reports.sort((left, right) => right.version - left.version || right.createdAt.localeCompare(left.createdAt))
    }
    const ordered: Array<{ projectId: string; projectTitle: string; reports: ReportWithProject[] }> = []
    for (const project of projects) {
      const group = groups.get(project.id)
      if (!group) continue
      ordered.push(group)
      groups.delete(project.id)
    }
    ordered.push(...groups.values())
    return ordered
  }, [filteredReports, projects])

  const filteredAiScores = filteredReports.flatMap((report) => report.aiScore === undefined ? [] : [report.aiScore])
  const filteredCompletenessScores = filteredReports.flatMap((report) => report.completeness === undefined ? [] : [report.completeness])
  const overallAverageAiScore = filteredAiScores.length > 0
    ? Math.round((filteredAiScores.reduce((sum, score) => sum + score, 0) / filteredAiScores.length) * 10) / 10
    : undefined
  const overallAverageCompleteness = filteredCompletenessScores.length > 0
    ? Math.round((filteredCompletenessScores.reduce((sum, score) => sum + score, 0) / filteredCompletenessScores.length) * 10) / 10
    : undefined
  const totalCharacterCount = filteredReports.reduce((sum, report) => sum + report.characterCount, 0)
  const totalParagraphCount = filteredReports.reduce((sum, report) => sum + report.paragraphCount, 0)
  const hasSectionCount = filteredReports.some((report) => report.sectionCount !== undefined)
  const totalSectionCount = filteredReports.reduce((sum, report) => sum + (report.sectionCount ?? 0), 0)
  const firstProjectAt = new Map<string, string>()
  for (const report of filteredReports) {
    const existing = firstProjectAt.get(report.projectId)
    if (!existing || report.createdAt < existing) firstProjectAt.set(report.projectId, report.createdAt)
  }
  const repositoryStats = [
    { label: '收录报告', value: filteredReports.length.toLocaleString('zh-CN'), unit: '份', icon: FileText, points: cumulativeTrend(filteredReports.map((report) => ({ at: report.createdAt, value: 1 }))), trendLabel: '近 7 日收录报告累计走势' },
    { label: '覆盖课题', value: groupedReports.length.toLocaleString('zh-CN'), unit: '个', icon: FolderKanban, points: cumulativeTrend([...firstProjectAt.values()].map((at) => ({ at, value: 1 }))), trendLabel: '近 7 日覆盖课题累计走势' },
    { label: '平均 AI 综合评分', value: overallAverageAiScore?.toString() ?? '--', unit: '分', icon: Sparkles, valueClassName: scoreTextClass(overallAverageAiScore), points: runningAverageTrend(filteredReports.flatMap((report) => report.aiScore === undefined ? [] : [{ at: report.createdAt, value: report.aiScore }])), trendLabel: '近 7 日平均 AI 综合评分走势' },
    { label: '平均完整度', value: overallAverageCompleteness?.toString() ?? '--', unit: '%', icon: Gauge, valueClassName: scoreTextClass(overallAverageCompleteness), points: runningAverageTrend(filteredReports.flatMap((report) => report.completeness === undefined ? [] : [{ at: report.createdAt, value: report.completeness }])), trendLabel: '近 7 日平均完整度走势' },
    { label: '总字数', value: formatReportCharacters(totalCharacterCount), unit: '字', icon: Type, points: cumulativeTrend(filteredReports.map((report) => ({ at: report.createdAt, value: report.characterCount }))), trendLabel: '近 7 日总字数累计走势' },
    { label: '总段落数', value: totalParagraphCount.toLocaleString('zh-CN'), unit: '段', icon: List, points: cumulativeTrend(filteredReports.map((report) => ({ at: report.createdAt, value: report.paragraphCount }))), trendLabel: '近 7 日总段落数累计走势' },
    { label: '总章节数', value: hasSectionCount ? totalSectionCount.toLocaleString('zh-CN') : '--', unit: '章', icon: BookOpen, points: cumulativeTrend(filteredReports.flatMap((report) => report.sectionCount === undefined ? [] : [{ at: report.createdAt, value: report.sectionCount }])), trendLabel: '近 7 日总章节数累计走势' },
  ]

  function toggleProjectExpanded(projectId: string) {
    setExpandedProjectIds((current) => current.includes(projectId)
      ? current.filter((id) => id !== projectId)
      : [...current, projectId])
  }

  return (
    <div className="yx-repository space-y-6" data-enter={entering} onInputCapture={finishEntrance} onClickCapture={finishEntrance} onKeyDownCapture={finishEntrance}>
      {loadError && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-yx-warning/25 bg-yx-warning-soft px-4 py-3 text-xs text-yx-warning-text">
          <span>{loadError}</span>
          <button type="button" onClick={() => void fetchReports()} className="shrink-0 font-semibold underline decoration-yx-warning/40 underline-offset-2">重试</button>
        </div>
      )}
      {/* 工具面板：标题 + 搜索筛选 + 统计磁贴，装饰语言对齐总览面板 */}
      <section className="relative overflow-hidden rounded-lg border border-yx-line bg-yx-paper p-5 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-[border-color,box-shadow] duration-200 hover:border-yx-brand/25 hover:shadow-[0_12px_28px_-14px_color-mix(in_srgb,var(--yx-brand-strong)_25%,transparent)]">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
          <CardAura showTopHighlight={false} />
        </div>
        <div className="relative z-10">
          <div className="yx-repository-intro flex min-h-8 items-center">
            <h2 className="flex items-center gap-2 text-[13px] font-bold text-yx-ink">
              <FileText className="h-[17px] w-[17px] shrink-0 text-yx-muted" />
              报告库
              <span className="rounded-full bg-yx-surface px-2 py-0.5 text-[9.5px] font-semibold text-yx-muted ring-1 ring-yx-line">
                {hasLoaded ? `${filteredReports.length} 份报告 · ${groupedReports.length} 个课题` : initialLoading ? '正在加载…' : '暂未加载'}
              </span>
            </h2>
          </div>

          <div className="yx-repository-filters mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative max-w-sm flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-yx-faint" />
              <input
                type="text"
                placeholder="搜索报告名称、文件名或所属课题..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-md border border-yx-line bg-yx-surface/70 px-3 py-2 pl-9 text-xs text-yx-ink placeholder:text-yx-faint transition-all focus:border-transparent focus:bg-yx-paper focus:outline-none focus:ring-2 focus:ring-yx-brand"
              />
            </div>

            <div className="w-56 shrink-0 sm:w-64">
              <CustomSelect
                value={projectFilter}
                onChange={(val) => setProjectFilter(val)}
                options={projectOptions}
                placeholder="筛选所属课题..."
                searchable={projects.length > 5}
                searchPlaceholder="搜索课题名称..."
                size="md"
                variant="notion"
                ariaLabel="筛选所属课题"
              />
            </div>
          </div>

          <div className="mt-4 overflow-hidden rounded-lg border border-yx-line">
            <div className="grid grid-cols-2 gap-px bg-yx-line sm:grid-cols-4 xl:grid-cols-7">
              {repositoryStats.map((stat, index) => (
                <RepositoryStatCell key={stat.label} dataState={dataState} entranceIndex={index} gradientId={`yx-repo-trend-${index}`} {...stat} />
              ))}
            </div>
          </div>
        </div>
      </section>

      <div aria-busy={loading} className={initialLoading ? undefined : 'yx-repository-content'}>
      {initialLoading ? (
        <RepositoryLoading label="报告库" />
      ) : !hasLoaded && loadError ? null : groupedReports.length > 0 ? (
        <div className="space-y-4">
          {groupedReports.map((group, groupIndex) => {
            const project = projects.find((item) => item.id === group.projectId)
            const collapsed = !expandedProjectIds.includes(group.projectId)
            const aiScores = group.reports.flatMap((report) => report.aiScore === undefined ? [] : [report.aiScore])
            const completenessScores = group.reports.flatMap((report) => report.completeness === undefined ? [] : [report.completeness])
            const averageAiScore = aiScores.length > 0
              ? Math.round((aiScores.reduce((sum, score) => sum + score, 0) / aiScores.length) * 10) / 10
              : undefined
            const averageCompleteness = completenessScores.length > 0
              ? Math.round((completenessScores.reduce((sum, score) => sum + score, 0) / completenessScores.length) * 10) / 10
              : undefined
            const projectTitle = project?.title ?? group.projectTitle
            return (
              <section key={group.projectId} className={`relative overflow-hidden rounded-lg border bg-yx-paper shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-[border-color,box-shadow] duration-200 hover:shadow-[0_12px_28px_-14px_color-mix(in_srgb,var(--yx-brand-strong)_25%,transparent)] ${collapsed ? 'border-yx-line hover:border-yx-brand/30' : 'border-yx-brand/35'}`}>
                <GroupCardDecoration />
                <header className={`group relative z-10 flex items-center justify-between gap-3 px-4 py-3 transition-colors ${collapsed ? 'bg-yx-paper hover:bg-yx-brand-soft/35' : 'border-b border-yx-line bg-yx-brand-soft/40'}`}>
                  <button
                    type="button"
                    onClick={() => toggleProjectExpanded(group.projectId)}
                    aria-expanded={!collapsed}
                    aria-label={collapsed ? `展开${projectTitle}的报告` : `折叠${projectTitle}的报告`}
                    className="absolute inset-0 z-0 rounded-[inherit] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-yx-brand"
                  />
                  <div className="pointer-events-none relative z-10 flex min-w-0 items-center gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-yx-brand-soft text-yx-brand">
                      {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    </span>
                    <span
                      aria-hidden="true"
                      className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-yx-brand-soft px-1.5 text-[10px] font-bold tabular-nums text-yx-brand"
                    >
                      {groupIndex + 1}
                    </span>
                    <span className="truncate text-[13px] font-semibold text-yx-ink">{projectTitle}</span>
                  </div>
                  <div className="pointer-events-none relative z-10 flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-1.5 text-[10px] font-medium text-yx-muted">
                    {project && (
                      <>
                        <span className="inline-flex max-w-36 min-w-0 items-center gap-1 rounded-full bg-yx-paper/80 px-2 py-0.5 text-yx-ink-soft" title={`课题负责人：${project.ownerName}`}>
                          <UserRound className="h-3 w-3 shrink-0 text-yx-brand" />
                          <span className="truncate">{project.ownerName}</span>
                        </span>
                        <span className="inline-flex max-w-40 min-w-0 items-center gap-1 rounded-full bg-yx-paper/80 px-2 py-0.5 text-yx-ink-soft" title={`课题协作人：${project.collaboratorNames || '暂无'}`}>
                          <Users className="h-3 w-3 shrink-0 text-yx-brand" />
                          <span className="truncate">{project.collaboratorNames || '暂无'}</span>
                        </span>
                      </>
                    )}
                    <span className="inline-flex items-center gap-1 rounded-full bg-yx-paper/80 px-2 py-0.5">
                      评分 <strong className={`tabular-nums ${scoreTextClass(averageAiScore)}`}>{averageAiScore ?? '--'}</strong>
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-full bg-yx-paper/80 px-2 py-0.5">
                      完整度 <strong className={`tabular-nums ${scoreTextClass(averageCompleteness)}`}>{averageCompleteness === undefined ? '--' : `${averageCompleteness}%`}</strong>
                    </span>
                    <span className="inline-flex items-center rounded-full bg-yx-paper/80 px-2 py-0.5 tabular-nums">{group.reports.length} 份</span>
                    {project && (
                      <button
                        type="button"
                        onClick={() => onSelectProject(project)}
                        aria-label={`查看课题：${project.title}`}
                        title={`查看课题：${project.title}`}
                        className="pointer-events-auto flex h-6 items-center gap-0.5 rounded-full bg-yx-brand-soft px-2.5 text-[10px] font-semibold text-yx-brand transition-colors hover:bg-yx-brand hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yx-brand"
                      >
                        查看课题
                        <ArrowUpRight className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </header>
                {!collapsed && (
                  <div className="relative z-10 overflow-x-auto">
                    <table className="w-full min-w-[720px] text-left text-xs">
                      <tbody className="divide-y divide-yx-line/80 text-yx-ink">
                        {group.reports.map((report) => {
                          const isPdf = report.fileName.toLowerCase().endsWith('.pdf')
                          return (
                            <tr key={report.id} className="transition-colors hover:bg-yx-brand-soft/25">
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-2.5">
                                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[9px] font-bold ${isPdf ? 'bg-yx-brand-soft text-yx-brand' : 'bg-yx-surface text-yx-ink-soft ring-1 ring-yx-line'}`}>
                                    {isPdf ? 'PDF' : 'DOC'}
                                  </span>
                                  <div className="min-w-0">
                                    <span className="block max-w-[16rem] truncate font-semibold text-yx-ink" title={report.title}>
                                      {report.title}
                                    </span>
                                    <span className="block max-w-[16rem] truncate text-[10px] text-yx-muted">
                                      {report.fileName}
                                    </span>
                                  </div>
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                <CellCaption label="阶段">
                                  <span className="rounded-full bg-yx-warning-soft px-2 py-0.5 text-[10px] font-semibold text-yx-warning-text">
                                    阶段{report.version}
                                  </span>
                                </CellCaption>
                              </td>
                              <td className="px-4 py-3">
                                <CellCaption label="字数 / 段落">
                                  <span className="tabular-nums text-yx-ink">{formatReportCharacters(report.characterCount)} 字 · {report.paragraphCount.toLocaleString('zh-CN')} 段</span>
                                </CellCaption>
                              </td>
                              <td className="px-4 py-3">
                                <CellCaption label="评分">
                                  <span className={`font-bold tabular-nums ${scoreTextClass(report.aiScore)}`}>{report.aiScore ?? '--'}</span>
                                </CellCaption>
                              </td>
                              <td className="px-4 py-3">
                                <CellCaption label="完整度">
                                  {report.completeness !== undefined ? (
                                    <div className="flex items-center justify-center gap-2">
                                      <div className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-yx-hover">
                                        <div
                                          className="h-full rounded-full bg-yx-brand"
                                          style={{ width: `${Math.min(Math.max(report.completeness, 0), 100)}%` }}
                                        />
                                      </div>
                                      <span className={`font-semibold tabular-nums ${scoreTextClass(report.completeness)}`}>{report.completeness}%</span>
                                    </div>
                                  ) : (
                                    <span className="text-yx-faint">--</span>
                                  )}
                                </CellCaption>
                              </td>
                              <td className="px-4 py-3">
                                <CellCaption label="上传时间">
                                  <span className="text-[11px] tabular-nums text-yx-muted">{formatReportDate(report.createdAt)}</span>
                                </CellCaption>
                              </td>
                              <td className="px-4 py-3 text-right">
                                <div className="flex items-center justify-end gap-1.5">
                                  {project && (
                                    <>
                                      <button
                                        type="button"
                                        onClick={() => onOpenReport(report, project, 'content')}
                                        className="rounded-full px-2.5 py-1 text-[11px] font-medium text-yx-ink-soft ring-1 ring-yx-line transition-colors hover:bg-yx-brand-soft hover:text-yx-brand hover:ring-yx-brand/20"
                                      >
                                        查看正文
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => onOpenReport(report, project, 'dashboard')}
                                        className="rounded-full bg-yx-brand px-2.5 py-1 text-[11px] font-medium text-white shadow-2xs transition-colors hover:bg-yx-brand-hover"
                                      >
                                        深度分析
                                      </button>
                                    </>
                                  )}
                                  <a
                                    href={`/api/reports/${report.id}/file`}
                                    download={report.fileName}
                                    aria-label="下载原件"
                                    title="下载原件"
                                    className="flex h-7 w-7 items-center justify-center rounded-full text-yx-muted transition-colors hover:bg-yx-brand-soft hover:text-yx-brand"
                                  >
                                    <Download className="h-3.5 w-3.5" />
                                  </a>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )
          })}
        </div>
      ) : (
        <EmptyState
          icon={FileText}
          title="暂无匹配的报告"
          description="请在课题中上传 DOCX / PDF 报告文件后，将在此统一汇聚展示。"
          className="py-16"
        />
      )}
      </div>
    </div>
  )
}

function runningAverageTrend(events: Array<{ at: string; value: number }>): number[] {
  return runningAverageValues(events).map((value) => Math.round(value * 10) / 10)
}

'use client'

import dynamic from 'next/dynamic'
import { Menu } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { OverviewWorkspace } from '@/components/overview-workspace'
import { WorkspacePageHeader, WorkspaceTopbar } from '@/components/workspace-shell'
import { TopbarUserNav } from '@/components/workspace-user-nav'
import { ProjectExecutiveHeader, ProjectSideNav, type ProjectTabId } from '@/components/project-executive-header'
import { BrandLogo } from '@/components/workspace-brand'
import { MainNavigationPanel } from '@/components/workspace-navigation'
import { Toast } from '@/components/toast'
import { useAnalysisJobActions } from '@/components/use-analysis-job-actions'
import { useAnalysisJobEvents } from '@/components/use-analysis-job-events'
import { useToast } from '@/components/use-toast'
import { apiFetch, fetchAllPages, fetchPage } from '@/lib/client-request'
import { activeAnalysisJobStatuses, EMPTY_SNAPSHOT, preferDisplayedAnalysisPayload, terminalAnalysisJobStatuses } from '@/lib/analysis-job-progress'
import { parseHiddenProjectIds, selectActiveReportAfterDeletion, toggleHiddenProjectId } from '@/lib/workspace-reports'
import { shouldLockOverviewScroll } from '@/lib/workspace-scroll'
import {
  acceptUploadedDashboardReport,
  activateDashboardReportForProject,
  emptyDashboardReportState,
  refreshActiveDashboardReport,
  replaceActiveDashboardReport,
  resetDashboardReportState,
  sameWorkspaceReportIdentity,
  shouldAcceptUploadedReport,
  type DashboardReportState,
  type UploadedReportContext,
} from '@/components/dashboard-state'
import { buildWorkspaceUrl, readWorkspaceUrl, type WorkspaceView } from '@/lib/workspace-url'
import type { ProjectWithCapabilities } from '@/modules/projects/domain'
import type { ReportVersion } from '@/modules/reports/domain'
import type { AnalysisModuleState, AnalysisSnapshotPayload } from '@/modules/contracts/analysis'
import type { AnalysisJob } from '@/modules/analysis/domain'
import type { SessionUser } from '@/modules/users/domain'
import type { KnowledgeItem, OverviewStats, ReportWithProject } from '@/components/workspace-types'

type PageView = WorkspaceView

type ReportRefreshBody = {
  report?: ReportVersion
  job?: AnalysisJob
  moduleStates?: AnalysisModuleState[]
  snapshot?: { payload?: AnalysisSnapshotPayload }
}

type ReportRefreshOptions = {
  terminalJobId?: string
  reportId?: string
}

const terminalReportRefreshDelaysMs = [0, 250, 500, 1_000] as const

function isAuthoritativeTerminalReport(body: ReportRefreshBody | undefined, reportId: string, terminalJobId: string) {
  const job = body?.job
  if (!body?.report || body.report.id !== reportId || !job || job.id !== terminalJobId || job.reportVersionId !== reportId || !terminalAnalysisJobStatuses.has(job.status)) return false
  return job.status !== 'completed' || body.snapshot?.payload !== undefined
}

async function waitForReportRefreshRetry(signal: AbortSignal, delayMs: number) {
  if (signal.aborted || delayMs <= 0) return !signal.aborted
  return new Promise<boolean>((resolve) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    const onAbort = () => {
      window.clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

function linkAbortSignal(signal: AbortSignal | undefined, controller: AbortController) {
  if (!signal) return () => undefined
  const abort = () => controller.abort()
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  return () => signal.removeEventListener('abort', abort)
}

function ViewLoading() {
  return <div className="flex min-h-48 items-center justify-center text-xs text-yx-muted">正在载入工作区…</div>
}

const DashboardView = dynamic(() => import('@/components/dashboard-view').then((module) => module.DashboardView), { loading: ViewLoading })
const ReportDocumentViewer = dynamic(() => import('@/components/report-document-viewer').then((module) => module.ReportDocumentViewer), { loading: ViewLoading })
const ReportHistoryView = dynamic(() => import('@/components/report-history-view').then((module) => module.ReportHistoryView), { loading: ViewLoading })
const ProjectSetupGuideView = dynamic(() => import('@/components/project-setup-guide').then((module) => module.ProjectSetupGuideView), { loading: ViewLoading })
const InsightWorkspace = dynamic(() => import('@/components/insight-workspace').then((module) => module.InsightWorkspace), { loading: ViewLoading })
const ReportsRepositoryWorkspace = dynamic(() => import('@/components/reports-repository').then((module) => module.ReportsRepositoryWorkspace), { loading: ViewLoading })
const KnowledgeBaseWorkspace = dynamic(() => import('@/components/knowledge-base').then((module) => module.KnowledgeBaseWorkspace), { loading: ViewLoading })
const WorkspaceDialogs = dynamic(() => import('@/components/workspace-dialogs').then((module) => module.WorkspaceDialogs))

export default function Dashboard() {
  const [view, setView] = useState<PageView>('overview')
  const [projects, setProjects] = useState<ProjectWithCapabilities[]>([])
  const [projectsLoaded, setProjectsLoaded] = useState(false)
  const [users, setUsers] = useState<SessionUser[]>([])
  const [activeProjectId, setActiveProjectId] = useState('')
  const [editProfileOpen, setEditProfileOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [notificationRefreshKey, setNotificationRefreshKey] = useState(0)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [currentUser, setCurrentUser] = useState<SessionUser>()
  const { notice, showNotice } = useToast()
  const requestNotificationRefresh = useCallback(() => setNotificationRefreshKey((key) => key + 1), [])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [progressDialogOpen, setProgressDialogOpen] = useState(false)
  const [progressDialogMilestoneId, setProgressDialogMilestoneId] = useState<string | undefined>()

  const openProgressDialog = useCallback((milestoneId?: string) => {
    setProgressDialogMilestoneId(milestoneId)
    setProgressDialogOpen(true)
  }, [])
  const [activeReportId, setActiveReportId] = useState<string | undefined>()
  const [activeReport, setActiveReport] = useState<ReportVersion | undefined>()
  const [latestReport, setLatestReport] = useState<ReportVersion | undefined>()
  const [analysisSnapshot, setAnalysisSnapshot] = useState<AnalysisSnapshotPayload | undefined>()
  const [activeJobId, setActiveJobId] = useState<string | undefined>()
  const [analysisJob, setAnalysisJob] = useState<AnalysisJob>()
  const [analysisModuleStates, setAnalysisModuleStates] = useState<AnalysisModuleState[]>([])
  const [reportReloadKey, setReportReloadKey] = useState(0)
  const [editTarget, setEditTarget] = useState<ProjectWithCapabilities | undefined>()
  const [deleteTarget, setDeleteTarget] = useState<ProjectWithCapabilities | undefined>()
  const [deleteReportTarget, setDeleteReportTarget] = useState<ReportVersion | undefined>()
  const [replaceReportTarget, setReplaceReportTarget] = useState<ReportVersion | undefined>()
  const [reportStageAssignmentTarget, setReportStageAssignmentTarget] = useState<ReportVersion | undefined>()
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0)
  const [searchOpen, setSearchOpen] = useState(false)
  const [hiddenProjectIds, setHiddenProjectIds] = useState<string[]>(() => {
    if (typeof window === 'undefined') return []
    try {
      return parseHiddenProjectIds(window.localStorage.getItem('yanxing_hidden_project_ids'))
    } catch {
      return []
    }
  })

  const hiddenProjectIdsRef = useRef(hiddenProjectIds)
  hiddenProjectIdsRef.current = hiddenProjectIds
  const [hiddenPrefsReady, setHiddenPrefsReady] = useState(false)

  useEffect(() => {
    try {
      setHiddenProjectIds(parseHiddenProjectIds(window.localStorage.getItem('yanxing_hidden_project_ids')))
    } catch {
      setHiddenProjectIds([])
    }
    setHiddenPrefsReady(true)
  }, [])

  useEffect(() => {
    if (!hiddenPrefsReady) return
    try {
      window.localStorage.setItem('yanxing_hidden_project_ids', JSON.stringify(hiddenProjectIds))
    } catch {
      // ignore
    }
  }, [hiddenProjectIds, hiddenPrefsReady])

  function toggleHideProject(projectId: string) {
    const next = toggleHiddenProjectId(hiddenProjectIdsRef.current, projectId)
    setHiddenProjectIds(next)
    const target = projects.find((p) => p.id === projectId)
    const isNowHidden = next.includes(projectId)
    showNotice(isNowHidden ? `已隐藏示例课题「${target?.title ?? ''}」。` : `已恢复显示示例课题「${target?.title ?? ''}」。`)
    if (isNowHidden && activeProjectId === projectId) {
      setActiveProjectId('')
      setView('overview')
    }
  }

  const hiddenProjectIdSet = useMemo(() => new Set(hiddenProjectIds), [hiddenProjectIds])
  const listedProjects = useMemo(() => projects.filter((project) => !hiddenProjectIdSet.has(project.id)), [hiddenProjectIdSet, projects])

  useLayoutEffect(() => {
    if (view !== 'overview') {
      setOverviewLocksScroll(false)
      return
    }
    const workspace = workspaceRef.current
    if (!workspace) return

    const update = () => {
      const fits = shouldLockOverviewScroll(workspace.scrollHeight, workspace.clientHeight)
      setOverviewLocksScroll(fits)
      if (fits) workspace.scrollTop = 0
    }

    update()
    const observer = new ResizeObserver(update)
    observer.observe(workspace)
    const inner = workspace.firstElementChild
    if (inner) observer.observe(inner)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [view, listedProjects.length])

  const activeProjectIdRef = useRef('')
  const activeReportIdRef = useRef<string | undefined>(undefined)
  const activeJobIdRef = useRef<string | undefined>(undefined)
  const terminalReconciliationJobIdRef = useRef<string | undefined>(undefined)
  const reportListSequenceRef = useRef(0)
  const reportDetailSequenceRef = useRef(0)
  const reportRefreshControllerRef = useRef<AbortController | undefined>(undefined)
  const viewGenerationRef = useRef(0)
  const workspaceUrlReadyRef = useRef(false)
  const workspaceUrlModeRef = useRef<'push' | 'replace'>('replace')
  const workspaceRef = useRef<HTMLElement>(null)
  const [overviewLocksScroll, setOverviewLocksScroll] = useState(false)
  activeProjectIdRef.current = activeProjectId
  activeReportIdRef.current = activeReportId
  activeJobIdRef.current = activeJobId

  function currentDashboardReportState(): DashboardReportState {
    return {
      activeReportId,
      activeReport,
      latestReport,
      analysisSnapshot,
      activeJobId,
      analysisJob,
      analysisModuleStates,
    }
  }

  function applyDashboardReportState(next: DashboardReportState) {
    activeReportIdRef.current = next.activeReportId
    setActiveReportId(next.activeReportId)
    setActiveReport(next.activeReport)
    setLatestReport(next.latestReport)
    setAnalysisSnapshot(next.analysisSnapshot)
    setActiveJobId(next.activeJobId)
    setAnalysisJob(next.analysisJob)
    setAnalysisModuleStates(next.analysisModuleStates)
  }

  function bumpViewGeneration() {
    viewGenerationRef.current += 1
  }

  function invalidateReportListReads() {
    reportListSequenceRef.current += 1
  }

  function invalidateReportDetailReads() {
    reportDetailSequenceRef.current += 1
    reportRefreshControllerRef.current?.abort()
  }

  function invalidateAllReportReads() {
    invalidateReportListReads()
    invalidateReportDetailReads()
  }

  function pushWorkspaceNavigation() {
    if (workspaceUrlReadyRef.current) workspaceUrlModeRef.current = 'push'
  }

  useEffect(() => {
    const applyUrlState = () => {
      const next = readWorkspaceUrl()
      const current = { projectId: activeProjectIdRef.current, reportId: activeReportIdRef.current }
      if (workspaceUrlReadyRef.current && sameWorkspaceReportIdentity(current, next)) {
        workspaceUrlModeRef.current = 'replace'
        setView(next.view)
        return
      }
      workspaceUrlModeRef.current = 'replace'
      bumpViewGeneration()
      invalidateAllReportReads()
      setView(next.view)
      setActiveProjectId(next.projectId)
      applyDashboardReportState({
        ...emptyDashboardReportState(),
        activeReportId: next.reportId,
      })
      terminalReconciliationJobIdRef.current = undefined
      if (next.projectId) setReportReloadKey((key) => key + 1)
    }

    applyUrlState()
    workspaceUrlReadyRef.current = true
    window.addEventListener('popstate', applyUrlState)
    return () => window.removeEventListener('popstate', applyUrlState)
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k' || event.repeat) return
      event.preventDefault()
      setSearchOpen(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!workspaceUrlReadyRef.current) return
    const nextUrl = buildWorkspaceUrl({ view, projectId: activeProjectId, reportId: activeReportId })
    const currentUrl = window.location.pathname + window.location.search + window.location.hash
    if (nextUrl === currentUrl) {
      workspaceUrlModeRef.current = 'replace'
      return
    }
    const method = workspaceUrlModeRef.current === 'push' ? 'pushState' : 'replaceState'
    window.history[method](window.history.state, '', nextUrl)
    workspaceUrlModeRef.current = 'replace'
  }, [view, activeProjectId, activeReportId])

  useEffect(() => {
    const isProjectScopedView = view === 'dashboard' || view === 'history' || view === 'insight' || view === 'content'
    if (!projectsLoaded || !isProjectScopedView || !activeProjectId || listedProjects.some((project) => project.id === activeProjectId)) return

    workspaceUrlModeRef.current = 'replace'
    bumpViewGeneration()
    invalidateAllReportReads()
    setActiveProjectId('')
    applyDashboardReportState(emptyDashboardReportState())
    setView('overview')
  }, [activeProjectId, listedProjects, projectsLoaded, view])

  const activeProject = listedProjects.find((project) => project.id === activeProjectId)
  const fullAnalysisRunning = Boolean(activeJobId) && (!analysisJob || activeAnalysisJobStatuses.has(analysisJob.status))
  const displaySnapshot = analysisSnapshot ?? EMPTY_SNAPSHOT
  const [overviewStats, setOverviewStats] = useState<OverviewStats>()
  const [overviewLoadError, setOverviewLoadError] = useState('')
  const [overviewRecentReports, setOverviewRecentReports] = useState<ReportWithProject[]>([])
  const [overviewActivityReports, setOverviewActivityReports] = useState<ReportWithProject[]>([])
  const [overviewRecentKnowledge, setOverviewRecentKnowledge] = useState<KnowledgeItem[]>([])
  const knowledgeCount = overviewStats?.knowledgeCount ?? 0
  const viewingHistoricalReport = Boolean(activeReport && latestReport && activeReport.id !== latestReport.id)
  const projectsRequestSequenceRef = useRef(0)
  const projectsRefreshControllerRef = useRef<AbortController | undefined>(undefined)
  const usersRequestSequenceRef = useRef(0)
  const statsRequestSequenceRef = useRef(0)
  const statsRefreshControllerRef = useRef<AbortController | undefined>(undefined)

  const refreshProjects = useCallback(async (signal?: AbortSignal) => {
    const requestSequence = ++projectsRequestSequenceRef.current
    projectsRefreshControllerRef.current?.abort()
    const controller = new AbortController()
    projectsRefreshControllerRef.current = controller
    const unlinkAbortSignal = linkAbortSignal(signal, controller)
    try {
      const result = await fetchAllPages<ProjectWithCapabilities>('/api/projects', 'projects', { cache: 'no-store', signal: controller.signal })
      if (!controller.signal.aborted && requestSequence === projectsRequestSequenceRef.current) {
        setProjects(result.items)
        setProjectsLoaded(true)
      }
    } catch {
      if (!controller.signal.aborted && requestSequence === projectsRequestSequenceRef.current) {
        setProjectsLoaded(true)
        showNotice('课题列表读取失败，请稍后重试。')
      }
    } finally {
      unlinkAbortSignal()
      if (projectsRefreshControllerRef.current === controller) projectsRefreshControllerRef.current = undefined
    }
  }, [])
  const refreshUsers = useCallback(async (signal?: AbortSignal) => {
    const requestSequence = ++usersRequestSequenceRef.current
    try {
      const result = await fetchAllPages<SessionUser>('/api/users', 'users', { cache: 'no-store', signal })
      if (!signal?.aborted && requestSequence === usersRequestSequenceRef.current) setUsers(result.items)
    } catch {
      // 用户选择器可以继续使用已有数据。
    }
  }, [])

  const refreshStats = useCallback(async (signal?: AbortSignal) => {
    const requestSequence = ++statsRequestSequenceRef.current
    statsRefreshControllerRef.current?.abort()
    const controller = new AbortController()
    statsRefreshControllerRef.current = controller
    const unlinkAbortSignal = linkAbortSignal(signal, controller)
    try {
      const response = await apiFetch('/api/overview-stats', { cache: 'no-store', signal: controller.signal }).catch(() => null)
      const data = await response?.json().catch(() => null) as {
        stats?: OverviewStats
        recentReports?: ReportWithProject[]
        activityReports?: ReportWithProject[]
        recentKnowledge?: KnowledgeItem[]
      } | null
      if (controller.signal.aborted || requestSequence !== statsRequestSequenceRef.current) return
      if (!data?.stats) {
        setOverviewLoadError('概览统计刷新失败，已保留上次成功加载的内容。')
        showNotice('概览统计刷新失败，已保留上次成功加载的内容。')
        return
      }
      setOverviewLoadError('')
      setOverviewStats(data.stats)
      setOverviewRecentReports(data.recentReports ?? [])
      setOverviewActivityReports(data.activityReports ?? [])
      setOverviewRecentKnowledge(data.recentKnowledge ?? [])
    } finally {
      unlinkAbortSignal()
      if (statsRefreshControllerRef.current === controller) statsRefreshControllerRef.current = undefined
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void refreshProjects(controller.signal)
    void refreshStats(controller.signal)
    apiFetch('/api/auth/me', { signal: controller.signal })
      .then((response) => response.json())
      .then((body: { user?: SessionUser }) => { if (!controller.signal.aborted && body.user) setCurrentUser(body.user) })
      .catch(() => undefined)
    return () => controller.abort()
  }, [refreshProjects, refreshStats])

  useEffect(() => {
    return () => {
      projectsRefreshControllerRef.current?.abort()
      statsRefreshControllerRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    const needsUsers = view === 'project-guide' || settingsOpen || Boolean(editTarget)
    if (!needsUsers) return
    const controller = new AbortController()
    void refreshUsers(controller.signal)
    return () => controller.abort()
  }, [editTarget, refreshUsers, settingsOpen, view])

  useEffect(() => {
    if (!activeProject) return
    const controller = new AbortController()
    let cancelled = false
    const requestSequence = ++reportListSequenceRef.current
    const requestedReportId = activeReportIdRef.current
    const requestedReport = requestedReportId
      ? apiFetch(`/api/reports/${requestedReportId}`, { cache: 'no-store', signal: controller.signal })
          .then(async (response) => response.ok ? (await response.json() as { report?: ReportVersion }).report : undefined)
          .catch(() => undefined)
      : Promise.resolve(undefined)

    Promise.all([
      fetchPage<ReportVersion>(`/api/projects/${activeProject.id}/reports`, 'reports', { cache: 'no-store', signal: controller.signal }, 1),
      requestedReport,
    ])
      .then(([{ items }, requested]) => {
        if (cancelled || reportListSequenceRef.current !== requestSequence) return
        const latest = items[0]
        const active = requested?.projectId === activeProject.id ? requested : latest
        if (active) {
          activeReportIdRef.current = active.id
          setLatestReport(latest)
          setActiveReportId(active.id)
          setActiveReport(active)
        } else {
          activeReportIdRef.current = undefined
          setLatestReport(undefined)
          setActiveReportId(undefined)
          setActiveReport(undefined)
          setAnalysisSnapshot(undefined)
          setActiveJobId(undefined)
          setAnalysisJob(undefined)
          setAnalysisModuleStates([])
        }
      })
      .catch(() => {
        if (!cancelled) showNotice('报告列表刷新失败，已保留当前数据。')
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [activeProject?.id, reportReloadKey])
  const refreshReport = useCallback(async (options: ReportRefreshOptions = {}) => {
    reportRefreshControllerRef.current?.abort()
    const reportId = options.reportId ?? activeReportId
    if (!reportId) {
      reportRefreshControllerRef.current = undefined
      return false
    }

    const controller = new AbortController()
    reportRefreshControllerRef.current = controller
    const requestSequence = ++reportDetailSequenceRef.current
    const requestedJobId = activeJobIdRef.current
    const expectedTerminalJobId = options.terminalJobId
    let latestBody: ReportRefreshBody | undefined

    const isCurrentRequest = () => {
      if (controller.signal.aborted || activeReportIdRef.current !== reportId || reportDetailSequenceRef.current !== requestSequence) return false
      const currentJobId = activeJobIdRef.current
      if (currentJobId === requestedJobId) return true
      return Boolean(expectedTerminalJobId && requestedJobId === expectedTerminalJobId && currentJobId === undefined)
    }

    const applyReportBody = (body: ReportRefreshBody | undefined, terminalAuthority: boolean) => {
      if (!body) return
      if (body.report) {
        setActiveReport(body.report)
        setLatestReport((current) => current?.id === body.report!.id ? body.report : current)
        if (body.snapshot?.payload !== undefined) {
          const incoming = body.snapshot.payload
          setAnalysisSnapshot((current) => preferDisplayedAnalysisPayload(current, incoming))
        }
      }
      const job = body.job
      if (!job) return
      setAnalysisJob((current) => {
        if (!current || current.id !== job.id || terminalAnalysisJobStatuses.has(job.status)) return job
        return current
      })
      setAnalysisModuleStates((current) => {
        if (!current.length || terminalAuthority || terminalAnalysisJobStatuses.has(job.status)) return body.moduleStates ?? []
        return current
      })
      if (activeAnalysisJobStatuses.has(job.status)) setActiveJobId(job.id)
      if (!terminalAnalysisJobStatuses.has(job.status)) return
      const pendingTerminalJob = terminalReconciliationJobIdRef.current
      const isExpectedTerminalJob = expectedTerminalJobId === undefined || job.id === expectedTerminalJobId
      const canClearActiveJob = expectedTerminalJobId === undefined
        ? pendingTerminalJob === undefined
        : terminalAuthority && isExpectedTerminalJob
      if (canClearActiveJob) setActiveJobId(undefined)
      else if (!isExpectedTerminalJob || (pendingTerminalJob !== undefined && pendingTerminalJob !== job.id)) setActiveJobId(job.id)
    }

    try {
      const delays = expectedTerminalJobId ? terminalReportRefreshDelaysMs : [0]
      for (const delayMs of delays) {
        if (!await waitForReportRefreshRetry(controller.signal, delayMs) || !isCurrentRequest()) return false
        const response = await apiFetch('/api/reports/' + reportId, { cache: 'no-store', signal: controller.signal }).catch(() => null)
        const body = await response?.json().catch(() => null) as ReportRefreshBody | null
        if (!isCurrentRequest()) return false
        if (body) latestBody = body
        if (!expectedTerminalJobId) {
          applyReportBody(body ?? undefined, false)
          return Boolean(body?.report || body?.job)
        }
        if (isAuthoritativeTerminalReport(body ?? undefined, reportId, expectedTerminalJobId)) {
          applyReportBody(body ?? undefined, true)
          return true
        }
      }
      if (latestBody && isCurrentRequest()) applyReportBody(latestBody, false)
      return false
    } finally {
      if (reportRefreshControllerRef.current === controller) reportRefreshControllerRef.current = undefined
    }
  }, [activeReportId])

  useEffect(() => {
    return () => {
      reportRefreshControllerRef.current?.abort()
      reportRefreshControllerRef.current = undefined
      terminalReconciliationJobIdRef.current = undefined
    }
  }, [activeReportId])

  useEffect(() => {
    void refreshReport()
  }, [refreshReport])

  const refreshReportRef = useRef(refreshReport)
  refreshReportRef.current = refreshReport
  const refreshProjectsRef = useRef(refreshProjects)
  refreshProjectsRef.current = refreshProjects
  const refreshStatsRef = useRef(refreshStats)
  refreshStatsRef.current = refreshStats

  useAnalysisJobEvents({
    activeJobId,
    setAnalysisJob,
    setAnalysisModuleStates,
    setActiveJobId,
    onSnapshotUpdated: () => { void refreshReportRef.current() },
    onTerminal: async (terminalJobId) => {
      terminalReconciliationJobIdRef.current = terminalJobId
      const authoritative = await refreshReportRef.current({ terminalJobId })
      if (authoritative && terminalReconciliationJobIdRef.current === terminalJobId) {
        terminalReconciliationJobIdRef.current = undefined
        void refreshProjectsRef.current()
        void refreshStatsRef.current()
      }
      return authoritative
    },
  })

  function navigate(nextView: PageView) {
    if (nextView !== view) bumpViewGeneration()
    pushWorkspaceNavigation()
    setView(nextView)
    setMobileSidebarOpen(false)
  }

  function activateReport(report: ReportVersion, nextView: PageView) {
    pushWorkspaceNavigation()
    const alreadyActive = activeReportIdRef.current === report.id
    const previousProjectId = activeProjectIdRef.current
    const nextState = alreadyActive
      ? refreshActiveDashboardReport(currentDashboardReportState(), report)
      : activateDashboardReportForProject(currentDashboardReportState(), report, previousProjectId)
    if (report.projectId !== previousProjectId) {
      bumpViewGeneration()
      setActiveProjectId(report.projectId)
    }
    invalidateReportDetailReads()
    applyDashboardReportState(alreadyActive ? { ...nextState, analysisSnapshot: currentDashboardReportState().analysisSnapshot } : nextState)
    if (!alreadyActive) terminalReconciliationJobIdRef.current = undefined
    setView(nextView)
    setMobileSidebarOpen(false)
    if (alreadyActive) void refreshReport({ reportId: report.id })
  }

  function returnToLatestReport() {
    if (latestReport && latestReport.projectId === activeProjectIdRef.current) activateReport(latestReport, view)
  }

  async function handleReportDeleted(deletedReport: ReportVersion) {
    requestNotificationRefresh()
    pushWorkspaceNavigation()
    const previousActiveReportId = activeReportIdRef.current
    const deletedActiveReport = previousActiveReportId === deletedReport.id
    const requestSequence = ++reportListSequenceRef.current
    invalidateReportDetailReads()
    setDeleteReportTarget(undefined)
    setHistoryRefreshKey((key) => key + 1)
    void refreshStats()

    if (deletedActiveReport) {
      setActiveReportId(undefined)
      setActiveReport(undefined)
      setAnalysisSnapshot(undefined)
      setActiveJobId(undefined)
      setAnalysisJob(undefined)
      setAnalysisModuleStates([])

    }

    const preservedActiveReportId = previousActiveReportId && !deletedActiveReport ? previousActiveReportId : undefined
    const [response, activeReportResponse] = await Promise.all([
      apiFetch(`/api/projects/${deletedReport.projectId}/reports`, { cache: 'no-store' }).catch(() => null),
      preservedActiveReportId
        ? apiFetch(`/api/reports/${preservedActiveReportId}`, { cache: 'no-store' }).catch(() => null)
        : Promise.resolve(null),
    ])
    const body = await response?.json().catch(() => null) as { reports?: ReportVersion[] } | null
    const activeBody = await activeReportResponse?.json().catch(() => null) as { report?: ReportVersion } | null
    if (activeProjectIdRef.current !== deletedReport.projectId || reportListSequenceRef.current !== requestSequence) {
      if (activeProjectIdRef.current !== deletedReport.projectId) void refreshProjects()
      showNotice(`V${String(deletedReport.version).padStart(2, '0')} 报告已删除。`)
      return
    }
    if (!response?.ok) {
      setReportReloadKey((key) => key + 1)
      void refreshProjects()
      showNotice('报告已删除，列表正在刷新。')
      return
    }

    const reports = body?.reports ?? []
    const fetchedActiveReport = activeBody?.report?.projectId === deletedReport.projectId ? activeBody.report : undefined
    const { latest: nextLatestReport, active: nextActiveReport } = selectActiveReportAfterDeletion(
      reports,
      previousActiveReportId,
      deletedReport.id,
      fetchedActiveReport,
      activeReport,
    )
    const activeReportChanged = nextActiveReport?.id !== previousActiveReportId
    setLatestReport(nextLatestReport)
    setActiveReportId(nextActiveReport?.id)
    setActiveReport(nextActiveReport)
    if (!nextActiveReport || activeReportChanged) {
      setAnalysisSnapshot(undefined)
      setActiveJobId(undefined)
      setAnalysisJob(undefined)
      setAnalysisModuleStates([])

    }
    void refreshProjects()
    showNotice(`V${String(deletedReport.version).padStart(2, '0')} 报告已删除。`)
  }

  function handleReportReplaced(replacedReport: ReportVersion) {
    requestNotificationRefresh()
    setReplaceReportTarget(undefined)
    setHistoryRefreshKey((key) => key + 1)
    void refreshProjects()
    void refreshStats()
    if (activeReportIdRef.current === replacedReport.id) {
      applyDashboardReportState(replaceActiveDashboardReport(currentDashboardReportState(), replacedReport))
      void refreshReport({ reportId: replacedReport.id })
    } else {
      setLatestReport((current) => current?.id === replacedReport.id ? replacedReport : current)
      setReportReloadKey((key) => key + 1)
    }
    showNotice(`V${String(replacedReport.version).padStart(2, '0')} 报告已替换，正在重新分析。`)
  }

  function selectProject(project: ProjectWithCapabilities) {
    pushWorkspaceNavigation()
    bumpViewGeneration()
    invalidateAllReportReads()
    setActiveProjectId(project.id)
    applyDashboardReportState(resetDashboardReportState(currentDashboardReportState()))
    setReportReloadKey((key) => key + 1)
    setView('dashboard')
    setMobileSidebarOpen(false)
  }

  function openSearch() {
    setSearchOpen(true)
    setMobileSidebarOpen(false)
  }

  function handleSearchSelect(project: ProjectWithCapabilities) {
    setSearchOpen(false)
    if (hiddenProjectIdsRef.current.includes(project.id)) {
      setHiddenProjectIds(toggleHiddenProjectId(hiddenProjectIdsRef.current, project.id))
    }
    selectProject(project)
  }

  function openOverview() {
    pushWorkspaceNavigation()
    bumpViewGeneration()
    invalidateAllReportReads()
    setActiveProjectId('')
    applyDashboardReportState(resetDashboardReportState(currentDashboardReportState()))
    setView('overview')
    setMobileSidebarOpen(false)
  }

  function openProjectGuide() {
    pushWorkspaceNavigation()
    bumpViewGeneration()
    invalidateAllReportReads()
    setActiveProjectId('')
    applyDashboardReportState(resetDashboardReportState(currentDashboardReportState()))
    setView('project-guide')
    setMobileSidebarOpen(false)
  }
  function handleNavigate(nav: 'overview' | 'reports' | 'knowledge') {
    if (nav === 'overview') {
      openOverview()
    } else if (nav === 'reports') {
      navigate('reports')
    } else if (nav === 'knowledge') {
      navigate('knowledge')
    }
  }

  function handleOpenReportFromRepository(report: ReportVersion, _project: ProjectWithCapabilities, mode: 'content' | 'dashboard') {
    activateReport(report, mode)
  }

  function acceptUploadedReport(report: ReportVersion, captured: UploadedReportContext) {
    requestNotificationRefresh()
    void refreshProjects()
    void refreshStats()
    setHistoryRefreshKey((key) => key + 1)
    const current = { projectId: activeProjectIdRef.current, viewGeneration: viewGenerationRef.current }
    if (!shouldAcceptUploadedReport(captured, current)) {
      if (captured.projectId === current.projectId) setReportReloadKey((key) => key + 1)
      return
    }
    invalidateAllReportReads()
    applyDashboardReportState(acceptUploadedDashboardReport(report))
    setReportReloadKey((key) => key + 1)
    setView('dashboard')
    void refreshReport({ reportId: report.id })
  }


  const {
    cancelling,
    startAnalysis: handleStartAnalysis,
    cancelAnalysis: handleCancelAnalysis,
  } = useAnalysisJobActions({
    canManage: Boolean(activeProject?.canManage),
    activeReport,
    activeJobId,
    showNotice,
    onJobAccepted: (job, moduleStates) => {
      terminalReconciliationJobIdRef.current = undefined
       requestNotificationRefresh()
      setActiveJobId(job.id)
      setAnalysisJob(job)
      setAnalysisModuleStates(moduleStates)
    },
    onNeedStageAssignment: (assignedReport) => setReportStageAssignmentTarget(assignedReport),
    onNeedProjectContext: () => {
      if (activeProject) setEditTarget(activeProject)
    },
    onCancelled: (job) => {
       requestNotificationRefresh()
      setActiveJobId(undefined)
      setAnalysisJob(job)
      void refreshReport()
    },
  })

  function handleProjectUpdated(updatedProject: ProjectWithCapabilities) {
    requestNotificationRefresh()
    setProjects((items) => items.map((item) => item.id === updatedProject.id ? updatedProject : item))
    setEditTarget(undefined)
    if (activeProjectIdRef.current === updatedProject.id) {
      setAnalysisSnapshot(undefined)
      setActiveJobId(undefined)
      setAnalysisJob(undefined)
      setAnalysisModuleStates([])
      setReportReloadKey((key) => key + 1)
      void refreshReport()
    }
    void refreshStats()
    showNotice('课题已更新。')
  }

  function handleProfileUpdated(updatedUser: SessionUser) {
    setCurrentUser(updatedUser)
    setUsers((current) => current.map((u) => u.id === updatedUser.id ? { ...u, ...updatedUser } : u))
    showNotice('个人信息已更新。')
  }

  const isProjectDetail = (view === 'dashboard' || view === 'insight' || view === 'content' || view === 'history') && Boolean(activeProject)
  const isFixedProjectView = isProjectDetail && (view === 'dashboard' || view === 'insight' || view === 'content')
  const activeNav: 'overview' | 'reports' | 'knowledge' | 'project' =
    isProjectDetail || view === 'project-guide'
      ? 'project'
      : view === 'reports'
        ? 'reports'
        : view === 'knowledge'
          ? 'knowledge'
          : 'overview'
  const hasOpenDialog = settingsOpen
    || Boolean(editTarget)
    || Boolean(deleteTarget)
    || Boolean(deleteReportTarget)
    || Boolean(replaceReportTarget)
    || Boolean(reportStageAssignmentTarget)
    || editProfileOpen
    || helpOpen
    || searchOpen
    || progressDialogOpen

  return (
    <main className="yx-workspace min-h-screen bg-[var(--yx-bg)] sm:grid sm:h-screen sm:grid-cols-[16.5rem_minmax(0,1fr)] sm:grid-rows-[3.25rem_minmax(0,1fr)] sm:overflow-hidden lg:grid-cols-[18rem_minmax(0,1fr)]">
      <MainNavigationPanel
        activeNav={activeNav}
        onNavigate={handleNavigate}
        projects={listedProjects}
        currentUserId={currentUser?.id}
        activeProjectId={activeProjectId}
        onSelectProject={selectProject}
        onOpenProjectGuide={openProjectGuide}
        reportCount={overviewStats?.totalReportVersions}
        knowledgeCount={overviewStats?.knowledgeCount}
        onSearch={openSearch}
      />

      <WorkspaceTopbar
        brand={
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setMobileSidebarOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-yx-muted hover:bg-yx-hover hover:text-yx-ink sm:hidden"
              aria-label="打开工作台导航"
            >
              <Menu className="h-4 w-4" />
            </button>
            <div className="flex items-center sm:hidden">
              <BrandLogo compact />
            </div>
            <div className="hidden min-w-0 items-center gap-2 text-xs font-semibold text-yx-ink sm:flex">
              {isProjectDetail && activeProject ? (
                <span className="truncate">{activeProject.title}</span>
              ) : view === 'project-guide' ? (
                '设立研究课题'
              ) : activeNav === 'overview' ? (
                <>
                  <span className="shrink-0 text-base font-bold leading-none">总览</span>
                  <span className="h-3.5 w-px shrink-0 bg-yx-line" aria-hidden="true" />
                  <span className="min-w-0 truncate font-medium text-yx-muted">持续跟踪研究课题、报告版本与分析质量全景。</span>
                </>
              ) : activeNav === 'reports' ? (
                <>
                  <span className="shrink-0 text-base font-bold leading-none">报告库</span>
                  <span className="h-3.5 w-px shrink-0 bg-yx-line" aria-hidden="true" />
                  <span className="min-w-0 truncate font-medium text-yx-muted">按课题分类汇聚全部报告版本，支持检索、正文阅读与分析追溯。</span>
                </>
              ) : (
                <>
                  <span className="shrink-0 text-base font-bold leading-none">知识库</span>
                  <span className="h-3.5 w-px shrink-0 bg-yx-line" aria-hidden="true" />
                  <span className="min-w-0 truncate font-medium text-yx-muted">上传与检索行业参考研报、政策文件与背景资料，为研究分析提供前沿参考。</span>
                </>
              )}
            </div>
          </div>
        }
        tools={<TopbarUserNav user={currentUser} onSettings={() => setSettingsOpen(true)} onEditProfile={() => setEditProfileOpen(true)} onSearch={openSearch} onHelp={() => setHelpOpen(true)} notificationRefreshKey={notificationRefreshKey} />}
      />

      {/* Main Workspace Section */}
      <section
        ref={workspaceRef}
        aria-label="主工作区"
        className={`min-w-0 bg-[var(--yx-surface)] sm:col-start-2 sm:row-start-2 ${
          isFixedProjectView
            ? 'overflow-hidden xl:overflow-hidden'
            : view === 'overview' && overviewLocksScroll
              ? 'overflow-hidden'
              : 'yx-subtle-scrollbar overflow-x-hidden overflow-y-auto'
        }`}
      >
        <div className={`mx-auto flex w-full max-w-[1380px] flex-col px-4 sm:px-8 lg:px-12 ${isFixedProjectView ? 'h-full min-h-0 pt-4 pb-4 sm:pt-5 sm:pb-5 xl:pt-5 xl:pb-5' : isProjectDetail ? 'min-h-full pb-12 pt-4 sm:pt-5 xl:pt-5' : 'min-h-full pb-8 pt-7 sm:pt-8'}`}>
          {isProjectDetail && activeProject && (
            <WorkspacePageHeader>
              <ProjectExecutiveHeader project={activeProject} />
            </WorkspacePageHeader>
          )}

          <div className={`relative min-w-0 ${isFixedProjectView ? 'mt-3 min-h-0 flex-1 flex flex-col xl:mt-4' : isProjectDetail ? 'mt-3 xl:mt-4' : 'mt-0'}`}>
            {isProjectDetail && activeProject ? (
              <div className={`relative min-w-0 ${isFixedProjectView ? 'min-h-0 flex-1 flex flex-col' : ''}`}>
                {/* 桌面端外侧悬浮导航栏：仅在存在研报版本时展示 */}
                {Boolean(activeReport) && (
                  <div className="hidden xl:block absolute right-[calc(100%+0.75rem)] top-0 h-full pointer-events-none z-20">
                    <div className="sticky top-4 pointer-events-auto w-20">
                      <ProjectSideNav
                        activeTab={view as ProjectTabId}
                        onTabChange={(tab) => navigate(tab)}
                      />
                    </div>
                  </div>
                )}

                {/* 移动端/平板端紧凑导航栏：仅在存在研报版本时展示 */}
                {Boolean(activeReport) && (
                  <div className="block xl:hidden mb-4">
                    <ProjectSideNav
                      activeTab={view as ProjectTabId}
                      onTabChange={(tab) => navigate(tab)}
                    />
                  </div>
                )}

                <div className={`min-w-0 flex-1 w-full ${isFixedProjectView ? 'lg:flex lg:min-h-0 lg:flex-1 lg:flex-col' : ''}`}>
                  {view === 'dashboard' && (
                    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                    <DashboardView
                      project={activeProject}
                      report={activeReport}
                      snapshot={displaySnapshot}
                      analyzing={fullAnalysisRunning}
                      cancelling={cancelling}
                      job={analysisJob}
                      moduleStates={analysisModuleStates}
                      canManage={activeProject.canManage}
                      viewingHistoricalReport={viewingHistoricalReport}
                      viewGeneration={viewGenerationRef.current}
                      onReturnToLatestReport={returnToLatestReport}
                      onReportUploaded={acceptUploadedReport}
                      onProjectUpdated={(p) => {
                        setActiveProjectId(p.id)
                        setProjects((prev) => prev.map((item) => (item.id === p.id ? p : item)))
                      }}
                      onCancelAnalysis={handleCancelAnalysis}
                      onOpenProgress={(milestoneId?: string) => openProgressDialog(milestoneId)}
                      onEditProject={() => setEditTarget(activeProject)}
                      onStartAnalysis={handleStartAnalysis}
                    />
                    </div>
                  )}
                  {view === 'insight' && (
                    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
                    <InsightWorkspace
                      report={activeReport}
                      canManage={activeProject.canManage}
                      canGenerateInsight={!activeReport || Boolean(latestReport && activeReport.id === latestReport.id)}
                      onNavigate={(tab) => navigate(tab)}
                    />
                    </div>
                  )}
                  {view === 'content' && (
                    <ReportDocumentViewer report={activeReport} />
                  )}
                  {view === 'history' && (
                    <ReportHistoryView
                      project={activeProject}
                      activeReportId={activeReportId}
                      refreshKey={historyRefreshKey}
                      onOpenReport={(report) => activateReport(report, 'dashboard')}
                      onDeleteReport={(report) => { if (activeProject.canDelete) setDeleteReportTarget(report) }}
                      onReplaceReport={(report) => { if (activeProject.canManage) setReplaceReportTarget(report) }}
                    />
                  )}
                </div>
              </div>
            ) : (
              <div className="min-w-0">
                {view === 'project-guide' && (
                  <ProjectSetupGuideView
                    users={users}
                    currentUser={currentUser}
                    onProjectCreated={(project) => {
                       requestNotificationRefresh()
                      setProjects((items) => [project, ...items])
                      setActiveProjectId(project.id)
                      setActiveReportId(undefined)
                      setActiveReport(undefined)
                      setLatestReport(undefined)
                      setAnalysisSnapshot(undefined)
                      setActiveJobId(undefined)
                      setAnalysisJob(undefined)
                      setAnalysisModuleStates([])

                      setView('dashboard')
                      void refreshStats()
                      showNotice('🎉 新课题已成功设立，欢迎开始研究！')
                    }}
                  />
                )}
                {view === 'overview' && (
                  <OverviewWorkspace
                    projects={listedProjects}
                    stats={overviewStats}
                    recentReports={overviewRecentReports}
                    activityReports={overviewActivityReports}
                    knowledgeItems={overviewRecentKnowledge}
                    upstreamError={overviewLoadError}
                    userName={currentUser?.displayName || currentUser?.username}
                    onSelect={selectProject}
                    onNavigate={handleNavigate}
                    onOpenReport={(report, project) => handleOpenReportFromRepository(report, project, 'dashboard')}
                  />
                )}
                {view === 'reports' && (
                  <ReportsRepositoryWorkspace
                    projects={listedProjects}
                    onOpenReport={handleOpenReportFromRepository}
                    onSelectProject={selectProject}
                  />
                )}
                {view === 'knowledge' && (
                  <KnowledgeBaseWorkspace
                    onNotice={showNotice}
                    onKnowledgeCountChange={() => { void refreshStats() }}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {mobileSidebarOpen && (
        <div className="fixed inset-0 z-40 sm:hidden">
          <button type="button" aria-label="关闭工作台导航" onClick={() => setMobileSidebarOpen(false)} className="absolute inset-0 bg-black/30" />
          <div className="relative flex h-full w-[min(84vw,280px)] flex-col bg-yx-paper shadow-lg overflow-hidden">
            <MainNavigationPanel
              activeNav={activeNav}
              onNavigate={(nav) => { handleNavigate(nav); setMobileSidebarOpen(false) }}
              projects={listedProjects}
              currentUserId={currentUser?.id}
              activeProjectId={activeProjectId}
              onSelectProject={(project) => { selectProject(project); setMobileSidebarOpen(false) }}
              onOpenProjectGuide={() => { openProjectGuide(); setMobileSidebarOpen(false) }}
              reportCount={overviewStats?.totalReportVersions ?? listedProjects.filter((p) => p.latestReport).length}
              knowledgeCount={knowledgeCount}
              onSearch={openSearch}
              mobile
            />
          </div>
        </div>
      )}

      {notice && <Toast message={notice} />}
      {hasOpenDialog && (
      <WorkspaceDialogs
        currentUser={currentUser}
        users={users}
        projects={projects}
        hiddenProjectIds={hiddenProjectIds}
        settingsOpen={settingsOpen}
        editTarget={editTarget}
        deleteTarget={deleteTarget}
        deleteReportTarget={deleteReportTarget}
        replaceReportTarget={replaceReportTarget}
        reportStageAssignmentTarget={reportStageAssignmentTarget}
        activeProject={activeProject}
        editProfileOpen={editProfileOpen}
        helpOpen={helpOpen}
        searchOpen={searchOpen}
        progressDialogOpen={progressDialogOpen}
        progressDialogMilestoneId={progressDialogMilestoneId}
        viewGeneration={viewGenerationRef.current}
        onToggleHideProject={toggleHideProject}
        onCloseSettings={() => setSettingsOpen(false)}
        onEditProject={(project) => setEditTarget(project)}
        onDeleteProject={(project) => setDeleteTarget(project)}
        onProjectsChanged={() => { void refreshProjects() }}
        onCloseEditProject={() => setEditTarget(undefined)}
        onProjectUpdated={handleProjectUpdated}
        onCloseDeleteProject={() => setDeleteTarget(undefined)}
        onProjectDeleted={(projectId) => {
          requestNotificationRefresh()
          setProjects((items) => items.filter((item) => item.id !== projectId))
          if (activeProjectId === projectId) {
            bumpViewGeneration()
            invalidateAllReportReads()
            setActiveProjectId('')
            applyDashboardReportState(emptyDashboardReportState())
            setView('overview')
          }
          setDeleteTarget(undefined)
          void refreshStats()
          showNotice('课题已删除。')
        }}
        onCloseDeleteReport={() => setDeleteReportTarget(undefined)}
        onReportDeleted={(report) => { void handleReportDeleted(report) }}
        onCloseReplaceReport={() => setReplaceReportTarget(undefined)}
        onReportReplaced={handleReportReplaced}
        onCloseStageAssignment={() => setReportStageAssignmentTarget(undefined)}
        onStageAssigned={(updatedReport) => {
          requestNotificationRefresh()
          setReportStageAssignmentTarget(undefined)
          setActiveReport((current) => current?.id === updatedReport.id ? updatedReport : current)
          setLatestReport((current) => current?.id === updatedReport.id ? updatedReport : current)
          setReportReloadKey((key) => key + 1)
          void refreshProjects()
          void handleStartAnalysis(updatedReport.id, true)
        }}
        onCloseProfile={() => setEditProfileOpen(false)}
        onProfileUpdated={handleProfileUpdated}
        onCloseHelp={() => setHelpOpen(false)}
        onCloseSearch={() => setSearchOpen(false)}
        onSearchSelect={handleSearchSelect}
        onCloseProgress={() => {
          setProgressDialogOpen(false)
          setProgressDialogMilestoneId(undefined)
        }}
        onProgressSaved={(updatedProject) => {
          requestNotificationRefresh()
          setProjects((items) => items.map((item) => (item.id === updatedProject.id ? { ...item, ...updatedProject } : item)))
          setProgressDialogOpen(false)
          setProgressDialogMilestoneId(undefined)
          showNotice('课题推进阶段与成果报告已更新。')
        }}
        onReportAssigned={(report) => {
          requestNotificationRefresh()
          setActiveReport((current) => current?.id === report.id ? report : current)
          setLatestReport((current) => current?.id === report.id ? report : current)
          setReportReloadKey((key) => key + 1)
        }}
        onReportUploaded={acceptUploadedReport}
      />
      )}
    </main>
  )
}

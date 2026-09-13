'use client'

import { Menu } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { WorkspaceDialogLoading } from '@/components/workspace-dialog-loading'
import { BrandLogo } from '@/components/workspace-brand'
import { KnowledgeBaseWorkspace } from '@/components/knowledge-base'
import { MainNavigationPanel } from '@/components/workspace-navigation'
import { ProjectSideNav, type ProjectTabId } from '@/components/project-executive-header'
import { ReportDocumentViewer } from '@/components/report-document-viewer'
import { Toast } from '@/components/toast'
import { useToast } from '@/components/use-toast'
import { WorkspacePageHeader, WorkspaceTopbar } from '@/components/workspace-shell'
import { EditProfileDialog, TopbarUserNav } from '@/components/workspace-user-nav'
import { WorkspaceSearchDialog } from '@/components/workspace-search-dialog'
import { OverviewWorkspace } from '@/components/overview-workspace'
import { ReportsRepositoryWorkspace } from '@/components/reports-repository'
import { WorkspaceProjectHeader } from '@/components/workspace-project-header'
import { ProjectSetupGuideView } from '@/components/project-setup-guide'
import { ProjectFirstReportOnboarding, type FirstReportDraft } from '@/components/project-first-report-onboarding'
import { DashboardView } from '@/components/dashboard-view'
import { ReportHistoryView } from '@/components/report-history-view'
import { InsightWorkspace } from '@/components/insight-workspace'
import { WorkspaceSubmitDialog } from '@/components/workspace-submit-flow'
import { WorkspaceUpdateReportDialog } from '@/components/workspace-update-report-dialog'
import { WorkspaceProjectEditEntry } from '@/components/workspace-project-edit-entry'
import { WorkspaceDeleteReportDialog } from '@/components/workspace-native-dialogs'
import { applyWorkspaceAnalysisTask, applyWorkspaceInsightTask, applyWorkspaceReportDetail, createWorkspaceReportReader, isTerminalTask, removeWorkspaceReport, refreshWorkspaceProjections, emptyWorkspaceReportView, selectWorkspaceReport } from '@/components/workspace-submission-state'
import { analysisJobEventsPath } from '@/lib/analysis-job-progress'
import { apiFetch, fetchAllPages } from '@/lib/client-request'
import { settleOverviewLoadState, type OverviewLoadState } from '@/lib/overview-loading'
import { parseHiddenProjectIds, toggleHiddenProjectId } from '@/lib/workspace-reports'
import { buildWorkspaceUrl, encodeWorkspaceUrlState, readWorkspaceUrl, sameWorkspaceLocation, type WorkspaceView } from '@/lib/workspace-url'
import {
  NATIVE_TASK_EVENT_TYPES,
  WORKSPACE_API,
  beginSubmitConfirm,
  buildSubmissionCommand,
  classifyCommitFailure,
  createIdempotencyKey,
  currentStageTokens,
  describeCommitNetworkError,
  dismissWorkspaceSubmit,
  documentSourceFromReport,
  idleSubmitPhase,
  isCurrentWorkspaceFetch,
  originProjectIdFromSubmit,
  previewSubmissionImpact,
  reduceWorkspaceSubmit,
  shouldPollReport,
  shouldPreserveSubmitPhase,
  type WorkspaceOverviewStats,
  type WorkspaceProjectDetail,
  type WorkspaceProjectListItem,
  type WorkspaceReportCard,
  type WorkspaceReportDetail,
  type WorkspaceSubmitPhase,
} from '@/lib/workspace-submission'
import {
  cancelWorkspaceTask,
  confirmWorkspaceSubmission,
  conflictFromError,
  createWorkspaceProject,
  deleteWorkspaceReport,
  fetchWorkspaceOverview,
  fetchWorkspaceProject,
  fetchWorkspaceProjects,
  fetchWorkspaceReport,
  fetchWorkspaceReports,
  prepareWorkspaceUpload,
  readWorkspaceUpload,
  startWorkspaceTask,
  workspacePath,
  WorkspaceRequestError,
} from '@/lib/workspace-submission-client'
import type { SessionUser } from '@/modules/users/domain'
import type { KnowledgeItem } from '@/components/workspace-types'
import type { SubmissionTask } from '@/modules/reports/submission-task-domain'

const loadSettingsDialog = () => import('@/components/admin-settings')
const AdminSettingsDialog = lazy(() => loadSettingsDialog().then((module) => ({ default: module.AdminSettingsDialog })))
const preloadWorkspaceDialogs = () => { void loadSettingsDialog().catch(() => undefined) }
const DIALOG_PRELOAD_IDLE_TIMEOUT_MS = 1_500

function hasResumableSubmit(phase: WorkspaceSubmitPhase) {
  return phase.step === 'preparing' || phase.step === 'prepared' || phase.step === 'submitting'
    || phase.step === 'uncertain' || phase.step === 'conflict' || phase.step === 'acknowledged'
}

function canSubmitDraft(detail: WorkspaceProjectDetail, draft: Pick<FirstReportDraft, 'stageId' | 'reportKind'>) {
  const group = detail.stages.find((item) => item.stage.id === draft.stageId)
  return detail.project.canSubmit && Boolean(group && (draft.reportKind === 'completion' ? group.canSubmitCompletion : group.canSubmitUpdate))
}

export default function WorkspaceApp() {
  const { notice, showNotice } = useToast()
  const [view, setView] = useState<WorkspaceView>('overview')
  const [projects, setProjects] = useState<WorkspaceProjectListItem[]>([])
  const [projectsState, setProjectsState] = useState<OverviewLoadState>('loading')
  const [statsState, setStatsState] = useState<OverviewLoadState>('loading')
  const [stats, setStats] = useState<WorkspaceOverviewStats>()
  const [recentReports, setRecentReports] = useState<WorkspaceReportCard[]>([])
  const [activityReports, setActivityReports] = useState<WorkspaceReportCard[]>([])
  const [users, setUsers] = useState<SessionUser[]>([])
  const [libraryError, setLibraryError] = useState('')
  const [libraryReports, setLibraryReports] = useState<WorkspaceReportCard[]>([])
  const [libraryLoaded, setLibraryLoaded] = useState(false)
  const [recentKnowledge, setRecentKnowledge] = useState<KnowledgeItem[]>([])
  const [loadError, setLoadError] = useState('')
  const [currentUser, setCurrentUser] = useState<SessionUser>()
  const [activeProjectId, setActiveProjectId] = useState('')
  const [detail, setDetail] = useState<WorkspaceProjectDetail>()
  const [reportView, setReportView] = useState(emptyWorkspaceReportView())
  const [insight, setInsight] = useState<WorkspaceReportDetail['insight']>()
  const [submitPhase, setSubmitPhase] = useState<WorkspaceSubmitPhase>(idleSubmitPhase())
  const submitPhaseRef = useRef(submitPhase)
  const preparingProjectIdRef = useRef<string | undefined>(undefined)
  const [submitError, setSubmitError] = useState('')
  const [submitOpen, setSubmitOpen] = useState(false)
  const [completionReplacement, setCompletionReplacement] = useState<{ report: WorkspaceReportCard; tokens: ReturnType<typeof currentStageTokens> }>()
  const [editProjectId, setEditProjectId] = useState<string>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [editProfileOpen, setEditProfileOpen] = useState(false)
  const [deleteReport, setDeleteReport] = useState<WorkspaceReportCard>()
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [cancellingAnalysis, setCancellingAnalysis] = useState(false)
  const [cancellingInsight, setCancellingInsight] = useState(false)
  const [hiddenProjectIds, setHiddenProjectIds] = useState<string[]>(() => {
    try { return parseHiddenProjectIds(window.localStorage.getItem('yanxing_hidden_project_ids')) } catch { return [] }
  })
  const [urlHydrated, setUrlHydrated] = useState(false)
  const navGeneration = useRef(0)
  const selectedReportIdRef = useRef<string | undefined>(undefined)
  const reportViewRef = useRef(reportView)
  const mutationEpoch = useRef(0)
  const conflictRefreshRef = useRef(false)
  const [refreshError, setRefreshError] = useState('')
  const [reportReadError, setReportReadError] = useState('')
  const reportReadFailures = useRef(0)
  const projectionSequence = useRef({ projects: 0, stats: 0, library: 0 })
  const dirtyProjections = useRef(new Set<'projects' | 'stats' | 'library'>())
  const terminalTasks = useRef(new Set<string>())
  const [dirtyRevision, setDirtyRevision] = useState(0)
  const updateReportView = useCallback((next: typeof reportView | ((current: typeof reportView) => typeof reportView)) => {
    const value = typeof next === 'function' ? next(reportViewRef.current) : next
    reportViewRef.current = value
    selectedReportIdRef.current = value.selectedReport?.id
    setReportView(value)
  }, [])

  const listedProjects = useMemo(() => projects.filter((project) => !hiddenProjectIds.includes(project.id)), [hiddenProjectIds, projects])
  const selectedReport = reportView.selectedReport
  const activeProject = listedProjects.find((project) => project.id === activeProjectId) ?? detail?.project

  useEffect(() => {
    if (currentUser?.role !== 'admin') return
    if (typeof window.requestIdleCallback === 'function') {
      const idleId = window.requestIdleCallback(preloadWorkspaceDialogs, { timeout: DIALOG_PRELOAD_IDLE_TIMEOUT_MS })
      return () => window.cancelIdleCallback(idleId)
    }
    const timer = window.setTimeout(preloadWorkspaceDialogs, DIALOG_PRELOAD_IDLE_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [currentUser?.role])

  useEffect(() => {
    if (view !== 'project-guide') return
    const controller = new AbortController()
    void fetchAllPages<SessionUser>('/api/users', 'users', { signal: controller.signal, cache: 'no-store' })
      .then((result) => { if (!controller.signal.aborted) setUsers(result.items) })
      .catch(() => { if (!controller.signal.aborted) showNotice('团队成员列表读取失败，请稍后重试。') })
    return () => controller.abort()
  }, [showNotice, view])

  const persistUrl = useCallback((next: { view: WorkspaceView; projectId: string; stageId?: string; reportId?: string }) => {
    const url = buildWorkspaceUrl(next)
    if (sameWorkspaceLocation(url, window.location)) return
    window.history.replaceState(null, '', url)
  }, [])

  const refreshProjects = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++projectionSequence.current.projects
    try {
      const result = await fetchWorkspaceProjects(signal)
      if (signal?.aborted || sequence !== projectionSequence.current.projects) return false
      dirtyProjections.current.delete('projects')
      setProjects(result.items)
      setProjectsState('ready')
      return true
    } catch {
      if (signal?.aborted || sequence !== projectionSequence.current.projects) return false
      setProjectsState((current) => settleOverviewLoadState(current, 'failure'))
      showNotice('课题列表读取失败，请稍后重试。')
      return false
    }
  }, [showNotice])

  const refreshStats = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++projectionSequence.current.stats
    try {
      const overview = await fetchWorkspaceOverview(signal)
      if (signal?.aborted || sequence !== projectionSequence.current.stats) return false
      dirtyProjections.current.delete('stats')
      setStats(overview.stats)
      setRecentReports(overview.recentReports)
      setActivityReports(overview.activityReports)
      setRecentKnowledge(overview.recentKnowledge as KnowledgeItem[])
      setStatsState('ready')
      setLoadError('')
      return true
    } catch {
      if (signal?.aborted || sequence !== projectionSequence.current.stats) return false
      setStatsState((current) => settleOverviewLoadState(current, 'failure'))
      setLoadError('概览统计读取失败，请稍后重试。')
      return false
    }
  }, [])

  const refreshLibrary = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++projectionSequence.current.library
    try {
      const result = await fetchWorkspaceReports(signal)
      if (signal?.aborted || sequence !== projectionSequence.current.library) return false
      dirtyProjections.current.delete('library')
      setLibraryReports(result.items)
      setLibraryLoaded(true)
      setLibraryError('')
      return true
    } catch (cause) {
      if (signal?.aborted || sequence !== projectionSequence.current.library) return false
      setLibraryError(cause instanceof Error ? cause.message : '报告库读取失败，请稍后重试。')
      return false
    }
  }, [showNotice])

  const applyFetchedReport = useCallback((input: { generation: number; expectedReportId: string; report: WorkspaceReportDetail }) => {
    if (!isCurrentWorkspaceFetch({
      generation: input.generation,
      currentGeneration: navGeneration.current,
      expectedReportId: input.expectedReportId,
      selectedReportId: selectedReportIdRef.current,
      fetchedReportId: input.report.id,
    })) return false
    const current = reportViewRef.current
    const next = applyWorkspaceReportDetail(current, {
      report: input.report,
      snapshot: input.report.snapshot,
      analysisTask: input.report.analysisTask,
      insightTask: input.report.insightTask,
      dispatch: input.report.dispatch,
      dispatchError: input.report.dispatch?.errorCode ? { operation: 'analysis', code: input.report.dispatch.errorCode, message: '任务调度：' + input.report.dispatch.errorCode } : undefined,
    })
    if (next === current) {
      setReportReadError('报告状态发生变化，请重试刷新。')
      return false
    }
    if ((['analysisTask', 'insightTask'] as const).some((operation) => {
      const previous = current[operation]
      const incoming = next[operation]
      return previous?.id !== incoming?.id || previous?.generation !== incoming?.generation || previous?.status !== incoming?.status || previous?.cancelRequested !== incoming?.cancelRequested
    })) mutationEpoch.current += 1
    updateReportView(next)
    setReportReadError('')
    reportReadFailures.current = 0
    setInsight((previous) => input.report.insight ?? previous)
    return true
  }, [])

  const reportReader = useMemo(() => createWorkspaceReportReader({
    fetch: fetchWorkspaceReport,
    apply: (identity, report) => identity.generation !== navGeneration.current || identity.reportId !== selectedReportIdRef.current || applyFetchedReport({ generation: identity.generation, expectedReportId: identity.reportId, report }),
    error: (identity) => {
      if (identity.generation === navGeneration.current && identity.reportId === selectedReportIdRef.current) {
        reportReadFailures.current += 1
        setReportReadError('报告详情刷新失败，正在等待重试。')
      }
    },
  }), [applyFetchedReport])
  useEffect(() => () => { navGeneration.current += 1; reportReader.dispose() }, [reportReader])

  const loadProject = useCallback(async (projectId: string, selection?: { stageId?: string; reportId?: string }, reportErrorNotice?: string) => {
    const generation = ++navGeneration.current
    reportReader.dispose()
    reportReadFailures.current = 0
    setReportReadError('')
    const epoch = mutationEpoch.current
    const next = await fetchWorkspaceProject(projectId, undefined, selection)
    if (generation !== navGeneration.current || epoch !== mutationEpoch.current) return next
    setDetail(next)
    const selected = next.selectedReport ?? next.stages.flatMap((group) => group.reports).find((item) => item.id === next.selected.reportId)
    if (selectedReportIdRef.current !== selected?.id) setInsight(undefined)
    updateReportView((current) => selectWorkspaceReport(current, {
      selection: next.selected,
      report: current.selectedReport?.id === selected?.id ? current.selectedReport : selected,
      latestSubmission: next.latestSubmission,
    }))
    if (selected) {
      try {
        await reportReader.read({ generation, reportId: selected.id })
      } catch (cause) {
        if (generation !== navGeneration.current || epoch !== mutationEpoch.current) return next
        showNotice(reportErrorNotice ?? (cause instanceof Error ? cause.message : '报告详情读取失败。'))
      }
    } else if (generation === navGeneration.current) {
      setInsight(undefined)
    }
    return next
  }, [reportReader, showNotice, updateReportView])

  useEffect(() => {
    const controller = new AbortController()
    void apiFetch('/api/auth/me', { signal: controller.signal })
      .then((response) => response.json())
      .then((body: { user?: SessionUser }) => { if (!controller.signal.aborted && body.user) setCurrentUser(body.user) })
      .catch(() => undefined)
    void refreshProjects(controller.signal)
    void refreshStats(controller.signal)
    void refreshLibrary(controller.signal)
    return () => controller.abort()
  }, [refreshLibrary, refreshProjects, refreshStats])

  useEffect(() => {
    function applyLocation() {
      const parsed = readWorkspaceUrl()
      setView(parsed.view)
      setActiveProjectId(parsed.projectId)
      if (parsed.stageId || parsed.reportId) {
        updateReportView(emptyWorkspaceReportView({
          stageId: parsed.stageId ?? '',
          ...(parsed.reportId ? { reportId: parsed.reportId } : {}),
          source: 'explicit',
        }))
      }
      setUrlHydrated(true)
      if (!parsed.projectId) {
        navGeneration.current += 1
        return
      }
      void loadProject(parsed.projectId, parsed.stageId || parsed.reportId ? { stageId: parsed.stageId, reportId: parsed.reportId } : undefined).catch((cause) => {
        showNotice(cause instanceof Error ? cause.message : '课题读取失败。')
      })
    }
    applyLocation()
    window.addEventListener('popstate', applyLocation)
    return () => window.removeEventListener('popstate', applyLocation)
  }, [loadProject, showNotice])

  useEffect(() => {
    if (!urlHydrated) return
    persistUrl(encodeWorkspaceUrlState({
      view,
      projectId: activeProjectId,
      selectionSource: reportView.selection.source,
      stageId: reportView.selection.stageId || undefined,
      reportId: reportView.selection.reportId,
    }))
  }, [activeProjectId, persistUrl, reportView.selection.reportId, reportView.selection.source, reportView.selection.stageId, urlHydrated, view])

  useEffect(() => {
    try { window.localStorage.setItem('yanxing_hidden_project_ids', JSON.stringify(hiddenProjectIds)) } catch { /* ignore */ }
  }, [hiddenProjectIds])

  useEffect(() => {
    const reportId = reportView.selectedReport?.id
    if (!reportId || !shouldPollReport({ dispatch: reportView.dispatch, analysisTask: reportView.analysisTask, insightTask: reportView.insightTask })) return
    let stopped = false
    let timer: number
    const poll = async () => {
      await reportReader.read({ generation: navGeneration.current, reportId })
      if (!stopped) timer = window.setTimeout(poll, Math.min(30_000, 3000 * 2 ** Math.min(reportReadFailures.current, 4)))
    }
    timer = window.setTimeout(poll, 3000)
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [reportReader, reportView.analysisTask, reportView.dispatch, reportView.insightTask, reportView.selectedReport?.id])

  useEffect(() => {
    const tasks = [reportView.analysisTask, reportView.insightTask].filter((task): task is SubmissionTask => Boolean(task && (task.status === 'queued' || task.status === 'running')))
    const reportId = reportView.selectedReport?.id
    if (tasks.length === 0 || !reportId) return
    let timer: number | undefined
    const invalidate = () => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = undefined
        const generation = navGeneration.current
        void reportReader.read({ generation, reportId })
      }, 250)
    }
    const sources = tasks.map((task) => {
      const source = new EventSource(analysisJobEventsPath(task.id))
      for (const type of NATIVE_TASK_EVENT_TYPES) source.addEventListener(type, invalidate)
      return source
    })
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      for (const source of sources) {
        for (const type of NATIVE_TASK_EVENT_TYPES) source.removeEventListener(type, invalidate)
        source.close()
      }
    }
  }, [reportReader, reportView.analysisTask?.id, reportView.analysisTask?.status, reportView.insightTask?.id, reportView.insightTask?.status, reportView.selectedReport?.id])

  function updateSubmitPhase(next: WorkspaceSubmitPhase | ((current: WorkspaceSubmitPhase) => WorkspaceSubmitPhase)) {
    const phase = typeof next === 'function' ? next(submitPhaseRef.current) : next
    submitPhaseRef.current = phase
    setSubmitPhase(phase)
  }

  function closeSubmit() {
    setSubmitOpen(false)
    updateSubmitPhase((current) => {
      if (!shouldPreserveSubmitPhase(current)) {
        setSubmitError('')
        setCompletionReplacement(undefined)
      }
      return dismissWorkspaceSubmit(current)
    })
  }

  function openSubmit() {
    setSubmitOpen(true)
    const origin = originProjectIdFromSubmit(submitPhaseRef.current) ?? preparingProjectIdRef.current
    if (origin && origin !== activeProjectId) {
      setActiveProjectId(origin)
      setView('dashboard')
      void loadProject(origin).catch((cause) => showNotice(cause instanceof Error ? cause.message : '课题读取失败。'))
    }
  }

  function handleReplaceReport(report: WorkspaceReportCard) {
    if (preparingProjectIdRef.current || hasResumableSubmit(submitPhaseRef.current)) {
      showNotice('请先处理已有准备或未确认的提交。')
      openSubmit()
      return
    }
    const group = detail?.stages.find((item) => item.stage.id === report.stageId)
    if (!detail || detail.project.id !== report.projectId || !detail.project.canSubmit
      || !group?.canSubmitCompletion || !report.capabilities.canSubmitCompletion) {
      showNotice('当前无权替换该阶段的完结报告。')
      return
    }
    if (!report.isCurrentCompletion || group.currentCompletionReportId !== report.id) {
      showNotice('阶段完结报告已变化，请刷新历史后重试。')
      return
    }
    setCompletionReplacement({ report, tokens: currentStageTokens(group, detail.workflow) })
    updateSubmitPhase(idleSubmitPhase())
    setSubmitError('')
    setSubmitOpen(true)
  }

  function openProject(projectId: string, nextView: WorkspaceView = 'dashboard') {
    setActiveProjectId(projectId)
    setView(nextView)
    void loadProject(projectId).catch((cause) => showNotice(cause instanceof Error ? cause.message : '课题读取失败。'))
  }

  function openReport(report: WorkspaceReportCard, nextView: WorkspaceView = 'dashboard') {
    setActiveProjectId(report.projectId)
    setView(nextView)
    void loadProject(report.projectId, { stageId: report.stageId, reportId: report.id }).catch((cause) => showNotice(cause instanceof Error ? cause.message : '报告读取失败。'))
  }

  function closeProjectEditor(updated?: WorkspaceProjectDetail) {
    const projectId = editProjectId
    setEditProjectId(undefined)
    if (updated) {
      setProjects((items) => items.map((item) => item.id === updated.project.id ? updated.project : item))
      showNotice('课题配置已保存。')
    }
    void refreshProjects()
    if (view === 'reports') void refreshLibrary()
    if (projectId && activeProjectId === projectId && detail?.project.id === projectId) {
      void loadProject(projectId, { stageId: detail.selected.stageId, reportId: selectedReport?.id })
        .catch(() => showNotice('课题配置窗口已关闭，但工作区刷新失败，请重新打开课题。'))
    }
  }

  function markProjectionsDirty() {
    for (const key of ['projects', 'stats', 'library'] as const) {
      dirtyProjections.current.add(key)
      projectionSequence.current[key] += 1
    }
  }

  useEffect(() => {
    if (dirtyProjections.current.has('projects')) void refreshProjects()
    if (view === 'overview' && dirtyProjections.current.has('stats')) void refreshStats()
    if (view === 'reports' && dirtyProjections.current.has('library')) void refreshLibrary()
  }, [view, dirtyRevision, refreshProjects, refreshStats, refreshLibrary])

  useEffect(() => {
    const newlyTerminal = [reportView.analysisTask, reportView.insightTask].filter((task): task is SubmissionTask => {
      if (!task || !isTerminalTask(task)) return false
      const key = task.id + ':' + task.generation
      if (terminalTasks.current.has(key)) return false
      terminalTasks.current.add(key)
      return true
    })
    if (!newlyTerminal.length) return
    markProjectionsDirty()
    setDirtyRevision((revision) => revision + 1)
    if (activeProjectId) void loadProject(activeProjectId, reportView.selection).catch(() => setRefreshError('任务已结束，但课题刷新失败。'))
  }, [reportView.analysisTask, reportView.insightTask, activeProjectId, loadProject, reportView.selection])

  function handleNavigate(nav: 'overview' | 'reports' | 'knowledge') {
    setView(nav)
    setMobileSidebarOpen(false)
  }

  async function handleCreate(project: Parameters<typeof createWorkspaceProject>[0]) {
    const created = await createWorkspaceProject(project)
    showNotice('课题已创建。')
    setDetail(created)
    openProject(created.project.id)
    await refreshProjects()
    await refreshStats()
    await refreshLibrary()
  }

  function handleReportUpload(draft: FirstReportDraft) {
    if (preparingProjectIdRef.current || hasResumableSubmit(submitPhaseRef.current)) {
      showNotice('请先处理已有准备或未确认的提交。')
      openSubmit()
      return
    }
    if (!detail || !canSubmitDraft(detail, draft)) {
      showNotice('当前无权向该阶段提交此类报告，请重新选择。')
      return
    }
    setCompletionReplacement(undefined)
    const phase = beginSubmitConfirm({ ...draft, impact: previewSubmissionImpact({ stages: detail.stages.map(group => group.stage), targetStageId: draft.stageId, reportKind: draft.reportKind }) })
    updateSubmitPhase(phase)
    setSubmitOpen(true)
    void handlePrepare()
  }

  async function handlePrepare() {
    const currentPhase = submitPhaseRef.current
    if (!detail || preparingProjectIdRef.current || hasResumableSubmit(currentPhase)) return
    let phase = currentPhase
    if (phase.step === 'failed') {
      const stageId = phase.stageId ?? detail.workflow.currentStageId ?? detail.stages[0]?.stage.id
      if (!stageId) return
      const reportKind = phase.reportKind ?? 'update'
      phase = beginSubmitConfirm({
        file: phase.file,
        stageId,
        reportKind,
        impact: previewSubmissionImpact({ stages: detail.stages.map((group) => group.stage), targetStageId: stageId, reportKind }),
      })
    }
    if (phase.step !== 'confirm') return
    if (!canSubmitDraft(detail, phase)) {
      setSubmitError('当前无权向该阶段提交此类报告，请重新选择。')
      return
    }
    const preparing = reduceWorkspaceSubmit(phase, { type: 'prepare_started' })
    if (preparing.step !== 'preparing') return
    preparingProjectIdRef.current = detail.project.id
    updateSubmitPhase(preparing)
    setSubmitError('')
    try {
      const upload = await prepareWorkspaceUpload({ projectId: detail.project.id, file: preparing.file })
      if (submitPhaseRef.current !== preparing) return
      updateSubmitPhase(reduceWorkspaceSubmit(preparing, { type: 'prepare_succeeded', upload }))
    } catch (cause) {
      if (submitPhaseRef.current !== preparing) return
      const error = cause instanceof Error ? cause.message : '文件解析失败。'
      updateSubmitPhase(reduceWorkspaceSubmit(preparing, { type: 'prepare_failed', error }))
      setSubmitError(error)
    } finally {
      preparingProjectIdRef.current = undefined
    }
  }

  async function handleCommit() {
    if (!detail) return
    const phase = submitPhaseRef.current
    if (phase.step === 'acknowledged') return
    let submitting: WorkspaceSubmitPhase = phase
    if (phase.step === 'uncertain') {
      submitting = reduceWorkspaceSubmit(phase, { type: 'commit_started', command: phase.command, idempotencyKey: phase.idempotencyKey })
    } else if (phase.step === 'conflict' && phase.tokensReady) {
      submitting = reduceWorkspaceSubmit(phase, { type: 'commit_started', command: phase.command, idempotencyKey: createIdempotencyKey() })
    } else if (phase.step === 'prepared') {
      const group = detail.stages.find((item) => item.stage.id === phase.stageId)
      if (!group) return
      submitting = reduceWorkspaceSubmit(phase, {
        type: 'commit_started',
        command: buildSubmissionCommand({
          uploadId: phase.upload.id,
          stageId: phase.stageId,
          reportKind: phase.reportKind,
          tokens: completionReplacement?.tokens ?? currentStageTokens(group, detail.workflow),
        }),
        idempotencyKey: createIdempotencyKey(),
      })
    } else {
      return
    }
    if (submitting.step !== 'submitting') return
    const originProjectId = submitting.upload.projectId
    if (originProjectId !== detail.project.id) return
    const generationAtCommit = navGeneration.current
    updateSubmitPhase(submitting)
    setSubmitError('')

    function finishSubmission(reportId: string, stageId: string) {
      setSubmitOpen(false)
      updateSubmitPhase(idleSubmitPhase())
      setCompletionReplacement(undefined)
      setSubmitError('')
      showNotice(completionReplacement
        ? '完结报告已替换，原报告已转为阶段更新报告，文件及已有分析保留。'
        : '报告已提交。若分析未立即开始，请查看调度提示，这不是提交失败。')

      markProjectionsDirty()
      void refreshProjects()
      const refreshErrorNotice = '报告已提交成功，但部分工作区数据刷新失败。请手动刷新，无需重新提交。'
      if (navGeneration.current === generationAtCommit) {
        setView(completionReplacement ? 'history' : 'dashboard')
        void loadProject(originProjectId, { stageId, reportId }, refreshErrorNotice)
          .catch(() => showNotice(refreshErrorNotice))
      }
      for (const refresh of [refreshStats, refreshLibrary]) {
        void refresh().then((refreshed) => {
          if (refreshed === false) showNotice(refreshErrorNotice)
        })
      }
    }

    try {
      const result = await confirmWorkspaceSubmission({
        projectId: originProjectId,
        command: submitting.command,
        idempotencyKey: submitting.idempotencyKey,
      })
      updateSubmitPhase((current) => reduceWorkspaceSubmit(current, { type: 'commit_acknowledged', receipt: result.receipt, replayed: result.replayed }))
      finishSubmission(result.receipt.reportId, result.receipt.stageId)
    } catch (cause) {
      const payload = cause instanceof WorkspaceRequestError ? cause.payload : { status: undefined, code: undefined, error: cause instanceof Error ? cause.message : '提交结果未确认。' }
      const classified = classifyCommitFailure({ status: payload.status, code: payload.code, previouslyUncertain: submitting.previouslyUncertain })
      if (classified === 'rejected') {
        updateSubmitPhase((current) => reduceWorkspaceSubmit(current, { type: 'commit_rejected', error: payload.error, code: payload.code }))
        setSubmitError(payload.error)
        return
      }
      if (classified === 'conflict') {
        let tokensReady = false
        let tokens: ReturnType<typeof currentStageTokens> | undefined
        try {
          if (navGeneration.current === generationAtCommit) {
            const refreshing = loadProject(originProjectId, { stageId: submitting.stageId })
            const refreshGeneration = navGeneration.current
            const refreshed = await refreshing
            if (refreshGeneration !== navGeneration.current) throw new Error('课题选择已变化。')
            const nextGroup = refreshed.stages.find((item) => item.stage.id === submitting.stageId)
            if (nextGroup) {
              tokens = currentStageTokens(nextGroup, refreshed.workflow)
              tokensReady = true
            }
          }
        } catch {
          tokensReady = false
        }
        updateSubmitPhase((current) => reduceWorkspaceSubmit(current, {
          type: 'commit_conflict',
          conflict: cause instanceof WorkspaceRequestError ? conflictFromError(cause) : { code: payload.code ?? 'PROJECT_WORKFLOW_CHANGED', error: payload.error ?? '课题状态已变化。' },
          tokens,
          tokensReady,
        }))
        setSubmitError(payload.error ?? '请重新确认提交。')
        return
      }
      if (classified === 'already_committed' || classified === 'reconcile' || (classified === 'uncertain' && payload.status && payload.status < 500)) {
        try {
          const upload = await readWorkspaceUpload(originProjectId, submitting.upload.id)
          const committedReportId = upload.reportId
          if (committedReportId) {
            finishSubmission(committedReportId, submitting.stageId)
            return
          }
          const checked = reduceWorkspaceSubmit(submitting, { type: 'upload_checked', upload, code: payload.code, error: payload.error })
          if (checked.step !== 'submitting') {
            updateSubmitPhase(checked)
            setSubmitError(payload.error)
            return
          }
        } catch {
          // fall through to uncertain retry of the same request
        }
      }
      const error = describeCommitNetworkError(cause, payload.error ?? '提交结果未确认。将使用相同幂等键重试，不会重新解析文件。')
      updateSubmitPhase((current) => reduceWorkspaceSubmit(current, { type: 'commit_uncertain', error }))
      setSubmitError(error)
    }
  }

  async function handleConflictRefresh() {
    const phase = submitPhaseRef.current
    if (!detail || phase.step !== 'conflict' || conflictRefreshRef.current) return
    conflictRefreshRef.current = true
    const originProjectId = phase.upload.projectId
    try {
      const refreshing = loadProject(originProjectId, { stageId: phase.stageId })
      const generation = navGeneration.current
      const refreshed = await refreshing
      if (generation !== navGeneration.current || phase !== submitPhaseRef.current) return
      const nextGroup = refreshed.stages.find((item) => item.stage.id === phase.stageId)
      if (!nextGroup) {
        updateSubmitPhase((current) => reduceWorkspaceSubmit(current, { type: 'refresh_failed', error: '目标阶段已不存在。' }))
        return
      }
      updateSubmitPhase((current) => reduceWorkspaceSubmit(current, { type: 'conflict_refreshed', tokens: currentStageTokens(nextGroup, refreshed.workflow) }))
      setSubmitError('')
    } catch (cause) {
      if (phase === submitPhaseRef.current) {
        updateSubmitPhase((current) => reduceWorkspaceSubmit(current, { type: 'refresh_failed', error: cause instanceof Error ? cause.message : '课题刷新失败。' }))
        setSubmitError('课题刷新失败，请重试。')
      }
    } finally {
      conflictRefreshRef.current = false
    }
  }

  function invalidateReport(reportId: string) {
    mutationEpoch.current += 1
    reportReader.invalidate(reportId)
  }

  function rereadSelectedReport(reportId: string) {
    invalidateReport(reportId)
    if (selectedReportIdRef.current === reportId) void reportReader.read({ generation: navGeneration.current, reportId })
  }

  async function startAnalysis() {
    if (!selectedReport) return
    const generation = navGeneration.current
    invalidateReport(selectedReport.id)
    try {
      const result = await startWorkspaceTask(workspacePath(WORKSPACE_API.reportAnalyze, { reportId: selectedReport.id }))
      if (!result.job) throw new Error('分析任务响应缺少 job。')
      invalidateReport(selectedReport.id)
      if (generation === navGeneration.current) updateReportView((current) => applyWorkspaceAnalysisTask(current, result.job))
      showNotice('分析任务状态已同步。')
    } catch (cause) {
      showNotice('执行结果暂未确认。' + (cause instanceof Error ? cause.message : '请刷新任务状态。'))
    } finally {
      rereadSelectedReport(selectedReport.id)
    }
  }

  async function startInsight() {
    if (!selectedReport) return
    const generation = navGeneration.current
    invalidateReport(selectedReport.id)
    try {
      const result = await startWorkspaceTask(workspacePath(WORKSPACE_API.reportInsight, { reportId: selectedReport.id }))
      if (!result.job) throw new Error('洞察任务响应缺少 job。')
      invalidateReport(selectedReport.id)
      if (generation === navGeneration.current) updateReportView((current) => applyWorkspaceInsightTask(current, result.job))
      showNotice('洞察任务状态已同步。')
    } catch (cause) {
      showNotice('执行结果暂未确认。' + (cause instanceof Error ? cause.message : '请刷新任务状态。'))
    } finally {
      rereadSelectedReport(selectedReport.id)
    }
  }

  async function cancelAnalysis() {
    const jobId = reportView.analysisTask?.id
    if (!jobId || cancellingAnalysis) return
    const reportId = reportViewRef.current.selectedReport?.id
    if (!reportId) return
    const generation = navGeneration.current
    invalidateReport(reportId)
    setCancellingAnalysis(true)
    try {
      const job = await cancelWorkspaceTask(jobId)
      invalidateReport(reportId)
      if (generation === navGeneration.current) updateReportView((current) => applyWorkspaceAnalysisTask(current, job))
      showNotice('已请求停止分析，完成前仍不可删除报告。')
    } catch (cause) {
      showNotice(cause instanceof Error ? cause.message : '停止分析失败。')
    } finally {
      setCancellingAnalysis(false)
      rereadSelectedReport(reportId)
    }
  }

  async function cancelInsight() {
    const jobId = reportView.insightTask?.id
    if (!jobId || cancellingInsight) return
    const reportId = reportViewRef.current.selectedReport?.id
    if (!reportId) return
    const generation = navGeneration.current
    invalidateReport(reportId)
    setCancellingInsight(true)
    try {
      const job = await cancelWorkspaceTask(jobId)
      invalidateReport(reportId)
      if (generation === navGeneration.current) updateReportView((current) => applyWorkspaceInsightTask(current, job))
      showNotice('已请求停止洞察。')
    } catch (cause) {
      showNotice(cause instanceof Error ? cause.message : '停止洞察失败。')
    } finally {
      setCancellingInsight(false)
      rereadSelectedReport(reportId)
    }
  }

  const showReportOnboarding = view === 'dashboard' && !selectedReport
  const isProjectDetail = (view === 'dashboard' || view === 'insight' || view === 'content' || view === 'history') && Boolean(detail)
  const isFixedProjectView = isProjectDetail
  const activeNav: 'overview' | 'reports' | 'knowledge' | 'project' = isProjectDetail || view === 'project-guide' ? 'project' : view === 'reports' ? 'reports' : view === 'knowledge' ? 'knowledge' : 'overview'

  return (
    <main className="yx-workspace min-h-screen overflow-x-hidden bg-[var(--yx-bg)] sm:grid sm:h-screen sm:grid-cols-[16.5rem_minmax(0,1fr)] sm:grid-rows-[3.25rem_minmax(0,1fr)] sm:overflow-hidden lg:grid-cols-[18rem_minmax(0,1fr)]">
      <MainNavigationPanel
        activeNav={activeNav}
        onNavigate={handleNavigate}
        projects={listedProjects}
        currentUserId={currentUser?.id}
        activeProjectId={activeProjectId}
        onSelectProject={(project) => openProject(project.id)}
        onOpenProjectGuide={() => setView('project-guide')}
        reportCount={stats?.submittedReportCount}
        knowledgeCount={stats?.knowledgeCount}
        onSearch={() => setSearchOpen(true)}
      />
      <WorkspaceTopbar
        brand={
          <div className="flex min-w-0 items-center gap-2">
            <button type="button" onClick={() => setMobileSidebarOpen(true)} className="flex h-8 w-8 items-center justify-center rounded-lg text-yx-muted hover:bg-yx-hover sm:hidden" aria-label="打开工作台导航">
              <Menu className="h-4 w-4" />
            </button>
            <div className="flex items-center sm:hidden"><BrandLogo compact /></div>
            <div className="hidden min-w-0 items-center gap-2 text-xs font-semibold text-yx-ink sm:flex">
              {isProjectDetail && activeProject ? (
                <span className="truncate">{activeProject.title}</span>
              ) : view === 'project-guide' ? '设立研究课题' : (
                <>
                  <span className="shrink-0 text-base font-bold leading-none">{view === 'reports' ? '报告库' : view === 'knowledge' ? '知识库' : '总览'}</span>
                  <span className="h-3.5 w-px shrink-0 bg-yx-line" aria-hidden="true" />
                  <span className="min-w-0 truncate font-medium text-yx-muted">{view === 'reports' ? '按课题分类汇聚全部报告提交，支持检索、正文阅读与分析追溯。' : view === 'knowledge' ? '上传与检索行业参考研报、政策文件与背景资料，为研究分析提供前沿参考。' : '持续跟踪研究课题、报告提交与分析质量全景。'}</span>
                </>
              )}
            </div>
          </div>
        }
        tools={<TopbarUserNav user={currentUser} onSettings={() => setSettingsOpen(true)} onSettingsIntent={preloadWorkspaceDialogs} onEditProfile={() => setEditProfileOpen(true)} onSearch={() => setSearchOpen(true)} />}
      />
      {mobileSidebarOpen ? (
        <div className="fixed inset-0 z-40 sm:hidden">
          <button type="button" className="absolute inset-0 bg-black/30" aria-label="关闭导航" onClick={() => setMobileSidebarOpen(false)} />
          <div className="relative z-10 h-full w-72 bg-[var(--yx-bg)]">
            <MainNavigationPanel
              mobile
              activeNav={activeNav}
              onNavigate={handleNavigate}
              projects={listedProjects}
              currentUserId={currentUser?.id}
              activeProjectId={activeProjectId}
              onSelectProject={(project) => { openProject(project.id); setMobileSidebarOpen(false) }}
              onOpenProjectGuide={() => { setView('project-guide'); setMobileSidebarOpen(false) }}
              reportCount={stats?.submittedReportCount}
              knowledgeCount={stats?.knowledgeCount}
              onSearch={() => { setSearchOpen(true); setMobileSidebarOpen(false) }}
            />
          </div>
        </div>
      ) : null}
      <section
        aria-label="主工作区"
        className={`min-h-0 min-w-0 bg-[var(--yx-surface)] sm:col-start-2 sm:row-start-2 ${isFixedProjectView ? 'overflow-hidden' : 'yx-subtle-scrollbar overflow-x-hidden overflow-y-auto'}`}
      >
        <div className={`mx-auto flex w-full max-w-[1380px] flex-col px-4 sm:px-8 lg:px-12 ${isFixedProjectView ? 'h-full min-h-0 pt-4 pb-4 sm:pt-5 sm:pb-5 xl:pt-5 xl:pb-5' : isProjectDetail ? 'min-h-full pb-12 pt-4 sm:pt-5 xl:pt-5' : 'min-h-full pb-8 pt-7 sm:pt-8'}`}>
          {refreshError || reportReadError ? <div role="alert" className="mb-3 text-sm text-yx-warning-text">
            {refreshError || reportReadError} <button type="button" className="underline" onClick={() => {
              setRefreshError('')
              void Promise.allSettled([
                ...(activeProjectId ? [loadProject(activeProjectId, reportViewRef.current.selection)] : []),
                refreshProjects(), refreshStats(), refreshLibrary(),
              ]).then((results) => {
                if (results.some((result) => result.status === 'rejected' || result.value === false)) setRefreshError('部分视图仍未刷新，请稍后重试。')
              })
            }}>重试刷新</button>
          </div> : null}
          {isProjectDetail && detail ? (
            <WorkspacePageHeader>
              <WorkspaceProjectHeader detail={detail} />
            </WorkspacePageHeader>
          ) : null}
          <div className={`relative min-w-0 ${isFixedProjectView ? 'mt-3 min-h-0 flex-1 flex flex-col xl:mt-4' : isProjectDetail ? 'mt-3 xl:mt-4' : 'mt-0'}`}>
            {view === 'overview' ? (
              <OverviewWorkspace
                projects={listedProjects}
                stats={stats}
                statsState={statsState}
                projectsState={projectsState}
                recentReports={recentReports}
                activityReports={activityReports}
                knowledgeItems={recentKnowledge}
                upstreamError={loadError}
                userName={currentUser?.displayName || currentUser?.username}
                onSelect={(project) => openProject(project.id)}
                onNavigate={(next) => setView(next)}
                onOpenReport={(report) => openReport(report)}
              />
            ) : null}
            {view === 'reports' ? (
              <ReportsRepositoryWorkspace projects={projects} reports={libraryReports} loading={!libraryLoaded && !libraryError} hasLoaded={libraryLoaded} loadError={libraryError} onRetry={() => void refreshLibrary()} onOpenReport={(report, _project, mode) => openReport(report, mode)} onSelectProject={(project) => openProject(project.id)} />
            ) : null}
            {view === 'knowledge' ? <KnowledgeBaseWorkspace onNotice={showNotice} onKnowledgeCountChange={() => void refreshStats()} /> : null}
            {isProjectDetail && detail ? (
              <div className={`relative min-w-0 ${isFixedProjectView ? 'min-h-0 flex-1 flex flex-col' : ''}`}>
                <div className="hidden min-[1760px]:block absolute right-[calc(100%+0.75rem)] top-0 h-full pointer-events-none z-20">
                  <div className="sticky top-4 pointer-events-auto w-20"><ProjectSideNav activeTab={view as ProjectTabId} onTabChange={(tab) => setView(tab)} /></div>
                </div>
                <div className="block min-[1760px]:hidden mb-4"><ProjectSideNav activeTab={view as ProjectTabId} onTabChange={(tab) => setView(tab)} /></div>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  {view === 'dashboard' ? (
                    <DashboardView
                      report={selectedReport}
                      emptyState={showReportOnboarding ? (
                        <ProjectFirstReportOnboarding
                          key={detail.project.id}
                          detail={detail}
                          onSubmit={handleReportUpload}
                          onResumeSubmit={hasResumableSubmit(submitPhase) ? openSubmit : undefined}
                        />
                      ) : undefined}
                      snapshot={reportView.snapshot}
                      analysisTask={reportView.analysisTask}
                      canManage={detail.project.canSubmit}
                      viewingHistorical={Boolean(selectedReport && detail.latestSubmission && selectedReport.id !== detail.latestSubmission.id)}
                      cancellingAnalysis={cancellingAnalysis}
                      onStartAnalysis={() => void startAnalysis()}
                      onCancelAnalysis={cancelAnalysis}
                      onReturnToLatest={detail.latestSubmission ? () => openReport(detail.latestSubmission!) : undefined}
                      onEditProject={detail.project.canManage ? () => setEditProjectId(detail.project.id) : undefined}
                      onUpdateReport={detail.project.canSubmit ? openSubmit : undefined}
                    />
                  ) : null}
                  {view === 'insight' ? (
                    <InsightWorkspace
                      report={selectedReport}
                      insight={insight}
                      insightTask={reportView.insightTask}
                      dispatchError={reportView.dispatchError?.operation === 'insight' ? reportView.dispatchError.message : undefined}
                      canManage={detail.project.canSubmit}
                      generating={cancellingInsight ? false : undefined}
                      onGenerate={() => void startInsight()}
                      onCancel={() => void cancelInsight()}
                      onNavigate={(tab) => setView(tab)}
                    />
                  ) : null}
                  {view === 'content' ? <ReportDocumentViewer report={selectedReport ? documentSourceFromReport(selectedReport) : undefined} onUpload={detail.project.canSubmit ? () => setView('dashboard') : undefined} /> : null}
                  {view === 'history' ? (
                    <ReportHistoryView
                      groups={detail.stages}
                      selectedReportId={selectedReport?.id}
                      latestSubmissionId={detail.latestSubmission?.id}
                      onOpenReport={(report) => openReport(report)}
                      onDeleteReport={detail.project.canSubmit ? (report) => setDeleteReport(report) : undefined}
                      onReplaceReport={detail.project.canSubmit ? handleReplaceReport : undefined}
                      onUpload={detail.project.canSubmit ? () => setView('dashboard') : undefined}
                    />
                  ) : null}
                </div>
              </div>
            ) : null}
            {view === 'project-guide' ? <ProjectSetupGuideView users={users} currentUser={currentUser} onCreate={handleCreate} /> : null}
          </div>
        </div>
      </section>
      {notice ? <Toast message={notice} /> : null}
      {searchOpen ? <WorkspaceSearchDialog projects={listedProjects} onClose={() => setSearchOpen(false)} onSelect={(project) => { setSearchOpen(false); openProject(project.id) }} /> : null}
      {settingsOpen ? (
        <Suspense fallback={<WorkspaceDialogLoading onClose={() => setSettingsOpen(false)} />}><AdminSettingsDialog
          currentUser={currentUser}
          projects={listedProjects}
          onClose={() => setSettingsOpen(false)}
          onEditProject={(project) => { setEditProjectId(project.id); setSettingsOpen(false) }}
          onProjectsChanged={() => { void refreshProjects(); void refreshStats(); void refreshLibrary() }}
          hiddenProjectIds={hiddenProjectIds}
          onToggleHideProject={(projectId) => setHiddenProjectIds((current) => toggleHiddenProjectId(current, projectId))}
        /></Suspense>
      ) : null}
      {editProfileOpen && currentUser ? <EditProfileDialog user={currentUser} onClose={() => setEditProfileOpen(false)} onUpdated={(user) => { setCurrentUser(user); setEditProfileOpen(false) }} /> : null}
      {editProjectId ? (
        <WorkspaceProjectEditEntry
          key={editProjectId}
          projectId={editProjectId}
          currentUser={currentUser}
          onClose={() => closeProjectEditor()}
          onSaved={closeProjectEditor}
        />
      ) : null}
      {submitOpen && detail && submitPhase.step === 'idle' && !completionReplacement ? (
        <WorkspaceUpdateReportDialog
          key={detail.project.id}
          detail={detail}
          onSubmit={handleReportUpload}
          onClose={closeSubmit}
        />
      ) : submitOpen && detail ? (
        <WorkspaceSubmitDialog
          groups={detail.stages}
          defaultStageId={reportView.selection.stageId || detail.workflow.currentStageId}
          replacementReport={completionReplacement?.report}
          canSubmit={detail.project.canSubmit}
          phase={submitPhase}
          error={submitError}
          currentProjectId={detail.project.id}
          onFile={(file) => updateSubmitPhase((current) => reduceWorkspaceSubmit(current, { type: 'select_file', file }))}
          onConfigure={(stageId, reportKind, impact) => updateSubmitPhase((current) => reduceWorkspaceSubmit(current, { type: 'configure', stageId, reportKind, impact }))}
          onPrepare={() => void handlePrepare()}
          onCommit={() => void handleCommit()}
          onRefreshConflict={() => void handleConflictRefresh()}
          onClose={closeSubmit}
        />
      ) : null}
      {deleteReport ? (
        <WorkspaceDeleteReportDialog
          report={deleteReport}
          analysisTask={reportView.selectedReport?.id === deleteReport.id ? reportView.analysisTask : undefined}
          insightTask={reportView.selectedReport?.id === deleteReport.id ? reportView.insightTask : undefined}
          onClose={() => setDeleteReport(undefined)}
          onDelete={async (reason) => {
            const deleted = deleteReport
            const generationAtDelete = navGeneration.current
            invalidateReport(deleted.id)
            await deleteWorkspaceReport(deleted.id, reason)
            invalidateReport(deleted.id)
            setDeleteReport(undefined)
            showNotice('报告已删除。')
            markProjectionsDirty()
            const current = reportViewRef.current
            const deletingSelected = current.selectedReport?.id === deleted.id
            if (deletingSelected) {
              updateReportView(removeWorkspaceReport(current, deleted.id))
              setInsight(undefined)
            }
            setDetail((previous) => previous?.project.id === deleted.projectId ? {
              ...previous,
              ...(previous.selected.reportId === deleted.id ? { selected: { stageId: deleted.stageId, source: 'explicit' as const }, selectedReport: undefined } : {}),
              latestSubmission: previous.latestSubmission?.id === deleted.id ? undefined : previous.latestSubmission,
              stages: previous.stages.map((group) => ({ ...group, reports: group.reports.filter((report) => report.id !== deleted.id) })),
            } : previous)
            const refreshed = await refreshWorkspaceProjections([
              ...(detail?.project.id === deleted.projectId && generationAtDelete === navGeneration.current ? [() => loadProject(deleted.projectId, deletingSelected ? { stageId: deleted.stageId } : current.selection)] : []),
              refreshProjects, refreshStats, refreshLibrary,
            ])
            if (!refreshed) setRefreshError('报告已删除，但部分视图刷新失败。请重试刷新，无需再次删除。')
          }}
        />
      ) : null}
    </main>
  )
}

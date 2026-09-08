'use client'

import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { apiFetch } from '@/lib/client-request'
import {
  analysisJobEventsPath,
  applyJobProgressEventToJob,
  applyJobProgressEventToModuleStates,
  isJobProgressEventNewer,
  parseJobProgressEvent,
  shouldRefreshModuleProgressFromEvent,
  terminalAnalysisJobStatuses,
  type JobProgressEvent,
} from '@/lib/analysis-job-progress'
import type { AnalysisJob } from '@/modules/analysis/domain'
import type { AnalysisJobEventType, AnalysisModuleState } from '@/modules/contracts/analysis'

const progressPollIntervalMs = 3_000
const maxRememberedEventCursors = 32

type TerminalHandlerResult = boolean | undefined | Promise<boolean | undefined>

export function useAnalysisJobEvents({
  activeJobId,
  setAnalysisJob,
  setAnalysisModuleStates,
  setActiveJobId,
  onSnapshotUpdated,
  onTerminal,
}: {
  activeJobId?: string
  setAnalysisJob: Dispatch<SetStateAction<AnalysisJob | undefined>>
  setAnalysisModuleStates: Dispatch<SetStateAction<AnalysisModuleState[]>>
  setActiveJobId: Dispatch<SetStateAction<string | undefined>>
  onSnapshotUpdated: () => void
  onTerminal: (jobId: string) => TerminalHandlerResult
}) {
  const onSnapshotUpdatedRef = useRef(onSnapshotUpdated)
  onSnapshotUpdatedRef.current = onSnapshotUpdated
  const onTerminalRef = useRef(onTerminal)
  onTerminalRef.current = onTerminal
  const effectGenerationRef = useRef(0)
  const eventCursorRef = useRef(new Map<string, number>())

  useEffect(() => {
    const generation = ++effectGenerationRef.current
    let cancelled = false
    let terminalHandled = false
    let terminalPolling = false
    let terminalReconciliationInFlight = false
    let pollTimer: number | undefined
    let refreshSequence = 0
    let refreshController: AbortController | undefined
    let source: EventSource | undefined

    const isCurrent = () => !cancelled && effectGenerationRef.current === generation
    if (!activeJobId) return
    const jobId = activeJobId

    const stopPolling = () => {
      if (pollTimer === undefined) return
      window.clearInterval(pollTimer)
      pollTimer = undefined
    }

    function invalidateRefresh() {
      refreshSequence += 1
      refreshController?.abort()
      refreshController = undefined
    }

    function finishMissingJob() {
      if (!isCurrent()) return
      if (terminalHandled) {
        terminalPolling = false
        stopPolling()
        source?.close()
        setActiveJobId(undefined)
        return
      }
      terminalHandled = true
      stopPolling()
      source?.close()
      setActiveJobId(undefined)
      void Promise.resolve().then(() => onTerminalRef.current(jobId)).catch(() => undefined)
    }

    async function reconcileTerminal() {
      if (!isCurrent() || terminalReconciliationInFlight) return
      terminalReconciliationInFlight = true
      try {
        const result = await onTerminalRef.current(jobId)
        if (!isCurrent()) return
        if (result === true) {
          terminalPolling = false
          stopPolling()
          setActiveJobId(undefined)
          return
        }
        terminalPolling = true
        startPolling()
      } catch {
        if (!isCurrent()) return
        terminalPolling = true
        startPolling()
      } finally {
        terminalReconciliationInFlight = false
      }
    }

    function finishTerminalJob() {
      if (!isCurrent() || terminalHandled) return
      terminalHandled = true
      terminalPolling = false
      stopPolling()
      source?.close()
      void reconcileTerminal()
    }

    async function refreshProgress() {
      if (!isCurrent() || (!terminalPolling && terminalHandled)) return
      const sequence = ++refreshSequence
      refreshController?.abort()
      const controller = new AbortController()
      refreshController = controller
      try {
        const response = await apiFetch('/api/jobs/' + jobId, { cache: 'no-store', signal: controller.signal }).catch(() => null)
        const body = await response?.json().catch(() => null) as { job?: AnalysisJob; moduleStates?: AnalysisModuleState[] } | null
        if (!isCurrent() || controller.signal.aborted || sequence !== refreshSequence) return
        if (response && (response.status === 403 || response.status === 404 || (response.ok && !body?.job))) {
          finishMissingJob()
          return
        }
        if (!body?.job || body.job.id !== jobId) return

        const staleTerminalRefresh = terminalHandled && !terminalAnalysisJobStatuses.has(body.job.status)
        if (!staleTerminalRefresh) {
          setAnalysisJob((current) => isCurrent() ? body.job : current)
          setAnalysisModuleStates((current) => isCurrent() ? body.moduleStates ?? [] : current)
        }
        if (terminalAnalysisJobStatuses.has(body.job.status)) {
          if (terminalHandled) void reconcileTerminal()
          else finishTerminalJob()
        } else if (terminalHandled) {
          terminalPolling = true
        }
      } finally {
        if (refreshController === controller) refreshController = undefined
      }
    }

    function syncProgress(event: JobProgressEvent) {
      setAnalysisJob((current) => isCurrent() ? applyJobProgressEventToJob(current, event) : current)
      setAnalysisModuleStates((current) => {
        if (!isCurrent()) return current
        const previous = current.find((state) => state.moduleId === 'page_analysis')
        const next = applyJobProgressEventToModuleStates(current, event)
        if (shouldRefreshModuleProgressFromEvent(event, previous)) queueMicrotask(() => { if (isCurrent()) void refreshProgress() })
        return next
      })
    }

    function rememberEventCursor(event: JobProgressEvent) {
      if (event.id === undefined) return
      const cursors = eventCursorRef.current
      cursors.set(jobId, event.id)
      if (cursors.size <= maxRememberedEventCursors) return
      for (const key of cursors.keys()) {
        if (key === jobId) continue
        cursors.delete(key)
        break
      }
    }

    function acceptEvent(event: JobProgressEvent) {
      const lastEventId = eventCursorRef.current.get(jobId)
      if (!isJobProgressEventNewer(event, lastEventId)) return false
      rememberEventCursor(event)
      return true
    }

    function startPolling() {
      if (pollTimer !== undefined || !isCurrent() || (!terminalPolling && terminalHandled)) return
      pollTimer = window.setInterval(() => { void refreshProgress() }, progressPollIntervalMs)
      void refreshProgress()
    }

    const eventNames: AnalysisJobEventType[] = ['info', 'stage', 'module_started', 'module_gating', 'module_retrying', 'module_accepted', 'module_failed', 'snapshot_updated', 'completed', 'failed', 'cancelled']
    const handleEvent = (event: Event) => {
      if (!isCurrent() || terminalHandled) return
      const progressEvent = parseJobProgressEvent(event as MessageEvent<string>)
      if (!progressEvent || (progressEvent.jobId !== undefined && progressEvent.jobId !== jobId) || !acceptEvent(progressEvent)) return
      invalidateRefresh()
      syncProgress(progressEvent)
      if (progressEvent.type === 'snapshot_updated') onSnapshotUpdatedRef.current()
      if (progressEvent.type === 'completed' || progressEvent.type === 'failed' || progressEvent.type === 'cancelled') finishTerminalJob()
    }

    const eventSource = new EventSource(analysisJobEventsPath(jobId, eventCursorRef.current.get(jobId)))
    source = eventSource
    eventNames.forEach((eventName) => eventSource.addEventListener(eventName, handleEvent))
    eventSource.onopen = () => {
      if (!isCurrent() || terminalHandled) return
      stopPolling()
      invalidateRefresh()
      void refreshProgress()
    }
    eventSource.onerror = () => {
      if (!isCurrent() || terminalHandled) return
      startPolling()
    }

    return () => {
      cancelled = true
      stopPolling()
      invalidateRefresh()
      eventNames.forEach((eventName) => eventSource.removeEventListener(eventName, handleEvent))
      eventSource.close()
    }
  }, [activeJobId, setActiveJobId, setAnalysisJob, setAnalysisModuleStates])
}

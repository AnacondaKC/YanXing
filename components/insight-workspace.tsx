'use client'

import { AlertCircle, Clock3, Loader2, Maximize2, Minimize2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceEntrance } from '@/components/use-workspace-entrance'
import type { ProjectTabId } from '@/components/project-executive-header'
import { useDialogFocus } from '@/components/use-dialog-focus'
import { apiFetch, mutationHeaders } from '@/lib/client-request'
import { InsightEmptyState } from '@/components/insight-empty-state'
import { MAX_INSIGHT_REGENERATIONS } from '@/modules/contracts/analysis'
import type { ReportInsight } from '@/modules/insights/domain'
import type { ReportVersion } from '@/modules/reports/domain'

import { renderInsightDocument } from '@/lib/rendering/markdown'

type InsightApiResponse = { insight?: ReportInsight; generating?: boolean; code?: string; error?: string; job?: { id: string; status?: string; errorMessage?: string } }

const INSIGHT_POLL_MS = 2000

function hardenInsightHtmlForRender(html: string) {
  return renderInsightDocument(html)
}

export function isInsightGenerationInFlight(body: InsightApiResponse | null | undefined) {
  return Boolean(body?.generating || body?.code === 'INSIGHT_GENERATING' || body?.job?.status === 'queued' || body?.job?.status === 'running')
}

export function isCurrentInsightRequest(input: {
  requestReportId: string
  requestFileHash?: string
  requestGeneration: number
  activeReportId?: string
  activeFileHash?: string
  activeGeneration: number
}) {
  return input.requestReportId === input.activeReportId
    && input.requestFileHash === input.activeFileHash
    && input.requestGeneration === input.activeGeneration
}

function insightFailureMessage(body: InsightApiResponse | null | undefined) {
  if (body?.job?.status === 'failed') return body.job.errorMessage?.trim() || '报告洞察未生成。'
  return ''
}

async function readInsightApiResponse(response: Response): Promise<InsightApiResponse> {
  const text = await response.text()
  if (!text.trim()) return { error: `洞察服务未返回内容（HTTP ${response.status}）。` }
  try {
    const body = JSON.parse(text) as unknown
    return body && typeof body === 'object' && !Array.isArray(body)
      ? body as InsightApiResponse
      : { error: `洞察服务返回格式异常（HTTP ${response.status}）。` }
  } catch {
    return { error: `洞察服务返回格式异常（HTTP ${response.status}）。` }
  }
}

export function InsightWorkspace({
  report,
  canManage,
  canGenerateInsight = true,
  onNavigate,
}: {
  report?: ReportVersion
  canManage: boolean
  canGenerateInsight?: boolean
  onNavigate?: (tab: ProjectTabId) => void
}) {
  const [insight, setInsight] = useState<ReportInsight>()
  const [loading, setLoading] = useState(Boolean(report))
  const { entranceProps } = useWorkspaceEntrance(loading)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [readingProgress, setReadingProgress] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const frameCleanupRef = useRef<(() => void) | undefined>(undefined)
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null)
  const activeReportIdRef = useRef(report?.id)
  const activeFileHashRef = useRef(report?.fileHash)
  const requestGenerationRef = useRef(0)
  const generateControllerRef = useRef<AbortController | undefined>(undefined)
  activeReportIdRef.current = report?.id
  activeFileHashRef.current = report?.fileHash
  const closeExpanded = useCallback(() => setExpanded(false), [])
  const workspaceRef = useDialogFocus(closeExpanded, fullscreenButtonRef, expanded)
  const renderedInsightHtml = useMemo(() => insight ? hardenInsightHtmlForRender(insight.html) : '', [insight])
  useEffect(() => {
    setInsight(undefined)
    setGenerating(false)
    setError('')
    setReadingProgress(0)
    generateControllerRef.current?.abort()
    const generation = ++requestGenerationRef.current
    if (!report?.id) {
      setLoading(false)
      return
    }

    const reportId = report.id
    const fileHash = report.fileHash
    const controller = new AbortController()
    setLoading(true)
    const isCurrent = () => isCurrentInsightRequest({
      requestReportId: reportId,
      requestFileHash: fileHash,
      requestGeneration: generation,
      activeReportId: activeReportIdRef.current,
      activeFileHash: activeFileHashRef.current,
      activeGeneration: requestGenerationRef.current,
    })
    apiFetch(`/api/reports/${reportId}/insight`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const body = await readInsightApiResponse(response)
        if (controller.signal.aborted || !isCurrent()) return
        setInsight(body.insight)
        const failure = insightFailureMessage(body)
        if (failure) {
          setError(failure)
          return
        }
        if (!response.ok || (body.error && !isInsightGenerationInFlight(body))) {
          throw new Error(body.error ?? '洞察读取失败。')
        }
        setGenerating(isInsightGenerationInFlight(body))
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted && isCurrent()) setError(loadError instanceof Error ? loadError.message : '洞察读取失败。')
      })
      .finally(() => { if (!controller.signal.aborted && isCurrent()) setLoading(false) })
    return () => {
      requestGenerationRef.current += 1
      controller.abort()
      generateControllerRef.current?.abort()
    }
  }, [report?.id, report?.fileHash])

  useEffect(() => {
    if (!generating || !report?.id) return
    const reportId = report.id
    const fileHash = report.fileHash
    const generation = requestGenerationRef.current
    const controller = new AbortController()
    let timer: number | undefined
    const isCurrent = () => isCurrentInsightRequest({
      requestReportId: reportId,
      requestFileHash: fileHash,
      requestGeneration: generation,
      activeReportId: activeReportIdRef.current,
      activeFileHash: activeFileHashRef.current,
      activeGeneration: requestGenerationRef.current,
    })
    const poll = () => {
      timer = window.setTimeout(() => {
        void apiFetch(`/api/reports/${reportId}/insight`, { cache: 'no-store', signal: controller.signal })
          .then(async (response) => {
            const body = await readInsightApiResponse(response)
            if (controller.signal.aborted || !isCurrent()) return
            setInsight(body.insight)
            const failure = insightFailureMessage(body)
            if (failure) {
              setGenerating(false)
              setError(failure)
              return
            }
            if (!response.ok || (body.error && !isInsightGenerationInFlight(body))) {
              throw new Error(body.error ?? '洞察读取失败。')
            }
            if (isInsightGenerationInFlight(body)) poll()
            else setGenerating(false)
          })
          .catch((loadError: unknown) => {
            if (controller.signal.aborted || !isCurrent()) return
            // 轮询一旦失败必须解除 generating：否则遮罩永挂、重试按钮永久禁用。
            setGenerating(false)
            setError(loadError instanceof Error ? loadError.message : '洞察读取失败。')
          })
      }, INSIGHT_POLL_MS)
    }
    poll()
    return () => {
      controller.abort()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [generating, report?.id, report?.fileHash])

  useEffect(() => () => {
    frameCleanupRef.current?.()
  }, [])

  useEffect(() => {
    if (!expanded) return
    const previousDocumentOverflow = document.documentElement.style.overflow
    const previousBodyOverflow = document.body.style.overflow
    document.documentElement.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
    return () => {
      document.documentElement.style.overflow = previousDocumentOverflow
      document.body.style.overflow = previousBodyOverflow
    }
  }, [expanded])

  async function generateInsight() {
    const reportId = report?.id
    const fileHash = report?.fileHash
    if (!reportId || !canManage || !canGenerateInsight || generating) return
    const generation = requestGenerationRef.current
    generateControllerRef.current?.abort()
    const controller = new AbortController()
    generateControllerRef.current = controller
    setGenerating(true)
    setError('')
    const isCurrent = () => isCurrentInsightRequest({
      requestReportId: reportId,
      requestFileHash: fileHash,
      requestGeneration: generation,
      activeReportId: activeReportIdRef.current,
      activeFileHash: activeFileHashRef.current,
      activeGeneration: requestGenerationRef.current,
    })
    try {
      const response = await apiFetch(`/api/reports/${reportId}/insight`, {
        method: 'POST',
        headers: mutationHeaders(),
        signal: controller.signal,
      }).catch(() => null)
      if (!isCurrent()) return
      const body = response ? await readInsightApiResponse(response) : null
      if (!isCurrent()) return
      if (isInsightGenerationInFlight(body)) return
      const failure = insightFailureMessage(body)
      if (failure || !response?.ok || !body?.insight) {
        setGenerating(false)
        setError(failure || body?.error || '洞察生成失败。')
        return
      }
      setInsight(body.insight)
      setReadingProgress(0)
      setGenerating(false)
    } catch (cause) {
      if (!isCurrent() || controller.signal.aborted) return
      setGenerating(false)
      setError(cause instanceof Error ? cause.message : '洞察生成失败。')
    } finally {
      if (generateControllerRef.current === controller) generateControllerRef.current = undefined
    }
  }

  function handleFrameLoad() {
    frameCleanupRef.current?.()
    const frameWindow = iframeRef.current?.contentWindow
    const frameDocument = iframeRef.current?.contentDocument
    if (!frameWindow || !frameDocument) return

    const updateReadingPosition = () => {
      const root = frameDocument.documentElement
      const maxScroll = Math.max(0, root.scrollHeight - frameWindow.innerHeight)
      const progress = maxScroll > 0 ? Math.min(100, Math.max(0, Math.round(frameWindow.scrollY / maxScroll * 100))) : 100
      setReadingProgress(progress)
    }
    frameWindow.addEventListener('scroll', updateReadingPosition, { passive: true })
    frameWindow.addEventListener('resize', updateReadingPosition)
    updateReadingPosition()
    frameCleanupRef.current = () => {
      frameWindow.removeEventListener('scroll', updateReadingPosition)
      frameWindow.removeEventListener('resize', updateReadingPosition)
    }
  }

  if (loading) return <div {...entranceProps} className="yx-detail flex min-h-0 min-w-0 flex-1 flex-col"><InsightLoadingState /></div>
  if (!insight) {
    return (
      <div {...entranceProps} className="yx-detail flex min-h-0 min-w-0 flex-1 flex-col">
        <InsightEmptyState
          report={report}
          canManage={canManage}
          canGenerateInsight={canGenerateInsight}
          generating={generating}
          error={error}
          onGenerate={() => void generateInsight()}
          onNavigate={onNavigate}
        />
      </div>
    )
  }

  return (
    <section
      {...entranceProps}
      ref={workspaceRef}
      role={expanded ? 'dialog' : undefined}
      aria-modal={expanded ? true : undefined}
      aria-label="报告洞察阅读器"
      tabIndex={expanded ? -1 : undefined}
      className={`yx-detail flex min-w-0 flex-col overflow-hidden bg-[var(--yx-canvas)] ${expanded ? 'fixed inset-0 z-50 h-[100dvh] w-screen p-2 sm:p-4' : 'relative min-h-[650px] rounded-lg lg:min-h-0 lg:flex-1 lg:rounded-lg'}`}
    >
      <div aria-label="阅读工具" className={`yx-detail-intro flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-yx-line bg-yx-paper px-3 py-1.5 ${expanded ? 'rounded-t-xl sm:px-5' : 'sm:px-4'}`}>
        <div className="flex min-w-0 items-center gap-3 text-[10px] font-semibold text-yx-muted">
          <span className="flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5" />约 {insight.readingMinutes} 分钟</span>
          <span className="text-[var(--yx-brand)]">{readingProgress}%</span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <span role="status" aria-live="polite" aria-atomic="true" className="whitespace-nowrap text-[10px] font-medium text-yx-muted">
            {generating && <>
              正在重新生成洞察
              <span aria-hidden="true" className="yx-insight-wait-dots"><span>.</span><span>.</span><span>.</span></span>
            </>}
          </span>
          {canManage && canGenerateInsight && ((insight.regenerationCount ?? 0) < MAX_INSIGHT_REGENERATIONS) && (
            <button type="button" disabled={generating} aria-busy={generating} onClick={() => void generateInsight()} aria-label="重新生成洞察" title="重新生成洞察" className="flex h-8 w-8 items-center justify-center rounded-md text-yx-muted transition-colors hover:bg-yx-hover hover:text-yx-ink disabled:opacity-50">
              <RefreshCw aria-hidden="true" className={`h-4 w-4 ${generating ? 'animate-spin motion-reduce:animate-none' : ''}`} />
            </button>
          )}
          <button ref={fullscreenButtonRef} type="button" onClick={() => setExpanded((value) => !value)} aria-label={expanded ? '退出全屏阅读' : '全屏阅读'} title={expanded ? '退出全屏阅读' : '全屏阅读'} className="flex h-8 w-8 items-center justify-center rounded-md text-yx-muted transition-colors hover:bg-yx-hover hover:text-yx-ink">
            {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        </div>
      </div>
      <div className="h-0.5 shrink-0 bg-yx-line"><div className="h-full bg-yx-brand transition-[width] duration-200" style={{ width: `${readingProgress}%` }} /></div>

      {error && <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-yx-warning bg-yx-warning-soft px-4 py-2 text-[10px] text-yx-warning-text"><AlertCircle className="h-3.5 w-3.5 shrink-0" /><span className="min-w-0 flex-1">{error}</span></div>}

      <iframe
        ref={iframeRef}
        title={`${insight.title} - 报告洞察`}
        sandbox="allow-same-origin"
        referrerPolicy="no-referrer"
        srcDoc={renderedInsightHtml}
        onLoad={handleFrameLoad}
        className="yx-detail-reader block min-h-0 w-full flex-1 border-0 bg-yx-paper"
      />
    </section>
  )
}

function InsightLoadingState() {
  return (
    <div className="yx-detail-still-loading flex min-h-[560px] flex-1 items-center justify-center rounded-lg bg-yx-paper sm:rounded-lg">
      <div className="text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-[var(--yx-brand)]" /><p className="mt-3 text-[10px] text-yx-muted">正在载入报告洞察</p></div>
    </div>
  )
}

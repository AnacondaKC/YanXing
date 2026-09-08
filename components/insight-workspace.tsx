'use client'

import { AlertCircle, Clock3, Loader2, Maximize2, Minimize2, RefreshCw, Sparkles, Upload } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceEntrance } from '@/components/use-workspace-entrance'
import type { ProjectTabId } from '@/components/project-executive-header'
import { useDialogFocus } from '@/components/use-dialog-focus'
import { apiFetch, mutationHeaders } from '@/lib/client-request'
import { Button } from '@/components/ui/button'
import { insightEmptyCopy, insightEmptyKind } from '@/lib/insight-empty-state'
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
      <div aria-label="阅读工具" className={`yx-detail-intro flex h-11 shrink-0 items-center justify-between border-b border-yx-line bg-yx-paper px-3 ${expanded ? 'rounded-t-xl sm:px-5' : 'sm:px-4'}`}>
        <div className="flex min-w-0 items-center gap-3 text-[10px] font-semibold text-yx-muted">
          <span className="flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5" />约 {insight.readingMinutes} 分钟</span>
          <span className="text-[var(--yx-brand)]">{readingProgress}%</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {canManage && canGenerateInsight && ((insight.regenerationCount ?? 0) < MAX_INSIGHT_REGENERATIONS) && (
            <button type="button" disabled={generating} onClick={() => void generateInsight()} aria-label="重新生成洞察" title="重新生成洞察" className="flex h-8 w-8 items-center justify-center rounded-md text-yx-muted transition-colors hover:bg-yx-hover hover:text-yx-ink disabled:opacity-50">
              {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </button>
          )}
          <button ref={fullscreenButtonRef} type="button" onClick={() => setExpanded((value) => !value)} aria-label={expanded ? '退出全屏阅读' : '全屏阅读'} title={expanded ? '退出全屏阅读' : '全屏阅读'} className="flex h-8 w-8 items-center justify-center rounded-md text-yx-muted transition-colors hover:bg-yx-hover hover:text-yx-ink">
            {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        </div>
      </div>
      <div className="h-0.5 shrink-0 bg-yx-line"><div className="h-full bg-yx-brand transition-[width] duration-200" style={{ width: `${readingProgress}%` }} /></div>

      {error && <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-yx-warning bg-yx-warning-soft px-4 py-2 text-[10px] text-yx-warning-text"><AlertCircle className="h-3.5 w-3.5 shrink-0" /><span className="min-w-0 flex-1">{error}</span></div>}

      {generating && <div className="absolute inset-x-3 top-3 z-10 flex items-center justify-center gap-2 rounded-lg bg-black/90 px-3 py-2 text-[10px] font-medium text-white shadow-lg"><Loader2 className="h-3.5 w-3.5 animate-spin text-yx-brand-bright" />正在重新编排洞察</div>}
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

const insightEmptyCards = [
  { n: '1', title: '立论脉络与证据收束', text: '把报告的问题意识、事实证据与核心结论收成一条可核对的决策主线。', tone: 'warning' as const },
  { n: '2', title: '研判要点与行动建议', text: '把质量判断与可执行建议压成可扫读的要点，便于快速形成立场。', tone: 'brand' as const },
  { n: '3', title: '五分钟报告决策速读', text: '一页图文混排简报，约 3–5 分钟读完，直接支撑下一步动作。', tone: 'warning' as const },
]

function InsightEmptyState({
  report,
  canManage,
  canGenerateInsight = true,
  generating,
  error,
  onGenerate,
  onNavigate,
}: {
  report?: ReportVersion
  canManage: boolean
  canGenerateInsight?: boolean
  generating: boolean
  error: string
  onGenerate: () => void
  onNavigate?: (tab: ProjectTabId) => void
}) {
  const kind = insightEmptyKind(Boolean(report), generating)
  const copy = insightEmptyCopy(kind)

  return (
    <div className="yx-detail-content flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="relative flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden rounded-lg border border-yx-line bg-yx-paper p-6 shadow-xs sm:p-10 lg:p-12">
        <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-yx-brand/8 blur-3xl" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-24 -left-20 h-80 w-80 rounded-full bg-yx-brand/5 blur-2xl" />
        <div className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto text-center">
          <div className="inline-flex items-center gap-2 rounded-full bg-yx-brand px-4 py-1.5 text-xs font-bold text-white shadow-2xs">
            <Sparkles className="h-3.5 w-3.5 text-white" />
            <span>{copy.kicker}</span>
          </div>
          <h2 className="mt-4 text-2xl font-extrabold tracking-tight text-yx-ink sm:text-3xl lg:text-4xl">
            {copy.lead} · <span className="text-yx-brand">{copy.highlight}</span>
          </h2>
          <p className="mx-auto mt-2 max-w-2xl text-xs leading-relaxed text-yx-muted sm:text-sm">
            {copy.description}
          </p>
          <div className="mt-6 w-full max-w-2xl">
            {kind === 'generating' ? (
              <div className="flex items-center justify-center gap-2 rounded-full border border-yx-brand-tint bg-yx-brand-soft px-5 py-2 text-xs font-bold text-yx-brand-strong">
                <span className="h-2 w-2 animate-ping rounded-full bg-yx-brand" />
                <span>正在编排一页决策速读，完成后将自动进入阅读…</span>
              </div>
            ) : !canManage ? (
              <div className="rounded-lg border border-yx-warning-soft bg-yx-warning-soft p-4 text-left text-xs text-yx-warning-text">
                {report
                  ? '您当前以只读权限查看该课题，暂无生成洞察的权限。请联系课题负责人启动洞察。'
                  : '您当前以只读权限查看该课题，暂无可上传报告的权限。请联系课题负责人上传报告后再查看洞察。'}
              </div>
            ) : !canGenerateInsight ? (
              <div className="rounded-lg border border-yx-line bg-yx-canvas p-4 text-left text-xs text-yx-muted">
                历史报告仅支持查看已经生成的洞察；如需重新生成，请先切换到当前报告版本。
              </div>
            ) : report ? (
              <div className="flex justify-center">
                <Button size="lg" className="rounded-xl px-7" onClick={onGenerate}>
                  <Sparkles className="h-3.5 w-3.5" />
                  <span>{copy.action}</span>
                </Button>
              </div>
            ) : (
              <div className="flex justify-center">
                <Button size="lg" className="rounded-xl px-7" onClick={() => onNavigate?.('dashboard')}>
                  <Upload className="h-3.5 w-3.5" />
                  <span>{copy.action}</span>
                </Button>
              </div>
            )}
          </div>
          {error ? (
            <div role="alert" className="mt-5 flex w-full max-w-2xl items-start gap-2.5 rounded-lg border border-yx-danger bg-yx-danger-soft p-4 text-left text-xs text-yx-danger-text">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">洞察生成异常</p>
                <p className="mt-0.5">{error}</p>
              </div>
              {canManage && report ? (
                <Button size="sm" disabled={generating} onClick={onGenerate}>重试</Button>
              ) : null}
            </div>
          ) : null}
          <div className="mt-10 grid w-full grid-cols-1 gap-4 text-left sm:grid-cols-3">
            {insightEmptyCards.map((card) => (
              <div key={card.n} className="rounded-lg border border-yx-line bg-yx-paper p-5 shadow-2xs transition-colors hover:border-yx-brand-tint">
                <div className="flex items-center gap-2.5">
                  <span className={'flex h-7 w-7 items-center justify-center rounded-lg text-xs font-bold text-white shadow-2xs ' + (card.tone === 'brand' ? 'bg-yx-brand' : 'bg-yx-warning')}>
                    {card.n}
                  </span>
                  <h4 className="text-xs font-bold text-yx-ink sm:text-sm">{card.title}</h4>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-yx-muted">{card.text}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

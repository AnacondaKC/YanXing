'use client'

import { AlertCircle, Clock3, Maximize2, Minimize2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceEntrance } from '@/components/use-workspace-entrance'
import type { ProjectTabId } from '@/components/project-executive-header'
import { useDialogFocus } from '@/components/use-dialog-focus'
import { InsightEmptyState } from '@/components/insight-empty-state'
import { renderInsightDocument } from '@/lib/rendering/markdown'
import { insightActionLabel, isTaskInFlight, type WorkspaceJobAction, type WorkspaceReportCard } from '@/lib/workspace-submission'
import type { ReportInsightOutput } from '@/modules/insights/domain'
import type { SubmissionTask } from '@/modules/reports/submission-task-domain'

export interface InsightWorkspaceProps {
  report?: WorkspaceReportCard
  insight?: ReportInsightOutput
  insightTask?: SubmissionTask
  dispatchError?: string
  canManage: boolean
  generating?: boolean
  onGenerate: () => void
  onCancel: () => void
  onNavigate?: (tab: ProjectTabId) => void
}

export function canDispatchInsight(action: WorkspaceJobAction | undefined) {
  return action === 'start' || action === 'retry' || action === 'rerun'
}

export function InsightWorkspace({
  report,
  insight,
  insightTask,
  dispatchError,
  canManage,
  generating: generatingProp,
  onGenerate,
  onCancel,
  onNavigate,
}: InsightWorkspaceProps) {
  const generating = Boolean(generatingProp) || isTaskInFlight(insightTask)
  const insightAction = report?.capabilities.insightAction
  const action = insightAction ? insightActionLabel(insightAction) : undefined
  const canGenerateInsight = !report || canDispatchInsight(insightAction)
  const canCancel = Boolean(canManage && report?.capabilities.canCancelInsightJob && isTaskInFlight(insightTask))
  const error = dispatchError ?? ''
  const [expanded, setExpanded] = useState(false)
  const [readingProgress, setReadingProgress] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const frameCleanupRef = useRef<(() => void) | undefined>(undefined)
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null)
  const { entranceProps } = useWorkspaceEntrance(false)
  const closeExpanded = useCallback(() => setExpanded(false), [])
  const workspaceRef = useDialogFocus(closeExpanded, fullscreenButtonRef, expanded)
  const renderedInsightHtml = useMemo(() => insight ? renderInsightDocument(insight.html) : '', [insight])

  useEffect(() => () => {
    frameCleanupRef.current?.()
  }, [])

  useEffect(() => {
    setReadingProgress(0)
  }, [insight?.html, report?.id])

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

  if (!insight) {
    return (
      <div {...entranceProps} className="yx-detail flex min-h-0 min-w-0 flex-1 flex-col">
        <InsightEmptyState
          report={report}
          canManage={canManage}
          canGenerateInsight={canGenerateInsight}
          generating={generating}
          canCancel={canCancel}
          error={error}
          actionLabel={action}
          onGenerate={onGenerate}
          onCancel={onCancel}
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
          {canCancel && (
            <button type="button" onClick={onCancel} aria-label="停止洞察" title="停止洞察" className="flex h-8 items-center rounded-md px-2 text-[10px] font-medium text-yx-muted transition-colors hover:bg-yx-hover hover:text-yx-ink">
              停止洞察
            </button>
          )}
          {canManage && canGenerateInsight && (
            <button type="button" disabled={generating} aria-busy={generating} onClick={onGenerate} aria-label="重新生成洞察" title="重新生成洞察" className="flex h-8 w-8 items-center justify-center rounded-md text-yx-muted transition-colors hover:bg-yx-hover hover:text-yx-ink disabled:opacity-50">
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

'use client'

import { hierarchy, Tree } from '@visx/hierarchy'
import { HeatmapRect } from '@visx/heatmap'
import { Wordcloud } from '@visx/wordcloud'
import { Columns2, Grid3X3, Maximize2, Minimize2, Network, Rows2, Tags } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type RefObject } from 'react'
import { AnalysisResultHint } from '@/components/analysis-result-hint'
import { WorkbenchCardDecoration } from '@/components/ui/card-decoration'
import { useDialogFocus } from '@/components/use-dialog-focus'
import { isAnalysisResultScanning, isAnalysisResultVisible, resolveAnalysisResultDisplay, type AnalysisResultDisplay } from '@/modules/analysis/progress'
import { getMindMapDirection, getMindMapNodeGeometry, getNodeDisplayLabel, getRootLabelLines, ROOT_LINE_HEIGHT, type MindMapDirection } from '@/lib/rendering/graph-layout'
import { createWordCloudLayout, WORD_CLOUD_LAYOUT_SCALES, type WordCloudRenderWord } from '@/lib/rendering/word-cloud-layout'
import { getVisualizationData, type HeatmapData, type WordCloudItem } from '@/lib/rendering/visualizations'
import { MIN_WORD_CLOUD_KEYWORDS, RESEARCH_METHODS } from '@/modules/contracts/analysis'
import type { AnalysisJobStatus, AnalysisSnapshotPayload, VisualizationMindMapNode } from '@/modules/contracts/analysis'

const visualizationOptions = [
  { id: 'mindmap', label: '思维导图', icon: Network },
  { id: 'wordcloud', label: '词云图', icon: Tags },
  { id: 'heatmap', label: '热力图', icon: Grid3X3 },
] as const

export type VisualizationView = (typeof visualizationOptions)[number]['id']

export function panTowardCursor(
  current: { x: number; y: number },
  cursor: { x: number; y: number },
  scale: number,
) {
  return {
    x: cursor.x + (current.x - cursor.x) * scale,
    y: cursor.y + (current.y - cursor.y) * scale,
  }
}
type VisualizationCardProps = {
  snapshot: AnalysisSnapshotPayload
  analyzing?: boolean
  jobStatus?: AnalysisJobStatus
  className?: string
  activeView: VisualizationView
  isExpanded: boolean
  onViewChange: (view: VisualizationView) => void
  onToggleFullscreen: () => void
}

export function ResearchVisualizationCard({ snapshot, analyzing, jobStatus, className, activeView, isExpanded, onViewChange, onToggleFullscreen }: VisualizationCardProps) {
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useDialogFocus(onToggleFullscreen, fullscreenButtonRef, isExpanded)
  const visualizationData = useMemo(() => getVisualizationData(snapshot), [snapshot])
  const mindMapRoot = visualizationData.mindMap
  const [mindMapZoom, setMindMapZoom] = useState(1)
  const [manualDirection, setManualDirection] = useState<MindMapDirection | null>(null)
  const autoDirection = useMemo(() => getMindMapDirection(mindMapRoot), [mindMapRoot])
  const currentMindMapDirection = manualDirection ?? autoDirection

  const handleToggleMindMapDirection = useCallback(() => {
    setManualDirection((current) => {
      const active = current ?? autoDirection
      return active === 'left-to-right' ? 'top-to-bottom' : 'left-to-right'
    })
  }, [autoDirection])

  useEffect(() => {
    if (activeView !== 'mindmap') {
      setMindMapZoom(1)
      setManualDirection(null)
    }
  }, [activeView])

  const activeViewConfig = visualizationOptions.find((item) => item.id === activeView) ?? visualizationOptions[0]
  const ActiveViewIcon = activeViewConfig.icon
  const hasVisualizationData = activeView === 'mindmap'
    ? Boolean(visualizationData.mindMap.children.length)
    : activeView === 'wordcloud'
      ? Boolean(visualizationData.wordCloud.length)
      : Boolean(visualizationData.heatmap.rows.length)
  const display = resolveAnalysisResultDisplay({ analyzing: Boolean(analyzing), hasData: hasVisualizationData, jobStatus })
  const scanning = isAnalysisResultScanning(display)
  const showVisualization = isAnalysisResultVisible(display)
  const visualizationDescription: Record<VisualizationView, string> = {
    mindmap: '报告研究主题与结构可视化',
    wordcloud: '报告主题关键词重要性排序',
    heatmap: '章节研究方法使用强度',
  }


  return (
    <div ref={dialogRef} role={isExpanded ? 'dialog' : undefined} aria-modal={isExpanded ? true : undefined} aria-label="研究报告可视化" tabIndex={isExpanded ? -1 : undefined} className={visualizationCardClass(isExpanded, className)}>
      <WorkbenchCardDecoration kind="visualization" />
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
      <VisualizationCardHeader
        title={activeViewConfig.label}
        icon={ActiveViewIcon}
        description={visualizationDescription[activeView]}
        display={display}
        isExpanded={isExpanded}
        onToggleFullscreen={onToggleFullscreen}
        fullscreenButtonRef={fullscreenButtonRef}
        mindMapDirection={activeView === 'mindmap' && showVisualization ? currentMindMapDirection : undefined}
        onToggleDirection={activeView === 'mindmap' && showVisualization ? handleToggleMindMapDirection : undefined}
      />
      <div className="flex min-h-0 flex-1 items-stretch gap-2 sm:gap-3">
        <VisualizationNavigation activeView={activeView} onViewChange={onViewChange} />
        <VisualizationViewport isExpanded={isExpanded} scrollable={activeView === 'mindmap'} dense={activeView === 'wordcloud'}>
          {scanning ? (
            <VisualizationScanningState activeView={activeView} animated />
          ) : showVisualization ? (
            <div className="yx-data-in flex h-full min-h-0 w-full items-center justify-center">
              {activeView === 'mindmap'
                ? <MindMapVisualization root={mindMapRoot} isExpanded={isExpanded} zoom={mindMapZoom} onZoomChange={setMindMapZoom} direction={currentMindMapDirection} />
                : activeView === 'wordcloud'
                  ? <WordCloudVisualization items={visualizationData.wordCloud} isExpanded={isExpanded} />
                  : <HeatmapVisualization data={visualizationData.heatmap} isExpanded={isExpanded} />}
            </div>
          ) : <VisualizationScanningState activeView={activeView} />}
        </VisualizationViewport>
      </div>
      </div>
    </div>
  )
}
function visualizationCardClass(isExpanded: boolean, className?: string) {
  return isExpanded
    ? 'yx-dashboard-card fixed inset-0 z-50 flex h-[100dvh] w-screen min-h-0 flex-col overflow-hidden !rounded-none bg-yx-paper p-4 shadow-2xl sm:p-6 !border-0'
    : `yx-dashboard-card relative flex min-h-0 flex-col overflow-hidden !py-[20px] !px-[25px] ${className ?? ''}`
}

function VisualizationScanningState({ activeView, animated }: { activeView: VisualizationView; animated?: boolean }) {
  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center overflow-hidden p-4">
      {activeView === 'mindmap' ? <MindMapScanningSkeleton animated={animated} /> : activeView === 'wordcloud' ? <WordCloudScanningSkeleton animated={animated} /> : <HeatmapScanningSkeleton animated={animated} />}
    </div>
  )
}

export function MindMapScanningSkeleton({ animated }: { animated?: boolean }) {
  return (
    <svg viewBox="0 0 336 132" className="h-[108px] w-full max-w-[336px] overflow-visible" aria-hidden="true">
      <path className={animated ? 'yx-mindmap-branch-line' : undefined} d="M88 66 C128 66 128 24 168 24" fill="none" stroke="var(--yx-brand)" strokeWidth="1.75" pathLength="1" />
      <path className={animated ? 'yx-mindmap-branch-line' : undefined} d="M88 66 H168" fill="none" stroke="var(--yx-brand)" strokeWidth="1.75" pathLength="1" style={animated ? { animationDelay: '80ms' } : undefined} />
      <path className={animated ? 'yx-mindmap-branch-line' : undefined} d="M88 66 C128 66 128 108 168 108" fill="none" stroke="var(--yx-brand)" strokeWidth="1.75" pathLength="1" style={animated ? { animationDelay: '160ms' } : undefined} />
      <path className={animated ? 'yx-mindmap-leaf-line' : undefined} d="M232 24 H256" fill="none" stroke="var(--yx-brand-bright)" strokeWidth="1.75" pathLength="1" />
      <path className={animated ? 'yx-mindmap-leaf-line' : undefined} d="M232 66 H256" fill="none" stroke="var(--yx-brand-bright)" strokeWidth="1.75" pathLength="1" style={animated ? { animationDelay: '80ms' } : undefined} />
      <path className={animated ? 'yx-mindmap-leaf-line' : undefined} d="M232 108 H256" fill="none" stroke="var(--yx-brand-bright)" strokeWidth="1.75" pathLength="1" style={animated ? { animationDelay: '160ms' } : undefined} />
      <rect className={animated ? 'yx-mindmap-root' : undefined} x="16" y="50" width="72" height="32" rx="16" fill="var(--yx-ink)" />
      <rect className={animated ? 'yx-mindmap-branch' : undefined} x="168" y="12" width="64" height="24" rx="9" fill="var(--yx-brand)" />
      <rect className={animated ? 'yx-mindmap-branch' : undefined} x="168" y="54" width="64" height="24" rx="9" fill="var(--yx-brand)" style={animated ? { animationDelay: '80ms' } : undefined} />
      <rect className={animated ? 'yx-mindmap-branch' : undefined} x="168" y="96" width="64" height="24" rx="9" fill="var(--yx-brand)" style={animated ? { animationDelay: '160ms' } : undefined} />
      <rect className={animated ? 'yx-mindmap-leaf' : undefined} x="256" y="12" width="64" height="24" rx="9" fill="var(--yx-paper)" stroke="var(--yx-brand-bright)" strokeWidth="1.5" />
      <rect className={animated ? 'yx-mindmap-leaf' : undefined} x="256" y="54" width="64" height="24" rx="9" fill="var(--yx-paper)" stroke="var(--yx-brand-bright)" strokeWidth="1.5" style={animated ? { animationDelay: '80ms' } : undefined} />
      <rect className={animated ? 'yx-mindmap-leaf' : undefined} x="256" y="96" width="64" height="24" rx="9" fill="var(--yx-paper)" stroke="var(--yx-brand-bright)" strokeWidth="1.5" style={animated ? { animationDelay: '160ms' } : undefined} />
    </svg>
  )
}

export function WordCloudScanningSkeleton({ animated }: { animated?: boolean }) {
  const words = [
    { w: 72, h: 22 },
    { w: 48, h: 18 },
    { w: 64, h: 22 },
    { w: 36, h: 16 },
    { w: 56, h: 20 },
    { w: 40, h: 16 },
    { w: 52, h: 18 },
    { w: 28, h: 14 },
    { w: 44, h: 16 },
    { w: 60, h: 20 },
    { w: 32, h: 14 },
    { w: 48, h: 18 },
  ]
  const tones = [
    'var(--yx-brand-tint)',
    'var(--yx-brand-bright)',
    'var(--yx-brand)',
    'var(--yx-brand-hover)',
    'var(--yx-brand-strong)',
  ]
  return (
    <div className="flex max-w-[280px] flex-wrap items-center justify-center gap-2">
      {words.map((word, index) => (
        <div
          key={index}
          className={`${animated ? 'yx-heatmap-cell' : ''} shrink-0 rounded-full`}
          style={{
            width: word.w,
            height: word.h,
            backgroundColor: animated ? undefined : tones[index % tones.length],
            animationDuration: animated ? `${2.6 + (index % 7) * 0.55}s` : undefined,
            animationDelay: animated ? `${((index * 0.37) % 3.2).toFixed(2)}s` : undefined,
          }}
        />
      ))}
    </div>
  )
}

export function HeatmapScanningSkeleton({ animated }: { animated?: boolean }) {
  const tones = ['var(--yx-line)', 'var(--yx-brand-tint)', 'var(--yx-brand-bright)', 'var(--yx-brand)', 'var(--yx-brand-hover)']
  const pattern = [0, 1, 2, 1, 0, 0, 1, 3, 4, 3, 1, 0, 0, 2, 4, 4, 2, 1, 1, 1, 3, 2, 1, 0]
  return (
    <div className="grid grid-cols-6 gap-1">
      {pattern.map((tone, index) => (
        <div
          key={index}
          className={`${animated ? 'yx-heatmap-cell' : ''} h-5 w-5 rounded-sm`}
          style={{
            backgroundColor: animated ? undefined : tones[tone],
            animationDuration: animated ? `${2.6 + (index % 7) * 0.55}s` : undefined,
            animationDelay: animated ? `${((index * 0.37) % 3.2).toFixed(2)}s` : undefined,
          }}
        />
      ))}
    </div>
  )
}



function VisualizationCardHeader({ title, icon: Icon, description, display, isExpanded, onToggleFullscreen, fullscreenButtonRef, mindMapDirection, onToggleDirection }: { title: string; icon: ComponentType<{ className?: string }>; description: string; display?: AnalysisResultDisplay; isExpanded: boolean; onToggleFullscreen: () => void; fullscreenButtonRef: RefObject<HTMLButtonElement | null>; mindMapDirection?: MindMapDirection; onToggleDirection?: () => void }) {
  return (
    <div className="mb-1.5 flex shrink-0 items-start justify-between gap-2 sm:mb-2 xl:mb-1.5">
      <div className="flex items-center gap-1.5 sm:gap-2">
        <Icon className="h-[21px] w-[21px] shrink-0 text-yx-ink sm:h-[26px] sm:w-[26px]" />
        <div>
          <h2 className="text-sm font-semibold text-yx-ink sm:text-base">{title}</h2>
          <p className="mt-px truncate text-[9px] text-yx-muted sm:text-[10px]" title={description}>{description}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {display ? <AnalysisResultHint display={display} /> : null}

        {onToggleDirection && mindMapDirection && (
          <button
            type="button"
            aria-label={mindMapDirection === 'left-to-right' ? '切换为纵向排版' : '切换为横向排版'}
            title={mindMapDirection === 'left-to-right' ? '切换为纵向排版' : '切换为横向排版'}
            onClick={onToggleDirection}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-yx-faint transition-colors hover:bg-yx-hover hover:text-yx-ink"
          >
            {mindMapDirection === 'left-to-right' ? <Columns2 className="h-3 w-3" /> : <Rows2 className="h-3 w-3" />}
          </button>
        )}
        <button ref={fullscreenButtonRef} type="button" aria-label={isExpanded ? '退出全屏' : '全屏查看'} title={isExpanded ? '退出全屏' : '全屏查看'} onClick={onToggleFullscreen} className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-yx-faint transition-colors hover:bg-yx-hover hover:text-yx-ink">
          {isExpanded ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
        </button>
      </div>
    </div>
  )
}

function VisualizationNavigation({ activeView, onViewChange }: { activeView: VisualizationView; onViewChange: (view: VisualizationView) => void }) {
  return (
    <nav aria-label="报告可视化视图" className="flex w-14 shrink-0 flex-col gap-1 sm:w-16">
      {visualizationOptions.map(({ id, label, icon: Icon }) => (
        <button key={id} type="button" aria-pressed={activeView === id} onClick={() => onViewChange(id)} className={`flex min-h-12 flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5 text-center text-[9px] font-semibold leading-tight transition-colors sm:min-h-14 sm:text-[9.5px] ${activeView === id ? 'bg-yx-brand text-white shadow-sm' : 'bg-yx-surface text-yx-ink-soft hover:bg-yx-hover hover:text-yx-ink'}`}>
          <Icon className="h-4 w-4 sm:h-[18px] sm:w-[18px] text-current" />
          <span className="text-current">{label}</span>
        </button>
      ))}
    </nav>
  )
}

function VisualizationViewport({ isExpanded, scrollable, dense = false, children }: { isExpanded: boolean; scrollable: boolean; dense?: boolean; children: React.ReactNode }) {
  const viewportClass = isExpanded
    ? 'h-full w-full'
    : scrollable
      ? 'h-[240px] sm:h-[300px] lg:h-full'
      : dense
        ? 'h-[300px] sm:h-[320px] lg:h-auto'
        : 'h-[180px] sm:h-[240px] lg:h-auto'
  return <div className={`relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg bg-yx-surface ${viewportClass}`}>{children}</div>
}

type MindMapHierarchyPointNode = {
  data: VisualizationMindMapNode
  depth: number
  children?: MindMapHierarchyPointNode[] | null
  x: number
  y: number
  descendants: () => MindMapHierarchyPointNode[]
  links: () => Array<{ source: MindMapHierarchyPointNode; target: MindMapHierarchyPointNode }>
}

type MindMapNodeItem = {
  node: MindMapHierarchyPointNode
  isRoot: boolean
  isBranch: boolean
  displayLabel: string
  geometry: ReturnType<typeof getMindMapNodeGeometry>
  x: number
  y: number
  left: number
  right: number
  top: number
  bottom: number
}

function MindMapCanvas({
  tree,
  direction,
  isHorizontal,
  isExpanded,
  zoom,
  onZoomChange,
}: {
  tree: MindMapHierarchyPointNode
  direction: MindMapDirection
  isHorizontal: boolean
  isExpanded: boolean
  zoom: number
  onZoomChange: (zoom: number) => void
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [, setPan] = useState({ x: 0, y: 0 })
  const panRef = useRef({ x: 0, y: 0 })
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const MIN_ZOOM = 0.05
  const MAX_ZOOM = isExpanded ? 6 : 4
  const maxZoomRef = useRef(MAX_ZOOM)
  maxZoomRef.current = MAX_ZOOM

  function applyPan(nextPan: { x: number; y: number }) {
    panRef.current = nextPan
    if (contentRef.current) {
      contentRef.current.style.transform = `translate(${nextPan.x}px, ${nextPan.y}px)`
    }
  }

  const { nodesWithGeom, nodeMap, viewBox, viewBoxWidth, viewBoxHeight } = useMemo(() => {
    const nodes = tree.descendants()
    const nodesWithGeom: MindMapNodeItem[] = nodes.map((node: MindMapHierarchyPointNode) => {
      const isRoot = node.depth === 0
      const isBranch = !isRoot && Boolean(node.children?.length)
      const kind = isRoot ? 'root' : isBranch ? 'branch' : 'leaf'
      const displayLabel = getNodeDisplayLabel(node.data.label, kind)
      const geometry = getMindMapNodeGeometry(kind, displayLabel.length, direction)
      const x = isHorizontal ? node.y : node.x
      const y = isHorizontal ? node.x : node.y
      return {
        node,
        isRoot,
        isBranch,
        displayLabel,
        geometry,
        x,
        y,
        left: x - geometry.width / 2,
        right: x + geometry.width / 2,
        top: y - geometry.height / 2,
        bottom: y + geometry.height / 2,
      }
    })

    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const item of nodesWithGeom) {
      if (item.left < minX) minX = item.left
      if (item.right > maxX) maxX = item.right
      if (item.top < minY) minY = item.top
      if (item.bottom > maxY) maxY = item.bottom
    }

    const margin = 16
    const viewBoxWidth = Math.ceil(maxX - minX + margin * 2)
    const viewBoxHeight = Math.ceil(maxY - minY + margin * 2)
    const viewBox = `${minX - margin} ${minY - margin} ${viewBoxWidth} ${viewBoxHeight}`
    const nodeMap = new Map<string, MindMapNodeItem>(nodesWithGeom.map((item: MindMapNodeItem) => [item.node.data.id, item]))

    return { nodesWithGeom, nodeMap, viewBox, viewBoxWidth, viewBoxHeight }
  }, [tree, direction, isHorizontal])
  const treeLinks = useMemo(() => tree.links(), [tree])

  const autoFitRef = useRef(false)
  useEffect(() => {
    autoFitRef.current = false
    const viewport = viewportRef.current
    if (!viewport) return

    const fitToViewport = () => {
      if (autoFitRef.current || viewport.clientWidth <= 0 || viewport.clientHeight <= 0 || viewBoxHeight <= 0) return
      // 上下保留 8px 微呼吸边距，让高度 100% 饱满填满垂直空间，上下边距完全均等对称
      const fitPaddingH = 8
      const availableH = Math.max(1, viewport.clientHeight - fitPaddingH)

      const fitZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, availableH / viewBoxHeight))
      const fittedZoom = Number(fitZoom.toFixed(2))
      const contentW = viewBoxWidth * fittedZoom
      const contentH = viewBoxHeight * fittedZoom

      autoFitRef.current = true
      zoomRef.current = fittedZoom
      onZoomChange(fittedZoom)

      const panY = (viewport.clientHeight - contentH) / 2
      let panX = (viewport.clientWidth - contentW) / 2

      if (isHorizontal && contentW > viewport.clientWidth - 16) {
        panX = 8
      }

      const nextPan = { x: panX, y: panY }
      panRef.current = nextPan
      setPan(nextPan)
    }

    fitToViewport()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(fitToViewport)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [isExpanded, viewBoxWidth, viewBoxHeight, direction, onZoomChange, isHorizontal])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const onWheel = (event: WheelEvent) => {
      if (event.shiftKey) return
      event.preventDefault()
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1)
      const next = Math.min(maxZoomRef.current, Math.max(MIN_ZOOM, Math.round(zoomRef.current * Math.exp(-delta * 0.0015) * 100) / 100))
      if (next === zoomRef.current) return
      const rect = viewport.getBoundingClientRect()
      const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      const scale = next / zoomRef.current
      const nextPan = panTowardCursor(panRef.current, cursor, scale)
      zoomRef.current = next
      applyPan(nextPan)
      onZoomChange(next)
      setPan(nextPan)
    }
    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [onZoomChange])

  function endDrag() {
    dragRef.current = null
    const viewport = viewportRef.current
    if (viewport) viewport.style.cursor = 'grab'
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const viewport = viewportRef.current
    if (!viewport || event.button !== 0) return
    endDrag()
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      panX: panRef.current.x,
      panY: panRef.current.y,
    }
    viewport.setPointerCapture(event.pointerId)
    viewport.style.cursor = 'grabbing'
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag) return
    applyPan({
      x: drag.panX + (event.clientX - drag.startX),
      y: drag.panY + (event.clientY - drag.startY),
    })
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current) setPan(panRef.current)
    endDrag()
    const viewport = viewportRef.current
    if (viewport && viewport.hasPointerCapture?.(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId)
    }
  }

  function onLostPointerCapture() {
    if (dragRef.current) setPan(panRef.current)
    endDrag()
  }

  const renderLink = (link: { source: MindMapHierarchyPointNode; target: MindMapHierarchyPointNode }) => {
    const sourceItem = nodeMap.get(link.source.data.id)
    const targetItem = nodeMap.get(link.target.data.id)
    if (!sourceItem || !targetItem) return ''
    const sourceX = sourceItem.x
    const sourceY = sourceItem.y
    const targetX = targetItem.x
    const targetY = targetItem.y

    if (isHorizontal) {
      const startX = sourceX + sourceItem.geometry.width / 2
      const endX = targetX - targetItem.geometry.width / 2
      const bend = startX + (endX - startX) / 2
      return `M ${startX} ${sourceY} C ${bend} ${sourceY}, ${bend} ${targetY}, ${endX} ${targetY}`
    }
    const startY = sourceY + sourceItem.geometry.height / 2
    const endY = targetY - targetItem.geometry.height / 2
    const bend = startY + (endY - startY) / 2
    return `M ${sourceX} ${startY} C ${sourceX} ${bend}, ${targetX} ${bend}, ${targetX} ${endY}`
  }

  return (
    <div
      ref={viewportRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={onLostPointerCapture}
      className="absolute inset-0 cursor-grab select-none overflow-hidden"
    >
      <div
        ref={contentRef}
        className="absolute left-0 top-0"
        style={{
          width: `${viewBoxWidth * zoom}px`,
          height: `${viewBoxHeight * zoom}px`,
          transform: `translate(${panRef.current.x}px, ${panRef.current.y}px)`,
          willChange: 'transform',
        }}
      >
        <svg
          viewBox={viewBox}
          className="block h-auto max-w-none"
          style={{ width: `${viewBoxWidth * zoom}px`, height: `${viewBoxHeight * zoom}px` }}
          role="img"
          aria-label="课题思维导图"
        >
          <g fill="none" stroke="var(--yx-brand)" strokeWidth="1.5">
            {treeLinks.map((link: { source: MindMapHierarchyPointNode; target: MindMapHierarchyPointNode }) => (
              <path key={`${link.source.data.id}-${link.target.data.id}`} d={renderLink(link)} />
            ))}
          </g>
          {nodesWithGeom.map((item: MindMapNodeItem) => {
            const chars = item.isRoot ? [] : item.displayLabel.split('')
            return (
              <g key={item.node.data.id} transform={`translate(${item.x}, ${item.y})`}>
                <title>{item.node.data.label}</title>
                <rect
                  x={-item.geometry.width / 2}
                  y={-item.geometry.height / 2}
                  width={item.geometry.width}
                  height={item.geometry.height}
                  rx={item.isRoot ? 16 : item.isBranch ? 9 : 6}
                  fill={item.isRoot ? 'var(--yx-ink)' : item.isBranch ? 'var(--yx-brand)' : 'var(--yx-paper)'}
                  stroke={item.isRoot || item.isBranch ? 'none' : 'var(--yx-line)'}
                  strokeWidth="1.5"
                />
                {item.isRoot ? (
                  <text
                    x="0"
                    y="0"
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="var(--yx-paper)"
                    fontSize={isHorizontal ? 15 : 18}
                    fontWeight={700}
                  >
                    {getRootLabelLines(item.displayLabel).map((line, lineIndex, lines) => (
                      <tspan
                        key={lineIndex}
                        x="0"
                        dy={lineIndex === 0 ? -(lines.length - 1) * ROOT_LINE_HEIGHT / 2 : ROOT_LINE_HEIGHT}
                      >
                        {line}
                      </tspan>
                    ))}
                  </text>
                ) : isHorizontal ? (
                  <text
                    x="0"
                    y="0"
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill={item.isBranch ? 'var(--yx-paper)' : 'var(--yx-ink)'}
                    fontSize={item.isBranch ? 12 : 11}
                    fontWeight={600}
                  >
                    {item.displayLabel}
                  </text>
                ) : (
                  chars.map((char: string, index: number) => (
                    <text
                      key={index}
                      x="0"
                      y={
                        -item.geometry.height / 2 +
                        (item.geometry.height - chars.length * item.geometry.charStep) / 2 +
                        index * item.geometry.charStep +
                        item.geometry.charStep / 2
                      }
                      textAnchor="middle"
                      dominantBaseline="central"
                      fill={item.isBranch ? 'var(--yx-paper)' : 'var(--yx-ink)'}
                      fontSize={item.isBranch ? 12 : 11}
                      fontWeight={600}
                    >
                      {char}
                    </text>
                  ))
                )}
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

export function MindMapVisualization({
  root,
  isExpanded,
  zoom,
  onZoomChange,
  direction: controlledDirection,
}: {
  root: VisualizationMindMapNode
  isExpanded: boolean
  zoom: number
  onZoomChange: (zoom: number) => void
  direction?: MindMapDirection
}) {
  const treeRoot = useMemo(() => hierarchy(root), [root])
  const autoDirection = useMemo(() => getMindMapDirection(root), [root])
  const direction = controlledDirection ?? autoDirection
  const isHorizontal = direction === 'left-to-right'

  const layoutMetrics = useMemo(() => {
    const descendants = treeRoot.descendants()
    let maxBreadthWidth = isHorizontal ? 120 : 44
    let maxBreadthHeight = isHorizontal ? 36 : 52
    for (const node of descendants) {
      if (node.depth > 0) {
        const isBranch = Boolean(node.children?.length)
        const kind = isBranch ? 'branch' : 'leaf'
        const geometry = getMindMapNodeGeometry(kind, getNodeDisplayLabel(node.data.label, kind).length, direction)
        maxBreadthWidth = Math.max(maxBreadthWidth, geometry.width)
        maxBreadthHeight = Math.max(maxBreadthHeight, geometry.height)
      }
    }

    const leafCount = Math.max(1, treeRoot.leaves().length)
    const horizontalBreadthSpan = (leafCount - 1) * (maxBreadthHeight + 20) + maxBreadthHeight
    const verticalBreadthSpan = (leafCount - 1) * (maxBreadthWidth + 16) + maxBreadthWidth
    const horizontalDepthSpan = (treeRoot.height + 1) * 220
    const verticalDepthSpan = (treeRoot.height + 1) * 160

    return {
      breadthSpan: isHorizontal ? horizontalBreadthSpan : verticalBreadthSpan,
      depthSpan: isHorizontal ? horizontalDepthSpan : verticalDepthSpan,
    }
  }, [treeRoot, isHorizontal, direction])

  return (
    <Tree
      root={treeRoot}
      size={[layoutMetrics.breadthSpan, layoutMetrics.depthSpan]}
      separation={(a, b) => (a.parent === b.parent ? 1 : 1.25)}
    >
      {(tree) => (
        <MindMapCanvas
          tree={tree}
          direction={direction}
          isHorizontal={isHorizontal}
          isExpanded={isExpanded}
          zoom={zoom}
          onZoomChange={onZoomChange}
        />
      )}
    </Tree>
  )
}

const WORD_CLOUD_COLORS = ['var(--yx-ink)', 'var(--yx-brand)', 'var(--yx-brand)', 'var(--yx-muted)', 'var(--yx-warning)']
const WORD_CLOUD_RANDOM = () => 0.5

type PositionedWordCloudWord = {
  text?: string
  font?: string
  size?: number
  x?: number
  y?: number
}

export function WordCloudVisualization({ items, isExpanded }: { items: WordCloudItem[]; isExpanded?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [layoutScaleIndex, setLayoutScaleIndex] = useState(0)
  const itemKey = useMemo(() => items.map((item) => `${item.id}:${item.label}:${item.weight}`).join('|'), [items])
  const layoutScale = WORD_CLOUD_LAYOUT_SCALES[layoutScaleIndex] ?? WORD_CLOUD_LAYOUT_SCALES[WORD_CLOUD_LAYOUT_SCALES.length - 1]
  const layout = useMemo(() => createWordCloudLayout(items, size, layoutScale), [items, size, layoutScale])
  const wordByLabel = useMemo(() => new Map(layout.words.map((word) => [word.text, word])), [layout.words])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const updateSize = () => {
      const width = Math.floor(container.clientWidth)
      const height = Math.floor(container.clientHeight)
      setSize((current) => current.width === width && current.height === height ? current : { width, height })
    }
    updateSize()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateSize)
    observer.observe(container)
    return () => observer.disconnect()
  }, [isExpanded])

  useEffect(() => {
    setLayoutScaleIndex(0)
  }, [itemKey, size.width, size.height])

  const handlePlacedWords = useCallback((count: number) => {
    if (count >= Math.min(MIN_WORD_CLOUD_KEYWORDS, items.length)) return
    setLayoutScaleIndex((current) => Math.min(current + 1, WORD_CLOUD_LAYOUT_SCALES.length - 1))
  }, [items.length])

  return (
    <div ref={containerRef} className="flex h-full min-h-0 w-full items-center justify-center overflow-hidden" role="img" aria-label="报告关键词词云图">
      {size.width > 0 && size.height > 0 ? (
        <Wordcloud
          key={`${itemKey}:${size.width}x${size.height}:${layoutScaleIndex}`}
          words={layout.words}
          width={size.width}
          height={size.height}
          font="Arial, PingFang SC, Microsoft YaHei, sans-serif"
          fontSize={(word) => word.fontSize}
          fontWeight={(word) => word.fontWeight}
          rotate={0}
          padding={layout.padding}
          spiral="archimedean"
          random={WORD_CLOUD_RANDOM}
        >
          {(cloudWords) => <WordCloudPlacedWords cloudWords={cloudWords} wordByLabel={wordByLabel} onPlaced={handlePlacedWords} />}
        </Wordcloud>
      ) : null}
    </div>
  )
}

export function WordCloudPlacedWords({ cloudWords, wordByLabel, onPlaced }: { cloudWords: PositionedWordCloudWord[]; wordByLabel: ReadonlyMap<string, WordCloudRenderWord>; onPlaced: (count: number) => void }) {
  useEffect(() => {
    if (cloudWords.length) onPlaced(cloudWords.length)
  }, [cloudWords, onPlaced])

  return (
    <>
      {cloudWords.map((cloudWord, index) => {
        const label = cloudWord.text ?? ''
        const word = wordByLabel.get(label)
        if (!word) return null
        const fontSize = cloudWord.size ?? word.fontSize
        return (
          <text key={`${word.id}-${index}`} textAnchor="middle" dominantBaseline="central" fill={WORD_CLOUD_COLORS[word.rank % WORD_CLOUD_COLORS.length]} fontSize={fontSize} fontFamily={cloudWord.font ?? 'sans-serif'} fontWeight={word.fontWeight} transform={`translate(${cloudWord.x ?? 0}, ${cloudWord.y ?? 0})`}>
            <title>{`${word.text}：重要性排名 ${word.rank + 1}`}</title>
            {label}
          </text>
        )
      })}
    </>
  )
}

type HeatmapBin = { row: { id: string; label: string }; cell: HeatmapData['rows'][number]['cells'][number] }
type HeatmapColumnDatum = { column: HeatmapData['rows'][number]; bins: HeatmapBin[] }

export function HeatmapVisualization({ data, isExpanded }: { data: HeatmapData; isExpanded?: boolean }) {
  const labelWidth = isExpanded ? 90 : 72
  const cellWidth = isExpanded ? 80 : 62
  const headerHeight = 32
  const rowHeight = isExpanded ? 48 : 40
  const gap = 6
  const heatmapData = useMemo<HeatmapColumnDatum[]>(() => data.rows.map((row) => ({
    column: row,
    bins: RESEARCH_METHODS.map((method) => {
      const cell = row.cells.find((candidate) => candidate.columnId === method.id) ?? { columnId: method.id, value: 0, ratio: 0 }
      return { row: { id: method.id, label: method.label }, cell }
    }),
  })), [data.rows])
  const width = labelWidth + data.rows.length * cellWidth + 18
  const height = headerHeight + RESEARCH_METHODS.length * rowHeight + 22
  return (
    <div className="flex h-full w-full items-center justify-center overflow-auto p-2">
      <svg viewBox={`0 0 ${width} ${height}`} className="block h-full max-h-full w-auto max-w-full" preserveAspectRatio="xMidYMid meet" role="img" aria-label="章节研究方法热力图">
        {data.rows.map((row, columnIndex) => {
          const x = labelWidth + columnIndex * cellWidth + cellWidth / 2
          return <text key={row.id} x={x} y="20" textAnchor="middle" fill="var(--yx-ink)" fontSize={isExpanded ? '12' : '10'} fontWeight="600">
            <title>{row.label}</title>
            {compactVisualizationLabel(row.label, isExpanded ? 6 : 4)}
          </text>
        })}
        {RESEARCH_METHODS.map((method, rowIndex) => {
          const y = headerHeight + rowIndex * rowHeight
          return <text key={method.id} x="8" y={y + rowHeight / 2} dominantBaseline="central" fill="var(--yx-ink)" fontSize={isExpanded ? '12' : '10'} fontWeight="600">
            <title>{method.label}</title>
            {compactVisualizationLabel(method.label, isExpanded ? 16 : 12)}
          </text>
        })}
        <HeatmapRect
          data={heatmapData}
          xScale={(columnIndex) => labelWidth + columnIndex * cellWidth}
          yScale={(rowIndex) => headerHeight + rowIndex * rowHeight}
          binWidth={cellWidth}
          binHeight={rowHeight}
          gap={gap}
          colorScale={(value) => heatmapColor(Math.max(0, Math.min(1, Number(value) / 100)))}
          bins={(datum) => datum.bins}
          count={(bin) => bin.cell.value}
        >
          {(cells) => cells.flatMap((columnCells) => columnCells.map((cell) => {
            const section = cell.datum.column
            const method = cell.bin.row
            const value = Number(cell.count) || 0
            return (
              <g key={`${section.id}-${method.id}`}>
                <title>{`${section.label} / ${method.label}：${value}% 使用强度`}</title>
                <rect x={cell.x + 2} y={cell.y + 2} width={Math.max(1, cell.width - 4)} height={Math.max(1, cell.height - 4)} rx="6" fill={cell.color} />
                <text x={cell.x + cell.width / 2} y={cell.y + cell.height / 2} textAnchor="middle" dominantBaseline="central" fill={value >= 55 ? 'var(--yx-paper)' : 'var(--yx-ink)'} fontSize={isExpanded ? '12' : '10'} fontWeight="700">{value > 0 ? `${value}%` : ''}</text>
              </g>
            )
          }))}
        </HeatmapRect>
        <g transform={`translate(8 ${height - 6})`}>
          <rect x="0" y="-7" width="12" height="8" rx="2" fill={heatmapColor(0.15)} />
          <text x="17" y="0" fill="var(--yx-faint)" fontSize="8">较少</text>
          <rect x="52" y="-7" width="12" height="8" rx="2" fill={heatmapColor(0.55)} />
          <text x="69" y="0" fill="var(--yx-faint)" fontSize="8">较多</text>
        </g>
      </svg>
    </div>
  )
}

function heatmapColor(ratio: number) {
  if (ratio <= 0) return 'var(--yx-paper)'
  if (ratio < 0.3) return 'var(--yx-line)'
  if (ratio < 0.55) return '#b4b2ad'
  if (ratio < 0.8) return 'var(--yx-muted)'
  return 'var(--yx-brand)'
}

function compactVisualizationLabel(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value
}







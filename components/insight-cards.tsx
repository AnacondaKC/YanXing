'use client'

import { AlertCircle, FileCheck2, Gauge, Radar, Sparkles } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { AnalysisResultHint } from '@/components/analysis-result-hint'
import { InfoCallout } from '@/components/info-callout'
import { WorkbenchCardDecoration } from '@/components/ui/card-decoration'
import {
  analysisResultPlaceholder,
  isAnalysisResultScanning,
  isAnalysisResultVisible,
  resolveAnalysisResultDisplay,
} from '@/modules/analysis/progress'
import { AiScoreDimensions, MAX_AI_SUGGESTIONS, ReportCompletenessDimensions } from '@/modules/contracts/analysis'
import type { AiScore, AiScoreDimension, AiSuggestion, AnalysisJobStatus, AnalysisSnapshotPayload } from '@/modules/contracts/analysis'

const DEFAULT_SCORE_DIMENSIONS: AiScore['dimensions'] = AiScoreDimensions.map((dim) => ({
  id: dim.id,
  label: dim.label,
  score: 0,
}))

const RADAR_VIEWBOX_SIZE = 300
const RADAR_CENTER = 150
const RADAR_GRID_RADIUS = 110
const COMPLETENESS_BAR_CYCLE_MS = 2400

export function AiScoreCard({ score, analyzing, jobStatus, className }: {
  score: AiScore
  analyzing?: boolean
  jobStatus?: AnalysisJobStatus
  className?: string
}) {
  const hasDimensions = score.dimensions.length > 0
  const display = resolveAnalysisResultDisplay({ analyzing: Boolean(analyzing), hasData: hasDimensions, jobStatus })
  const scanning = isAnalysisResultScanning(display)
  const showScore = isAnalysisResultVisible(display)
  const displayDimensions = hasDimensions ? score.dimensions : DEFAULT_SCORE_DIMENSIONS
  const scores = displayDimensions.map((dimension) => dimension.score)
  const trend = score.previousOverall === undefined ? 0 : score.overall - score.previousOverall

  return (
    <div className={`yx-dashboard-card relative overflow-hidden flex flex-col min-h-0 !py-[20px] !px-[25px] ${className ?? ''}`}>
      <WorkbenchCardDecoration kind="score" />
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
      <div className="mb-1.5 flex shrink-0 items-start justify-between gap-2 sm:mb-2 xl:mb-1.5">
        <div className="flex items-center gap-1.5 sm:gap-2">
          <Radar className="h-[21px] w-[21px] shrink-0 text-yx-ink sm:h-[26px] sm:w-[26px]" />
          <div>
            <h2 className="text-sm font-semibold text-yx-ink sm:text-base">综合评分</h2>
            <p className="mt-px text-[9px] text-yx-muted sm:text-[10px]">AI大模型评分仅供参考</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 self-center text-[9px] font-medium sm:text-[10px]">
          <AnalysisResultHint display={display} />
          {showScore && display === 'ready' ? (
            <span className={trend > 0 ? 'text-yx-brand' : trend < 0 ? 'text-yx-warning' : 'text-yx-faint'}>
              {trend > 0 ? '↑ ' + trend + ' 分' : trend < 0 ? '↓ ' + Math.abs(trend) + ' 分' : '0 分'} · 较上一版
            </span>
          ) : null}

        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 items-stretch gap-3 pb-0 sm:gap-3 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] md:gap-3 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] xl:gap-2 xl:min-h-0 xl:flex-1">
        <div className="relative flex aspect-square h-full max-h-full max-w-full min-h-0 min-w-0 items-center justify-center overflow-hidden mx-auto">
          <svg viewBox="0 0 300 300" className="h-full w-full aspect-square" role="img" aria-label="综合评分雷达图">
            <defs>
              <linearGradient id="radarFill" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="var(--yx-brand)" stopOpacity="0.32" />
                <stop offset="100%" stopColor="var(--yx-brand)" stopOpacity="0.04" />
              </linearGradient>
              <filter id="radarGlow" x="-30%" y="-30%" width="160%" height="160%">
                <feDropShadow dx="0" dy="1.5" stdDeviation="3" floodColor="var(--yx-brand)" floodOpacity="0.3" />
              </filter>
            </defs>
            <g fill="none" stroke="var(--yx-line)" strokeWidth="1">
              {[110, 82.5, 55, 27.5].map((radius, ringIndex) => (
                <polygon key={radius} points={radarPoints(scores.map(() => 100), radius)} strokeOpacity={ringIndex === 0 ? 0.9 : 0.55} strokeDasharray={ringIndex === 3 ? 'none' : '3 3'} />
              ))}
            </g>
            <g stroke="var(--yx-hover)" strokeWidth="1">
              {scores.map((_, index) => {
                const point = radarPoint(index, 110, scores.length)
                return <line key={index} x1="150" y1="150" x2={point.x} y2={point.y} />
              })}
            </g>
            {showScore && (
              <polygon className="yx-data-in" points={radarPoints(scores, 110)} fill="url(#radarFill)" stroke="var(--yx-brand)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" filter="url(#radarGlow)" />
            )}
            {showScore && (
              <g>
                {scores.map((value, index) => {
                  const point = radarPoint(index, 110, scores.length, value)
                  const color = value >= 80 ? 'var(--yx-brand)' : 'var(--yx-warning)'
                  return <circle key={index} cx={point.x} cy={point.y} r="4" fill="white" stroke={color} strokeWidth="2" />
                })}
              </g>
            )}
            <g>
              {displayDimensions.map((dim, index) => {
                const color = showScore ? (dim.score >= 80 ? 'var(--yx-brand)' : 'var(--yx-warning)') : 'var(--yx-muted)'
                const point = radarPoint(index, 125, displayDimensions.length)
                return (
                  <g key={dim.id}>
                    <circle
                      cx={point.x}
                      cy={point.y}
                      r="8.5"
                      fill={showScore ? 'white' : 'var(--yx-surface)'}
                      stroke={showScore ? color : 'var(--yx-line)'}
                      strokeWidth="1.5"
                    />
                    <text
                      x={point.x}
                      y={point.y}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize="9"
                      fontWeight="700"
                      fill={color}
                    >
                      {index + 1}
                    </text>
                  </g>
                )
              })}
            </g>
            <circle cx="150" cy="150" r="28" fill="white" opacity="0.95" />
            <circle cx="150" cy="150" r="28" fill="none" stroke="var(--yx-line)" strokeWidth="1" />
          </svg>
          {scanning ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden="true">
              <div
                className="yx-radar-sweep-disk"
                style={{ width: `${((RADAR_GRID_RADIUS * 2) / RADAR_VIEWBOX_SIZE) * 100}%` }}
              >
                <span className="yx-radar-sweep-needle" />
              </div>
            </div>
          ) : null}
          {scanning ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="yx-radar-origin-dot" aria-hidden="true" />
            </div>
          ) : showScore ? (
            <div className="yx-data-in pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-2xl font-bold sm:text-3xl">{score.overall}</span>
              <span className="text-[10px] text-yx-muted sm:text-xs">综合分</span>
            </div>
          ) : null}
        </div>
        <ScoreMetricList
          dimensions={displayDimensions}
          hasDimensions={showScore}
          analyzing={scanning}
        />
      </div>
      <div className="mt-2 w-full min-w-0 max-w-full shrink-0">
        <InfoCallout
          icon={Gauge}
          label="主要影响因素"
          text={showScore ? score.summary : analysisResultPlaceholder(display)}
          tone="muted"
          scanning={scanning}
        />
      </div>
      </div>
    </div>
  )
}

function radarPoint(index: number, radius: number, count: number, score = 100) {
  const angle = -Math.PI / 2 + (index * Math.PI * 2) / count
  const scaledRadius = radius * score / 100
  return { x: Number((RADAR_CENTER + Math.cos(angle) * scaledRadius).toFixed(2)), y: Number((RADAR_CENTER + Math.sin(angle) * scaledRadius).toFixed(2)) }
}

function radarPoints(scores: number[], radius: number) {
  return scores.map((score, index) => { const point = radarPoint(index, radius, scores.length, score); return `${point.x},${point.y}` }).join(' ')
}



export function ScoreMetricList({ dimensions, hasDimensions, analyzing }: { dimensions: AiScore['dimensions']; hasDimensions: boolean; analyzing?: boolean }) {
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col justify-between space-y-1 sm:space-y-1 md:space-y-0 xl:space-y-0">
      {dimensions.map((dimension, index) => {
        const color = hasDimensions ? (dimension.score >= 80 ? 'var(--yx-brand)' : 'var(--yx-warning)') : undefined
        return (
          <div key={dimension.id} title={dimension.label} className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1.5 py-0.5 text-left transition-colors sm:gap-2 ${hasDimensions ? 'hover:bg-yx-surface' : 'cursor-default'}`}>
            <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold shadow-2xs ${hasDimensions ? 'text-white' : 'border border-yx-line bg-yx-surface text-yx-muted'}`} style={hasDimensions ? { backgroundColor: color } : undefined}>
              {index + 1}
            </span>
            <div className="flex min-w-0 flex-1 flex-col justify-center">
              <div className="flex items-center justify-between gap-1">
                <span className="truncate text-[11px] font-medium text-yx-ink" title={dimension.label}>{dimension.label}</span>
                {hasDimensions ? <span className="shrink-0 text-[10.5px] font-semibold tabular-nums text-yx-ink">{dimension.score}分</span> : analyzing ? <span className="shrink-0 text-[10.5px] font-semibold tabular-nums text-yx-faint">--</span> : null}
              </div>
              {analyzing ? <div className="yx-completeness-bar mt-0.5 !h-1" style={{ '--yx-bar-delay': `${Math.round(index * COMPLETENESS_BAR_CYCLE_MS / dimensions.length)}ms` } as CSSProperties} /> : <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-yx-hover"><div className="h-full rounded-full transition-[width] duration-500" style={{ width: hasDimensions ? `${Math.max(0, Math.min(100, dimension.score))}%` : '0%', backgroundColor: color }} /></div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

const suggestionBarLayouts = [
  ['w-full', 'w-5/6', 'w-2/3'],
  ['w-full', 'w-4/5', 'w-3/5'],
  ['w-11/12', 'w-full', 'w-1/2'],
]

export function SuggestionPlaceholderCards({ scanning }: { scanning?: boolean }) {
  return (
    <div className="yx-no-scrollbar min-h-0 flex flex-1 flex-col gap-2 overflow-y-auto">
      {suggestionBarLayouts.map((bars, index) => (
        <div key={index} className="flex w-full flex-1 flex-col justify-center gap-2 rounded-lg bg-yx-surface px-2.5 py-2.5 sm:px-3">
          {bars.map((width, barIndex) => (
            scanning ? (
              <div key={width} className={`yx-suggestion-bar ${width}`} style={{ '--yx-bar-delay': `${index * 180 + barIndex * 120}ms` } as CSSProperties} />
            ) : (
              <div key={width} className={`h-2 rounded-full bg-yx-line ${width}`} />
            )
          ))}
        </div>
      ))}
    </div>
  )
}

export function SuggestionItem({ suggestion, index }: { suggestion: AiSuggestion; index: number }) {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const textRef = useRef<HTMLParagraphElement>(null)

  useLayoutEffect(() => {
    const el = textRef.current
    if (!el) return

    function measure() {
      if (!textRef.current || expanded) return
      setOverflows(textRef.current.scrollHeight > textRef.current.clientHeight + 1)
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [expanded, suggestion.detail])

  return (
    <div className={`flex w-full flex-1 gap-2 rounded-lg bg-yx-surface px-2.5 py-2 text-xs leading-relaxed sm:px-3 sm:py-2.5 ${expanded ? 'items-start' : 'items-center'}`}>
      <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-yx-brand text-[9px] font-bold text-white ${expanded ? 'mt-0.5' : ''}`}>{index + 1}</span>
      <div className="min-w-0 flex-1">
        <p ref={textRef} className={expanded ? 'text-yx-ink' : 'line-clamp-4 text-yx-ink'}>{suggestion.detail}</p>
        {overflows || expanded ? (
          <button
            type="button"
            className="mt-1 text-[10px] font-medium text-yx-brand transition-colors hover:text-yx-brand-hover"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? '收起' : '展开'}
          </button>
        ) : null}
      </div>
    </div>
  )
}
export function AiSuggestionsCard({ snapshot, analyzing, jobStatus, className }: { snapshot: AnalysisSnapshotPayload; analyzing?: boolean; jobStatus?: AnalysisJobStatus; className?: string }) {
  const suggestions = snapshot.suggestions.slice(0, MAX_AI_SUGGESTIONS)
  const display = resolveAnalysisResultDisplay({ analyzing: Boolean(analyzing), hasData: suggestions.length > 0, jobStatus })
  const showSuggestions = isAnalysisResultVisible(display)

  return (
    <div className={`yx-dashboard-card relative overflow-hidden flex flex-col ${className ?? ''}`}>
      <WorkbenchCardDecoration kind="suggestions" />
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
      <div className="mb-2 flex items-start justify-between gap-2 xl:mb-1.5">
        <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
          <Sparkles className="h-[21px] w-[21px] shrink-0 text-yx-ink sm:h-[26px] sm:w-[26px]" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-yx-ink sm:text-base">AI建议</h2>
            <p className="mt-px text-[9px] text-yx-muted sm:text-[10px]">AI根据报告内容生成的下一步建议</p>
          </div>
        </div>
        <AnalysisResultHint display={display} />

      </div>
      {showSuggestions ? (
        <div className="yx-data-in yx-no-scrollbar min-h-0 flex flex-1 flex-col gap-2 overflow-y-auto">
          {suggestions.map((suggestion, index) => (
            <SuggestionItem key={suggestion.id} suggestion={suggestion} index={index} />
          ))}
        </div>
      ) : (
        <SuggestionPlaceholderCards scanning={isAnalysisResultScanning(display)} />
      )}
      </div>
    </div>
  )
}

export function ScoreRing({ score, unanalyzed, analyzing }: { score: number; unanalyzed?: boolean; analyzing?: boolean }) {
  const color = score >= 80 ? 'var(--yx-brand)' : 'var(--yx-warning)'
  if (analyzing) {
    return (
      <span className="yx-completeness-ring shrink-0">
        <svg viewBox="0 0 36 36" className="h-full w-full" role="img" aria-label="评估中">
          <circle cx="18" cy="18" r="14" fill="none" stroke="var(--yx-hover)" strokeWidth="3.2" />
        </svg>
        <span className="yx-completeness-ring__sweep" aria-hidden="true" />
      </span>
    )
  }
  return (
    <svg viewBox="0 0 36 36" className="h-[34px] w-[34px] shrink-0 -rotate-90 sm:h-[36px] sm:w-[36px]" role="img" aria-label={unanalyzed ? '待评估' : `${score}分`}>
      <circle cx="18" cy="18" r="14" fill="none" stroke="var(--yx-hover)" strokeWidth="3.5" />
      {unanalyzed ? null : (
        <circle cx="18" cy="18" r="14" fill="none" stroke={color} strokeWidth="3.5" strokeLinecap="round" pathLength="100" strokeDasharray={`${score} ${100 - score}`} />
      )}
      {unanalyzed ? null : (
        <text x="18" y="18" textAnchor="middle" dominantBaseline="central" transform="rotate(90 18 18)" fontSize="11" fontWeight="700" fill="var(--yx-ink)">{score}</text>
      )}
    </svg>
  )
}

const DEFAULT_COMPLETENESS_METRICS: AiScoreDimension[] = ReportCompletenessDimensions.map((dim) => ({
  id: dim.id,
  label: dim.label,
  score: 0,
}))

export function ReportCompletenessCard({ snapshot, analyzing, jobStatus, className }: { snapshot: AnalysisSnapshotPayload; analyzing?: boolean; jobStatus?: AnalysisJobStatus; className?: string }) {
  const completeness = snapshot.reportCompleteness
  const hasScore = Boolean(completeness && completeness.dimensions && completeness.dimensions.length > 0)
  const display = resolveAnalysisResultDisplay({ analyzing: Boolean(analyzing), hasData: hasScore, jobStatus })
  const scanning = isAnalysisResultScanning(display)
  const displayMetrics: AiScoreDimension[] = hasScore && completeness?.dimensions ? completeness.dimensions : DEFAULT_COMPLETENESS_METRICS
  const overall = completeness?.overall ?? 0
  const showScore = isAnalysisResultVisible(display)
  const progressColor = overall >= 80 ? 'var(--yx-brand)' : 'var(--yx-warning)'

  return (
    <div className={`yx-dashboard-card relative overflow-hidden min-h-0 flex flex-col ${className ?? ''}`}>
      <WorkbenchCardDecoration kind="completeness" />
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
      <div className="mb-1 flex items-start justify-between gap-2 xl:mb-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <FileCheck2 className="h-4 w-4 shrink-0 text-yx-ink sm:h-5 sm:w-5" />
          <div className="min-w-0">
            <h2 className="text-xs font-semibold text-yx-ink sm:text-sm">报告完整度</h2>
            <p className="mt-px text-[9px] text-yx-muted">AI结构与逻辑评估</p>
          </div>
        </div>
        <div className="flex shrink-0 self-center items-center gap-1.5">
          <AnalysisResultHint display={display} />
          {showScore ? <span className="yx-data-in text-base font-bold leading-none text-yx-ink sm:text-lg">{overall}%</span> : scanning ? <span className="text-base font-bold leading-none text-yx-faint sm:text-lg">--</span> : null}

        </div>
      </div>
      {scanning ? <div className="yx-completeness-bar shrink-0" /> : <div className="!h-[6px] shrink-0 overflow-hidden rounded-full bg-yx-hover"><div className="h-full rounded-full transition-all duration-500" style={{ width: showScore ? overall + '%' : '0%', backgroundColor: progressColor }} /></div>}
      <div className="mt-1 grid grid-cols-6 gap-1 xl:mt-1">
        {displayMetrics.map((metric) => (
          <div key={metric.id} title={metric.label} className={'flex min-w-0 flex-col items-center gap-0.5 rounded-md py-0.5 transition-colors ' + (showScore ? 'hover:bg-yx-surface' : 'cursor-default')}>
            <ScoreRing score={metric.score} unanalyzed={!showScore} analyzing={scanning} />
            <span className="w-full truncate text-center text-[8.5px] leading-tight text-yx-muted sm:text-[9px]" title={metric.label}>{metric.label}</span>
          </div>
        ))}
      </div>
      <div className="mt-auto w-full min-w-0 max-w-full shrink-0">
        <InfoCallout icon={AlertCircle} label="主要缺口" text={showScore ? (completeness?.mainGap || '等待完整度评估完成。') : analysisResultPlaceholder(display)} tone="muted" scanning={scanning} scanDelay="440ms" />
      </div>
      </div>
    </div>
  )
}

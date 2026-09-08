import type { LucideIcon } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import type { RepositoryDataState } from '@/components/repository-loading'

export function CellCaption({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="text-center">
      <div className="text-[9px] font-medium text-yx-faint">{label}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  )
}

export function RepositoryStatCell({
  label,
  value,
  unit,
  icon: Icon,
  valueClassName,
  points,
  trendLabel,
  gradientId,
  dataState = 'ready',
  entranceIndex = 0,
}: {
  label: string
  value: string
  unit: string
  icon: LucideIcon
  valueClassName?: string
  points: number[]
  trendLabel: string
  gradientId: string
  dataState?: RepositoryDataState
  entranceIndex?: number
}) {
  return (
    <div aria-busy={dataState === 'loading'} className="yx-repository-stat min-w-0 bg-yx-paper px-3 py-3" style={{ '--repository-index': Math.min(entranceIndex, 5) } as CSSProperties}>
      <div className="flex min-w-0 items-center gap-1.5 text-yx-muted" title={label}>
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-yx-brand-soft text-yx-brand">
          <Icon className="h-2.5 w-2.5" strokeWidth={1.75} />
        </span>
        <span className="truncate text-[10px] font-medium">{label}</span>
      </div>
      {dataState === 'loading' ? (
        <div role="status" aria-label={label + '正在加载'} className="mt-1.5 flex h-[22px] items-end justify-between gap-2">
          <span aria-hidden="true" className="yx-repository-skeleton block h-[18px] w-14" />
          <span aria-hidden="true" className="yx-repository-skeleton mb-0.5 block h-3 w-10" />
        </div>
      ) : dataState === 'error' ? (
        <div aria-label={label + '暂时无法加载'} className="mt-1.5 h-[22px] text-[18px] leading-none text-yx-faint">--</div>
      ) : (
      <div className="mt-1.5 flex items-end justify-between gap-2">
        <div className="min-w-0 truncate leading-none" title={`${value} ${unit}`.trim()}>
          <span className={`text-[18px] font-bold tracking-tight tabular-nums ${valueClassName ?? 'text-yx-ink'}`}>{value}</span>
          {unit ? <span className="ml-1 align-middle text-[9px] font-medium text-yx-faint">{unit}</span> : null}
        </div>
        <RepositorySparkline points={points} gradientId={gradientId} label={trendLabel} />
      </div>
      )}
    </div>
  )
}

function smoothLinePath(coords: Array<readonly [number, number]>) {
  if (coords.length === 0) return ''
  if (coords.length === 1) return `M${coords[0][0].toFixed(1)},${coords[0][1].toFixed(1)}`
  let path = `M${coords[0][0].toFixed(1)},${coords[0][1].toFixed(1)}`
  for (let index = 0; index < coords.length - 1; index += 1) {
    const previous = coords[index === 0 ? 0 : index - 1]
    const current = coords[index]
    const next = coords[index + 1]
    const after = coords[index + 2] ?? next
    const control1x = current[0] + (next[0] - previous[0]) / 6
    const control1y = current[1] + (next[1] - previous[1]) / 6
    const control2x = next[0] - (after[0] - current[0]) / 6
    const control2y = next[1] - (after[1] - current[1]) / 6
    path += ` C${control1x.toFixed(1)},${control1y.toFixed(1)} ${control2x.toFixed(1)},${control2y.toFixed(1)} ${next[0].toFixed(1)},${next[1].toFixed(1)}`
  }
  return path
}

function RepositorySparkline({
  points,
  gradientId,
  label,
}: {
  points: number[]
  gradientId: string
  label: string
}) {
  const width = 56
  const height = 22
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
  const linePath = smoothLinePath(coords)
  const last = coords[coords.length - 1]
  const first = coords[0]
  const areaPath = `${linePath} L${last[0].toFixed(1)},${height} L${first[0].toFixed(1)},${height} Z`
  const hasData = points.some((point) => point > 0)

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="mb-0.5 h-[22px] w-14 shrink-0 overflow-visible" role="img" aria-label={label}>
      <title>{label}</title>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--yx-brand)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--yx-brand)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {hasData && <path d={areaPath} fill={`url(#${gradientId})`} />}
      <path
        d={linePath}
        fill="none"
        stroke={hasData ? 'var(--yx-brand)' : 'var(--yx-line)'}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={hasData ? undefined : '2 3'}
      />
      {hasData && (
        <>
          <circle cx={last[0]} cy={last[1]} r="3.1" fill="var(--yx-brand)" opacity="0.18" />
          <circle cx={last[0]} cy={last[1]} r="1.7" fill="var(--yx-brand)" stroke="var(--yx-paper)" strokeWidth="0.9" />
        </>
      )}
    </svg>
  )
}

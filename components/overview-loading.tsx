import type { ReactNode } from 'react'
import { cx } from '@/lib/cn'
import type { OverviewLoadState } from '@/lib/overview-loading'

export function OverviewSkeleton({ className = '' }: { className?: string }) {
  return <span aria-hidden="true" className={`yx-overview-skeleton block ${className}`} />
}

const FILL_LAYOUT_CLASS = 'flex min-h-0 flex-1 flex-col'

export function OverviewDataRegion({ state, label, placeholder, children, layout }: {
  state: OverviewLoadState
  label: string
  placeholder: ReactNode
  children: ReactNode
  layout?: 'fill'
}) {
  const fillClass = layout === 'fill' ? FILL_LAYOUT_CLASS : undefined
  return (
    <div aria-busy={state === 'loading'} className={fillClass}>
      {state === 'loading' ? (
        <div role="status" aria-label={label + '正在加载'} className={fillClass}>{placeholder}</div>
      ) : state === 'error' ? (
        <p role="status" className={cx('flex min-h-24 items-center text-xs leading-6 text-yx-muted', fillClass && 'flex-1')}>{label}暂时无法加载，请稍后重试。</p>
      ) : (
        <div className={cx('yx-overview-data', fillClass)}>{children}</div>
      )}
    </div>
  )
}

export function OverviewMetricSkeleton() {
  return (
    <div className="pt-2">
      <OverviewSkeleton className="h-6 w-20" />
      <OverviewSkeleton className="mt-1.5 h-3.5 w-32 max-w-full" />
    </div>
  )
}

export function OverviewQualitySkeleton() {
  return (
    <div className="mt-4 min-h-[310px] space-y-5">
      <div className="flex items-center gap-4">
        <OverviewSkeleton className="h-[122px] w-[122px] shrink-0 !rounded-full" />
        <div className="flex-1 space-y-3">
          <OverviewSkeleton className="h-14 w-full" />
          <OverviewSkeleton className="h-14 w-full" />
        </div>
      </div>
      <OverviewSkeleton className="h-2 w-full" />
      <div className="space-y-3">
        {[0, 1, 2, 3].map((row) => <OverviewSkeleton key={row} className="h-3 w-full" />)}
      </div>
    </div>
  )
}

export function OverviewActivitySkeleton() {
  return (
    <div className="mt-4 min-h-[310px]">
      <OverviewSkeleton className="h-16 w-full" />
      <div className="mt-5 space-y-5">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="flex items-center gap-2.5">
            <OverviewSkeleton className="h-8 w-8 shrink-0" />
            <div className="min-w-0 flex-1 space-y-2">
              <OverviewSkeleton className="h-3 w-4/5" />
              <OverviewSkeleton className="h-2 w-3/5" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

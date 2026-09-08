import type { ReactNode } from 'react'
import { cx } from '@/lib/cn'

export function Field({
  label,
  htmlFor,
  required,
  helper,
  children,
  className = '',
}: {
  label: string
  htmlFor?: string
  required?: boolean
  helper?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cx('min-w-0', className)}>
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-xs font-semibold text-yx-ink">
            {label}
            {required ? <span className="text-yx-danger"> *</span> : null}
          </label>
        ) : (
          <span className="text-xs font-semibold text-yx-ink">
            {label}
            {required ? <span className="text-yx-danger"> *</span> : null}
          </span>
        )}
        {helper ? <span className="font-mono text-[10px] text-yx-muted">{helper}</span> : null}
      </div>
      {children}
    </div>
  )
}

export function FormError({ children, className = '' }: { children: ReactNode; className?: string }) {
  if (!children) return null
  return (
    <div role="alert" className={cx('rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-xs text-rose-700', className)}>
      {children}
    </div>
  )
}

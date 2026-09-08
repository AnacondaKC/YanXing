import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { IconBadge } from '@/components/ui/icon-badge'
import { cx } from '@/lib/cn'

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className = '',
}: {
  icon: LucideIcon
  title?: string
  description: string
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cx('flex flex-col items-center justify-center rounded-lg border border-dashed border-yx-line bg-yx-paper px-4 py-12 text-center', className)}>
      <IconBadge icon={Icon} size="lg" rounded="xl" />
      {title ? <p className="mt-2 text-sm font-semibold text-yx-ink">{title}</p> : null}
      <p className={cx('max-w-sm text-xs text-yx-muted', title ? 'mt-1' : 'mt-2')}>{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

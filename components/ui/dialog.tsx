'use client'

import { X, type LucideIcon } from 'lucide-react'
import { useRef, type ReactNode, type RefObject } from 'react'
import { useDialogFocus } from '@/components/use-dialog-focus'
import { Button } from '@/components/ui/button'
import { cx } from '@/lib/cn'

const sizeClass = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '3xl': 'max-w-3xl',
  '4xl': 'max-w-4xl',
  '5xl': 'max-w-5xl',
} as const

const zClass = {
  50: 'z-50',
  70: 'z-[70]',
  80: 'z-[80]',
  90: 'z-[90]',
} as const

const iconToneClass = {
  brand: 'bg-yx-brand text-white shadow-2xs',
  danger: 'bg-yx-danger text-white shadow-2xs',
} as const

export type DialogSize = keyof typeof sizeClass
export type DialogZIndex = keyof typeof zClass
export type DialogIconTone = keyof typeof iconToneClass

export function Dialog({
  onClose,
  labelledBy,
  describedBy,
  label,
  size = 'md',
  zIndex = 50,
  align = 'center',
  className = '',
  panelClassName = '',
  initialFocusRef,
  children,
}: {
  onClose: () => void
  labelledBy?: string
  describedBy?: string
  label?: string
  size?: DialogSize
  zIndex?: DialogZIndex
  align?: 'center' | 'top'
  className?: string
  panelClassName?: string
  initialFocusRef?: RefObject<HTMLElement | null>
  children: ReactNode
}) {
  const fallbackFocusRef = useRef<HTMLElement | null>(null)
  const dialogRef = useDialogFocus(onClose, initialFocusRef ?? fallbackFocusRef)

  return (
    <div
      className={cx(
        'fixed inset-0 flex justify-center p-3 sm:p-4',
        zClass[zIndex],
        align === 'top' ? 'items-start pt-[12vh] sm:p-4 sm:pt-[14vh]' : 'items-center',
        className,
      )}
      role="presentation"
    >
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-black/40 backdrop-blur-2xs"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-label={label}
        tabIndex={-1}
        className={cx(
          'relative w-full overflow-hidden rounded-lg border border-yx-line bg-yx-paper shadow-2xl',
          sizeClass[size],
          panelClassName,
        )}
      >
        {children}
      </div>
    </div>
  )
}

export function DialogCloseButton({
  onClose,
  label = '关闭',
  buttonRef,
  className = '',
  disabled = false,
}: {
  onClose: () => void
  label?: string
  buttonRef?: RefObject<HTMLButtonElement | null>
  className?: string
  disabled?: boolean
}) {
  return (
    <Button
      ref={buttonRef}
      variant="icon"
      size="sm"
      onClick={onClose}
      disabled={disabled}
      aria-label={label}
      className={cx('shrink-0 text-yx-faint', className)}
    >
      <X className="h-4 w-4" />
    </Button>
  )
}

export function DialogHeader({
  title,
  description,
  titleId,
  descriptionId,
  icon: Icon,
  iconTone = 'brand',
  onClose,
  closeRef,
  closeLabel,
}: {
  title: string
  description?: string
  titleId: string
  descriptionId?: string
  icon?: LucideIcon
  iconTone?: DialogIconTone
  onClose: () => void
  closeRef?: RefObject<HTMLButtonElement | null>
  closeLabel?: string
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-yx-line px-5 py-4">
      <div className="flex min-w-0 items-start gap-2.5">
        {Icon ? (
          <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', iconToneClass[iconTone])}>
            <Icon className="h-4 w-4" />
          </span>
        ) : null}
        <div className="min-w-0">
          <h2 id={titleId} className="text-sm font-bold tracking-tight text-yx-ink sm:text-base">
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} className="mt-0.5 truncate text-[10px] leading-relaxed text-yx-muted" title={description}>
              {description}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <DialogCloseButton onClose={onClose} buttonRef={closeRef} label={closeLabel} />
      </div>
    </div>
  )
}

export function DialogBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={cx('px-5 py-5', className)}>{children}</div>
}

export function DialogFooter({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('flex justify-end gap-2 border-t border-yx-line bg-yx-surface px-5 py-3.5', className)}>
      {children}
    </div>
  )
}

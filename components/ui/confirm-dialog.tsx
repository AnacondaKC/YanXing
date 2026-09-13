'use client'

import { Trash2, type LucideIcon } from 'lucide-react'
import { useRef, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '@/components/ui/dialog'
import { FormError } from '@/components/ui/field'

export function ConfirmDialog({
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  tone = 'danger',
  loading = false,
  confirmDisabled = false,
  error,
  icon,
  titleId,
  descriptionId,
  onClose,
  onConfirm,
  children,
}: {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'danger' | 'primary'
  loading?: boolean
  confirmDisabled?: boolean
  error?: string
  icon?: LucideIcon
  titleId: string
  descriptionId?: string
  onClose: () => void
  onConfirm: () => void
  children?: ReactNode
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog onClose={onClose} labelledBy={titleId} describedBy={descriptionId} initialFocusRef={cancelRef} size="md">
      <DialogHeader
        title={title}
        titleId={titleId}
        icon={icon ?? Trash2}
        iconTone={tone === 'danger' ? 'danger' : 'brand'}
        onClose={onClose}
      />
      {description || children || error ? (
        <DialogBody className="space-y-3">
          {description ? (
            <p id={descriptionId} className="text-sm leading-6 text-yx-ink-soft">
              {description}
            </p>
          ) : null}
          {children}
          {error ? <FormError>{error}</FormError> : null}
        </DialogBody>
      ) : null}
      <DialogFooter>
        <Button ref={cancelRef} variant="ghost" onClick={onClose} disabled={loading}>
          {cancelLabel}
        </Button>
        <Button variant={tone === 'danger' ? 'danger' : 'primary'} loading={loading} disabled={confirmDisabled} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

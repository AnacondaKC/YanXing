'use client'

import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { workspaceErrorCopy } from '@/lib/workspace-error'

export function ErrorFallback({
  onRetry,
  onHome,
}: {
  onRetry: () => void
  onHome?: () => void
}) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 py-16 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-yx-line bg-yx-surface">
        <AlertCircle className="h-4 w-4 text-yx-warning-text" />
      </span>
      <h1 className="mt-4 text-lg font-semibold text-yx-ink">{workspaceErrorCopy.title}</h1>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-yx-muted">{workspaceErrorCopy.description}</p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <Button onClick={onRetry}>{workspaceErrorCopy.retry}</Button>
        {onHome ? (
          <Button variant="outline" onClick={onHome}>{workspaceErrorCopy.home}</Button>
        ) : null}
      </div>
    </div>
  )
}

'use client'

import { ErrorFallback } from '@/components/error-fallback'

export default function WorkspaceError({
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <ErrorFallback
      onRetry={reset}
      onHome={() => { window.location.assign('/') }}
    />
  )
}

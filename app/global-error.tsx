'use client'

import { ErrorFallback } from '@/components/error-fallback'
import './globals.css'

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="zh-CN">
      <body className="font-sans antialiased">
        <ErrorFallback
          onRetry={reset}
          onHome={() => { window.location.assign('/') }}
        />
      </body>
    </html>
  )
}

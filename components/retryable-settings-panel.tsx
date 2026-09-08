'use client'

import { Component, lazy, Suspense, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { createRetryableLazyResource } from '@/lib/retryable-lazy'

export const settingsPanelStatusCopy = {
  loading: '正在载入设置内容…',
  failed: '设置内容载入失败，请重试。',
  retry: '重试',
} as const

export function SettingsPanelLoading() {
  return <div role="status" className="flex min-h-48 items-center justify-center text-xs text-yx-muted">{settingsPanelStatusCopy.loading}</div>
}

export function SettingsPanelLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
      <p className="text-xs text-yx-muted">{settingsPanelStatusCopy.failed}</p>
      <Button size="sm" onClick={onRetry}>{settingsPanelStatusCopy.retry}</Button>
    </div>
  )
}

export class SettingsPanelErrorBoundary extends Component<{ onRetry: () => void; children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  render() {
    if (this.state.hasError) return <SettingsPanelLoadError onRetry={this.props.onRetry} />
    return this.props.children
  }
}

export function createRetryableSettingsPanel<TProps extends object>(
  importPanel: () => Promise<ComponentType<TProps>>,
): ComponentType<TProps> {
  const resource = createRetryableLazyResource(importPanel)

  function RetryableSettingsPanel(props: TProps) {
    const [generation, setGeneration] = useState(0)
    const Panel = useMemo(() => {
      const snapshot = resource.snapshot()
      if (snapshot.status === 'loaded' && snapshot.value) return snapshot.value
      return lazy(() => resource.load().then((Loaded) => ({ default: Loaded })))
    }, [generation])

    return (
      <SettingsPanelErrorBoundary key={generation} onRetry={() => setGeneration((current) => current + 1)}>
        <Suspense fallback={<SettingsPanelLoading />}>
          <Panel {...props} />
        </Suspense>
      </SettingsPanelErrorBoundary>
    )
  }

  return RetryableSettingsPanel
}

'use client'

import { useCallback, useEffect, useState } from 'react'

const WORKSPACE_ENTRANCE_SETTLE_MS = 550

export function useWorkspaceEntrance(loading = false) {
  const [entering, setEntering] = useState(true)
  const finishEntrance = useCallback(() => setEntering(false), [])

  useEffect(() => {
    if (loading || !entering) return
    const timer = window.setTimeout(finishEntrance, WORKSPACE_ENTRANCE_SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [loading, entering, finishEntrance])

  const entranceProps = {
    'data-enter': entering,
    onInputCapture: finishEntrance,
    onClickCapture: finishEntrance,
    onKeyDownCapture: finishEntrance,
    onPointerDownCapture: finishEntrance,
    onWheelCapture: finishEntrance,
  }

  return { entering, finishEntrance, entranceProps }
}

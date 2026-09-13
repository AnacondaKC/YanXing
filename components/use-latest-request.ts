'use client'

import { useEffect, useRef } from 'react'

export function createLatestRequestGuard() {
  let generation = 0
  let controller: AbortController | undefined

  function invalidate() {
    generation += 1
    controller?.abort()
  }

  function begin(externalSignal?: AbortSignal) {
    invalidate()
    const requestGeneration = generation
    const next = new AbortController()
    controller = next

    const abortFromExternal = () => next.abort()
    let listening = false
    if (externalSignal) {
      if (externalSignal.aborted) next.abort()
      else {
        externalSignal.addEventListener('abort', abortFromExternal, { once: true, signal: next.signal })
        listening = true
      }
    }

    return {
      signal: next.signal,
      isCurrent: () => requestGeneration === generation && !next.signal.aborted,
      end() {
        if (listening && externalSignal) {
          listening = false
          externalSignal.removeEventListener('abort', abortFromExternal)
        }
        if (controller === next) controller = undefined
      },
    }
  }

  return { begin, invalidate }
}

export function useLatestRequest() {
  const guardRef = useRef<ReturnType<typeof createLatestRequestGuard> | undefined>(undefined)
  if (!guardRef.current) guardRef.current = createLatestRequestGuard()
  const guard = guardRef.current
  useEffect(() => () => guard.invalidate(), [guard])
  return guard
}

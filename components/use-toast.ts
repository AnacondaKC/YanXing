'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export function useToast(duration = 2800) {
  const [notice, setNotice] = useState('')
  const timerRef = useRef<number | undefined>(undefined)
  const sequenceRef = useRef(0)

  useEffect(() => () => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
  }, [])

  const showNotice = useCallback((message: string) => {
    const sequence = sequenceRef.current + 1
    sequenceRef.current = sequence
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
    setNotice(message)
    timerRef.current = window.setTimeout(() => {
      if (sequenceRef.current !== sequence) return
      setNotice('')
      timerRef.current = undefined
    }, duration)
  }, [duration])

  const clearNotice = useCallback(() => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
    timerRef.current = undefined
    setNotice('')
  }, [])

  return { notice, showNotice, clearNotice }
}

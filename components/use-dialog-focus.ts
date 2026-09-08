'use client'

import { useEffect, useRef, type RefObject } from 'react'

type DialogNode = { contains(node: Node): boolean }

const activeDialogs: Array<{ dialog: HTMLElement }> = []

export function isTopmostDialog(dialog: DialogNode, entries: DialogNode[] = activeDialogs.map((entry) => entry.dialog)) {
  return !entries.some((other) => other !== dialog && dialog.contains(other as Node))
}

export function useDialogFocus<T extends HTMLElement>(onClose: () => void, initialFocusRef: RefObject<T | null>, active = true) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!active) return
    const dialog = dialogRef.current
    if (!dialog) return
    const entry = { dialog }
    activeDialogs.push(entry)
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const focusFrame = window.requestAnimationFrame(() => {
      if (!isTopmostDialog(dialog)) return
      const target = initialFocusRef.current ?? dialog.querySelector<HTMLElement>(focusableSelector)
      if (target) target.focus()
      else dialog.focus()
    })
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostDialog(dialog)) return
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
      if (!focusable.length) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const activeElement = document.activeElement
      const activeInList = activeElement instanceof HTMLElement && focusable.includes(activeElement)
      if (!activeInList) {
        event.preventDefault()
        if (event.shiftKey) last.focus()
        else first.focus()
        return
      }
      if (event.shiftKey && activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', handleKeyDown)
      const index = activeDialogs.indexOf(entry)
      if (index >= 0) activeDialogs.splice(index, 1)
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [active, initialFocusRef])

  return dialogRef
}

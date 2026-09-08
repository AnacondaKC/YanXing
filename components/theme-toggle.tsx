'use client'

import { Moon, Sun } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

export const YX_THEME_STORAGE_KEY = 'yx-theme'
export const YX_THEME_CHANGE_EVENT = 'yx:themechange'

export function isDarkTheme() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

/**
 * 深色/亮色切换按钮。主题状态持久化到 localStorage,
 * 切换时通过 yx:themechange 自定义事件通知其他组件(如 docx 阅读器)。
 */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const [dark, setDark] = useState(isDarkTheme)

  useEffect(() => {
    const sync = () => setDark(isDarkTheme())
    window.addEventListener(YX_THEME_CHANGE_EVENT, sync)
    return () => window.removeEventListener(YX_THEME_CHANGE_EVENT, sync)
  }, [])

  const toggle = useCallback(() => {
    const next = !isDarkTheme()
    document.documentElement.classList.toggle('dark', next)
    try {
      window.localStorage.setItem(YX_THEME_STORAGE_KEY, next ? 'dark' : 'light')
    } catch {
      // 隐私模式下可能不可写,忽略
    }
    setDark(next)
    window.dispatchEvent(new CustomEvent(YX_THEME_CHANGE_EVENT, { detail: { dark: next } }))
  }, [])

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? '切换到亮色模式' : '切换到深色模式'}
      title={dark ? '切换到亮色模式' : '切换到深色模式'}
      className={`flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-yx-ink lg:h-8 lg:w-8 ${className}`}
    >
      {dark ? <Sun className="h-3.5 w-3.5 lg:h-4 lg:w-4" /> : <Moon className="h-3.5 w-3.5 lg:h-4 lg:w-4" />}
    </button>
  )
}

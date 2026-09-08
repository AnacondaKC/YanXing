'use client'

import { Bell, CheckCheck, Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch, mutationHeaders } from '@/lib/client-request'
import { notificationActions, type NotificationAction, type NotificationItem } from '@/modules/notifications/domain'
import type { SessionUser } from '@/modules/users/domain'
import { Button } from '@/components/ui/button'

const NOTIFICATION_PAGE_SIZE = 40
const NOTIFICATION_POLL_INTERVAL = 30_000
const notificationActionValues = new Set(Object.values(notificationActions))
const actionLabels: Record<NotificationAction, string> = {
  project_created: '课题',
  project_updated: '课题',
  project_deleted: '课题',
  report_uploaded: '报告',
  report_assigned: '阶段',
  report_replaced: '报告',
  report_deleted: '报告',
  analysis_started: '分析',
  analysis_cancelled: '分析',
  insight_started: '洞察',
}

interface NotificationResponse {
  notifications: NotificationItem[]
  total: number
  unreadCount: number
}

interface LoadOptions {
  signal?: AbortSignal
  showLoading?: boolean
}

export function NotificationCenter({ user, refreshKey = 0 }: { user: SessionUser; refreshKey?: number }) {
  const [open, setOpen] = useState(false)
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [markingRead, setMarkingRead] = useState(false)
  const [error, setError] = useState('')
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const refreshKeyRef = useRef(refreshKey)
  const loadSequenceRef = useRef(0)
  const loadControllerRef = useRef<AbortController | undefined>(undefined)
  const pendingWritesRef = useRef(0)
  const userId = user.id
  const isAdmin = user.role === 'admin'

  const loadNotifications = useCallback(async ({ signal, showLoading = false }: LoadOptions = {}) => {
    const requestSequence = ++loadSequenceRef.current
    loadControllerRef.current?.abort()
    const controller = new AbortController()
    loadControllerRef.current = controller
    if (signal) {
      const abort = () => controller.abort()
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }
    if (showLoading) setLoading(true)
    try {
      const response = await apiFetch('/api/notifications?limit=' + NOTIFICATION_PAGE_SIZE + '&offset=0', { cache: 'no-store', signal: controller.signal })
      const body = await response.json().catch(() => null) as unknown
      if (!response.ok) throw new Error(readError(body, '通知读取失败。'))
      const parsed = parseNotificationResponse(body)
      if (!parsed) throw new Error('通知响应格式无效。')
      if (controller.signal.aborted || requestSequence !== loadSequenceRef.current) return false
      setNotifications(parsed.notifications)
      setUnreadCount(parsed.unreadCount)
      setTotal(parsed.total)
      setError('')
      setHasLoaded(true)
      return true
    } catch (cause) {
      if (controller.signal.aborted || requestSequence !== loadSequenceRef.current) return false
      setError(cause instanceof Error ? cause.message : '通知读取失败。')
      return false
    } finally {
      if (loadControllerRef.current === controller) loadControllerRef.current = undefined
      if (showLoading && !controller.signal.aborted && requestSequence === loadSequenceRef.current) setLoading(false)
    }
  }, [userId])

  const markRead = useCallback(async ({ all = false, ids = [] }: { all?: boolean; ids?: string[] }) => {
    if (!all && !ids.length) return
    pendingWritesRef.current += 1
    setMarkingRead(true)
    try {
      const response = await apiFetch('/api/notifications', {
        method: 'PATCH',
        headers: { ...mutationHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(all ? { all: true } : { ids }),
      })
      const body = await response.json().catch(() => null) as unknown
      if (!response.ok) throw new Error(readError(body, '通知状态更新失败。'))
      await loadNotifications()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '通知状态更新失败。')
    } finally {
      pendingWritesRef.current = Math.max(0, pendingWritesRef.current - 1)
      if (pendingWritesRef.current === 0) setMarkingRead(false)
    }
  }, [loadNotifications])

  useEffect(() => {
    const controller = new AbortController()
    void loadNotifications({ signal: controller.signal, showLoading: true })
    const timer = window.setInterval(() => {
      void loadNotifications({ signal: controller.signal })
    }, NOTIFICATION_POLL_INTERVAL)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [loadNotifications])

  useEffect(() => {
    if (refreshKeyRef.current === refreshKey) return
    refreshKeyRef.current = refreshKey
    void loadNotifications()
  }, [loadNotifications, refreshKey])

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node) || buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  function togglePanel() {
    const nextOpen = !open
    setOpen(nextOpen)
    if (nextOpen) {
      void loadNotifications().then((loaded) => {
        if (loaded) void markRead({ all: true })
      })
    }
  }

  return (
    <>
      <Button
        ref={buttonRef}
        variant="icon"
        onClick={togglePanel}
        aria-label={unreadCount ? '通知，有 ' + unreadCount + ' 条未读' : '通知'}
        aria-expanded={open}
        aria-controls="workspace-notification-panel"
        title="通知"
        className="relative rounded-lg"
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-yx-danger px-0.5 font-mono text-[7px] font-bold leading-none text-white ring-1 ring-yx-paper">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </Button>
      {open && (
        <div ref={panelRef} id="workspace-notification-panel" role="dialog" aria-label="通知中心" className="absolute right-0 top-full z-50 mt-2 w-[min(24rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-yx-line bg-yx-paper shadow-xl">
          <div className="border-b border-yx-line bg-yx-surface/80 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-bold tracking-tight text-yx-ink">{isAdmin ? '团队操作记录' : '课题动态'}</h2>
                  {isAdmin && <span className="rounded-full bg-yx-brand/10 px-1.5 py-0.5 text-[9px] font-semibold text-yx-brand-hover">管理员明细</span>}
                </div>
                <p className="mt-0.5 text-[10px] text-yx-muted">{unreadCount ? unreadCount + ' 条未读动态' : total ? '最近的研究协作动态' : '完成操作后，动态会显示在这里'}</p>
              </div>
              <button type="button" onClick={() => void markRead({ all: true })} disabled={!unreadCount || markingRead} className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-yx-muted transition-colors hover:bg-yx-hover hover:text-yx-ink disabled:cursor-not-allowed disabled:opacity-40" title="将全部通知标记为已读">
                <CheckCheck className="h-3.5 w-3.5" /> 全部已读
              </button>
            </div>
          </div>
          {error && (
            <div className="flex items-center gap-2 border-b border-rose-100 bg-rose-50 px-4 py-2.5 text-[10px] text-rose-700">
              <span className="min-w-0 flex-1">{error}</span>
              <button type="button" onClick={() => void loadNotifications({ showLoading: true })} className="inline-flex shrink-0 items-center gap-1 font-semibold hover:underline"><RefreshCw className="h-3 w-3" />重试</button>
            </div>
          )}
          <div className="max-h-[min(31rem,calc(100vh-9rem))] overflow-y-auto">
            {loading && !hasLoaded ? (
              <div className="flex items-center justify-center gap-2 px-4 py-10 text-xs text-yx-muted"><Loader2 className="h-4 w-4 animate-spin text-yx-brand" />读取通知中…</div>
            ) : notifications.length ? (
              notifications.map((item) => (
                <button key={item.id} type="button" onClick={() => void markRead({ ids: [item.id] })} className={'flex w-full gap-3 border-b border-yx-line px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-yx-hover ' + (item.read ? 'bg-yx-paper' : 'bg-yx-brand/[0.04]')}>
                  <span className={'mt-1.5 h-2 w-2 shrink-0 rounded-full ' + (item.read ? 'bg-yx-line' : 'bg-yx-brand shadow-[0_0_0_3px_var(--yx-brand-soft)]')} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-start justify-between gap-2">
                      <span className="text-xs font-semibold leading-5 text-yx-ink">{item.summary}</span>
                      <span className="shrink-0 rounded bg-yx-surface px-1.5 py-0.5 text-[9px] font-medium text-yx-muted">{actionLabels[item.action]}</span>
                    </span>
                    {isAdmin && item.detail && <span className="mt-1 block text-[10px] leading-4 text-yx-muted">{item.detail}</span>}
                    <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] text-yx-faint">
                      {item.projectTitle && <span className="max-w-[12rem] truncate">{item.projectTitle}</span>}
                      {item.reportTitle && <span className="max-w-[12rem] truncate">{item.reportTitle}</span>}
                      {isAdmin && item.actorName && <span>操作人：{item.actorName}</span>}
                      <span>{formatNotificationTime(item.createdAt)}</span>
                    </span>
                  </span>
                </button>
              ))
            ) : (
              <div className="px-4 py-11 text-center"><Bell className="mx-auto h-7 w-7 text-yx-brand/50" /><p className="mt-2 text-xs font-semibold text-yx-ink">暂无通知</p><p className="mt-1 text-[10px] leading-4 text-yx-muted">课题创建、报告上传和分析操作会在这里留下动态。</p></div>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-yx-line bg-yx-surface px-4 py-2">
            <span className="text-[9px] text-yx-faint">每 30 秒自动刷新</span>
            {loading && hasLoaded && <Loader2 className="h-3 w-3 animate-spin text-yx-faint" />}
          </div>
        </div>
      )}
    </>
  )
}

function parseNotificationResponse(value: unknown): NotificationResponse | undefined {
  if (!isRecord(value) || !Array.isArray(value.notifications)) return undefined
  const notifications = value.notifications.filter(isNotificationItem)
  return { notifications, total: safeCount(value.total, notifications.length), unreadCount: safeCount(value.unreadCount, 0) }
}

function isNotificationItem(value: unknown): value is NotificationItem {
  return isRecord(value) && typeof value.id === 'string' && typeof value.action === 'string'
    && notificationActionValues.has(value.action as NotificationAction) && typeof value.summary === 'string'
    && typeof value.createdAt === 'string' && typeof value.read === 'boolean'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function safeCount(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function readError(value: unknown, fallback: string) {
  return isRecord(value) && typeof value.error === 'string' && value.error ? value.error : fallback
}

function formatNotificationTime(value: string) {
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return '时间未知'
  const age = Math.max(0, Date.now() - timestamp)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (age < minute) return '刚刚'
  if (age < hour) return Math.floor(age / minute) + ' 分钟前'
  if (age < day) return Math.floor(age / hour) + ' 小时前'
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp)
}

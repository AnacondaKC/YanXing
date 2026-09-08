'use client'

import { ChevronDown, HelpCircle, LogOut, Pencil, Search, Settings, UserRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { NotificationCenter } from '@/components/notification-center'
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '@/components/ui/dialog'
import { Field, FormError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ThemeToggle } from '@/components/theme-toggle'
import { apiFetch, mutationHeaders } from '@/lib/client-request'
import type { SessionUser } from '@/modules/users/domain'

export function TopbarUserNav({
  user,
  onSettings,
  onSettingsIntent,
  onEditProfile,
  onSearch,
  onHelp,
  notificationRefreshKey,
}: {
  user?: SessionUser
  onSettings: () => void
  onSettingsIntent?: () => void
  onEditProfile: () => void
  onSearch?: () => void
  onHelp?: () => void
  notificationRefreshKey?: number
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const userName = user?.displayName || user?.username || '当前用户'
  const avatarDisplay = user?.avatar || (userName.length <= 2 ? userName : userName.slice(-2))

  useEffect(() => {
    if (!menuOpen) return
    function onPointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setMenuOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  async function logout() {
    await apiFetch('/api/auth/logout', { method: 'POST', headers: mutationHeaders() }).catch(() => undefined)
    window.location.assign('/login')
  }

  return (
    <div className="relative flex items-center gap-1 sm:gap-1.5">
      {onSearch ? (
        <Button variant="icon" onClick={onSearch} aria-label="搜索课题 (⌘K)" title="搜索课题 (⌘K)" className="rounded-lg">
          <Search className="h-4 w-4" />
        </Button>
      ) : null}
      {user ? <NotificationCenter user={user} refreshKey={notificationRefreshKey} /> : null}
      {user?.role === 'admin' ? (
        <Button variant="icon" onClick={onSettings} onPointerEnter={onSettingsIntent} onFocus={onSettingsIntent} onPointerDown={onSettingsIntent} aria-label="主要设置" title="主要设置" className="rounded-lg">
          <Settings className="h-4 w-4" />
        </Button>
      ) : null}
      <ThemeToggle />
      <div className="mx-0.5 h-4 w-px bg-black/[0.1] sm:mx-1" />
      <div ref={containerRef} className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          aria-label="账户菜单"
          className={'flex items-center gap-2 rounded-lg py-1 pl-1.5 pr-2 transition-colors focus-visible:outline-2 focus-visible:outline-yx-brand ' + (menuOpen ? 'bg-black/10 text-yx-ink' : 'hover:bg-black/[0.04] text-yx-ink')}
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-yx-brand text-[10px] font-bold text-white shadow-2xs">{avatarDisplay}</span>
          <div className="hidden min-w-0 text-left sm:block">
            <span className="block max-w-[8rem] truncate text-xs font-bold leading-tight text-yx-ink" title={userName}>{userName}</span>
            <span className="block text-[9px] font-medium leading-tight text-yx-muted">{user?.role === 'admin' ? '团队管理员' : '研究员'}</span>
          </div>
          <ChevronDown className={'h-3.5 w-3.5 text-yx-muted transition-transform duration-150 ' + (menuOpen ? 'rotate-180 text-yx-ink' : '')} />
        </button>
        {menuOpen ? (
          <div role="menu" aria-label="用户与设置菜单" className="absolute right-0 top-full z-50 mt-1.5 w-56 origin-top-right rounded-lg border border-yx-line bg-yx-paper p-1.5 shadow-xl ring-1 ring-black/5 animate-in fade-in zoom-in-95 duration-100">
            <div className="flex items-center gap-2.5 rounded-lg border border-yx-line bg-yx-surface px-2.5 py-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-yx-brand text-xs font-bold text-white shadow-2xs">{avatarDisplay}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-bold text-yx-ink" title={userName}>{userName}</span>
                  <span className="shrink-0 rounded border border-yx-line bg-yx-paper px-1 text-[9px] font-medium text-yx-ink">{user?.role === 'admin' ? '管理员' : '研究员'}</span>
                </div>
                <span className="block truncate font-mono text-[10px] text-yx-muted">@{user?.username || 'user'}</span>
              </div>
            </div>
            <div className="my-1 border-t border-yx-line" />
            <div className="space-y-0.5">
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onEditProfile() }} className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-xs text-yx-ink transition-colors hover:bg-yx-hover">
                <Pencil className="h-3.5 w-3.5 text-yx-muted" />
                <span>修改信息</span>
              </button>
              {user?.role === 'admin' ? (
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onSettings() }} className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-xs text-yx-ink transition-colors hover:bg-yx-hover">
                  <Settings className="h-3.5 w-3.5 text-yx-muted" />
                  <span>主要设置</span>
                </button>
              ) : null}
              {onHelp ? (
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onHelp() }} className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-xs text-yx-ink transition-colors hover:bg-yx-hover">
                  <HelpCircle className="h-3.5 w-3.5 text-yx-muted" />
                  <span>使用指南与快捷提示</span>
                </button>
              ) : null}
              <div className="my-1 border-t border-yx-line" />
              <button type="button" role="menuitem" onClick={logout} className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-xs font-medium text-yx-danger-text transition-colors hover:bg-yx-danger-soft">
                <LogOut className="h-3.5 w-3.5" />
                <span>退出登录</span>
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function EditProfileDialog({
  user,
  onClose,
  onUpdated,
}: {
  user: SessionUser
  onClose: () => void
  onUpdated: (user: SessionUser) => void
}) {
  const nameRef = useRef<HTMLInputElement>(null)
  const [displayName, setDisplayName] = useState(user.displayName)
  const [avatar, setAvatar] = useState(user.avatar ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const avatarPresets = ['👤', '🎓', '🦉', '🎯', '🚀', '💡', '📊', '🔬', '⚡', '🎨', '🌟', '☕']
  const defaultInitial = displayName.trim().slice(-2) || user.username.slice(-2)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    const normalizedName = displayName.trim()
    if (!normalizedName) {
      setError('请填写显示名称。')
      nameRef.current?.focus()
      return
    }
    if (normalizedName.length > 80) {
      setError('显示名称不能超过 80 个字符。')
      nameRef.current?.focus()
      return
    }
    setSaving(true)
    setError('')
    const response = await apiFetch('/api/auth/me', {
      method: 'PATCH',
      headers: mutationHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ displayName: normalizedName, avatar: avatar.trim() || '' }),
    }).catch(() => null)
    const body = (await response?.json().catch(() => null)) as { user?: SessionUser; error?: string } | null
    if (!response?.ok || !body?.user) {
      setError(body?.error ?? '更新失败。')
      setSaving(false)
      return
    }
    onUpdated(body.user)
    onClose()
  }

  return (
    <Dialog onClose={onClose} labelledBy="edit-profile-title" initialFocusRef={nameRef}>
      <form onSubmit={submit}>
        <DialogHeader
          title="修改信息"
          description="维护您的个性化头像标识与显示名称。"
          titleId="edit-profile-title"
          icon={UserRound}
          onClose={onClose}
        />
        <DialogBody className="space-y-4 py-4">
          <div className="rounded-lg border border-yx-line bg-yx-surface p-3.5">
            <span className="mb-2 block text-xs font-semibold text-yx-ink">头像设置</span>
            <div className="flex items-center gap-3.5">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-yx-brand text-base font-bold text-white shadow-xs">
                {avatar || defaultInitial}
              </span>
              <div className="min-w-0 flex-1">
                <Input maxLength={10} value={avatar} onChange={(event) => setAvatar(event.target.value)} placeholder="输入文字、字母或 Emoji 作为头像..." />
                {avatar ? (
                  <button type="button" onClick={() => setAvatar('')} className="mt-1 text-[10px] text-yx-muted underline hover:text-yx-ink">
                    恢复默认文字头像（{defaultInitial}）
                  </button>
                ) : null}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-yx-line pt-2.5">
              <span className="mr-1 text-[10px] text-yx-muted">快捷预设:</span>
              {avatarPresets.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setAvatar(preset)}
                  className={'flex h-7 w-7 items-center justify-center rounded-md border text-sm transition-all ' + (avatar === preset ? 'border-yx-brand bg-yx-brand/10 text-yx-brand-hover shadow-2xs' : 'border-yx-line bg-yx-paper hover:bg-yx-hover')}
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>
          <Field label="显示名称" htmlFor="edit-profile-display-name" required>
            <Input
              ref={nameRef}
              id="edit-profile-display-name"
              required
              maxLength={80}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="请输入显示名称"
            />
          </Field>
          <div className="grid grid-cols-2 gap-2.5 text-[10px]">
            <div className="rounded-md border border-yx-line bg-yx-surface p-2.5">
              <span className="block font-medium text-yx-muted">账号用户名</span>
              <span className="mt-0.5 block font-mono font-semibold text-yx-ink">@{user.username}</span>
            </div>
            <div className="rounded-md border border-yx-line bg-yx-surface p-2.5">
              <span className="block font-medium text-yx-muted">权限角色</span>
              <span className="mt-0.5 block font-semibold text-yx-ink">{user.role === 'admin' ? '团队管理员' : '研究人员'}</span>
            </div>
          </div>
          {error ? <FormError>{error}</FormError> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button type="submit" loading={saving}>保存修改</Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}

export function HelpTipsDialog({ onClose }: { onClose: () => void }) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog onClose={onClose} labelledBy="help-dialog-title" size="lg" initialFocusRef={closeButtonRef}>
      <DialogHeader
        title="使用指南与快捷提示"
        description="研行 · 产业政策研究与智能分析工作台。"
        titleId="help-dialog-title"
        icon={HelpCircle}
        onClose={onClose}
        closeRef={closeButtonRef}
        closeLabel="关闭提示"
      />
      <DialogBody className="space-y-3 text-xs text-yx-muted">
        <div className="rounded-lg border border-yx-line bg-yx-surface p-3">
          <h3 className="mb-1.5 flex items-center gap-1.5 font-semibold text-yx-ink">
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-yx-brand text-[10px] font-bold text-white">1</span>
            快捷操作键
          </h3>
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="flex items-center justify-between rounded border border-yx-line bg-yx-paper px-2 py-1.5">
              <span>全局搜索课题</span>
              <kbd className="rounded border border-yx-line bg-yx-surface px-1.5 py-0.5 font-mono text-[10px] font-semibold text-yx-ink">⌘K / Ctrl+K</kbd>
            </div>
            <div className="flex items-center justify-between rounded border border-yx-line bg-yx-paper px-2 py-1.5">
              <span>关闭当前弹窗</span>
              <kbd className="rounded border border-yx-line bg-yx-surface px-1.5 py-0.5 font-mono text-[10px] font-semibold text-yx-ink">Esc</kbd>
            </div>
          </div>
        </div>
        <div className="rounded-lg border border-yx-line bg-yx-surface p-3">
          <h3 className="mb-1.5 flex items-center gap-1.5 font-semibold text-yx-ink">
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-yx-brand text-[10px] font-bold text-white">2</span>
            研究与分析流程
          </h3>
          <ul className="list-inside list-disc space-y-1 text-[11px] text-yx-muted">
            <li><b>创建课题</b>：在左侧栏点击「新建课题」并指定课题负责人与研究方向。</li>
            <li><b>上传分析</b>：支持上传 DOCX / PDF 报告文件，系统将自动触发多阶段流水线分析。</li>
            <li><b>多维洞察</b>：集中查看事实萃取、质量评分、决策建议、可视化词云与思维导图。</li>
          </ul>
        </div>
        <div className="rounded-lg border border-yx-line bg-yx-surface p-3">
          <h3 className="mb-1.5 flex items-center gap-1.5 font-semibold text-yx-ink">
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-yx-brand text-[10px] font-bold text-white">3</span>
            系统设置与个性化
          </h3>
          <ul className="list-inside list-disc space-y-1 text-[11px] text-yx-muted">
            <li><b>模型渠道</b>：管理员可在右上角「主要设置」中配置 Chat Completions 渠道、思考强度与上下文限制。</li>
            <li><b>个人资料</b>：点击右上角用户头像展开菜单，可修改您的专属头像标识与显示名称。</li>
          </ul>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>知道了</Button>
      </DialogFooter>
    </Dialog>
  )
}

'use client'

import { AlertCircle, Loader2, Pencil, Search, Trash2, UserPlus, Users } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconBadge } from '@/components/ui/icon-badge'
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '@/components/ui/dialog'
import { Field, FormError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { CustomSelect } from '@/components/ui/select'
import { apiFetch, fetchAllPages, mutationHeaders } from '@/lib/client-request'
import type { ManagedUser, SessionUser } from '@/modules/users/domain'

export function UserManagementSettings({
  currentUser,
  onNotice,
  onUsersCountChange,
}: {
  currentUser?: SessionUser
  onNotice: (message: string) => void
  onUsersCountChange?: (count: number) => void
}) {
  const [users, setUsers] = useState<ManagedUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editingUser, setEditingUser] = useState<ManagedUser | null | undefined>(undefined)
  const [deletingUserId, setDeletingUserId] = useState<string | undefined>(undefined)
  const [searchQuery, setSearchQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState<'all' | 'admin' | 'researcher' | 'disabled'>('all')
  const loadSequenceRef = useRef(0)
  const loadControllerRef = useRef<AbortController | undefined>(undefined)
  const onUsersCountChangeRef = useRef(onUsersCountChange)
  onUsersCountChangeRef.current = onUsersCountChange

  const reload = useCallback(async () => {
    const requestSequence = ++loadSequenceRef.current
    loadControllerRef.current?.abort()
    const controller = new AbortController()
    loadControllerRef.current = controller
    setLoading(true)
    try {
      const result = await fetchAllPages<ManagedUser>('/api/admin/users', 'users', { cache: 'no-store', signal: controller.signal })
      if (controller.signal.aborted || requestSequence !== loadSequenceRef.current) return
      setUsers(result.items)
      onUsersCountChangeRef.current?.(result.total)
      setError('')
    } catch (reason) {
      if (controller.signal.aborted || requestSequence !== loadSequenceRef.current) return
      setError(reason instanceof Error ? reason.message : '用户列表读取失败。')
    } finally {
      if (loadControllerRef.current === controller) loadControllerRef.current = undefined
      if (!controller.signal.aborted && requestSequence === loadSequenceRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
    return () => {
      loadSequenceRef.current += 1
      loadControllerRef.current?.abort()
    }
  }, [reload])

  function handleSaved(user: ManagedUser, created: boolean) {
    setUsers((current) => {
      const nextUsers = created
        ? [user, ...current.filter((item) => item.id !== user.id)]
        : current.map((item) => (item.id === user.id ? user : item))
      onUsersCountChangeRef.current?.(nextUsers.length)
      return nextUsers
    })
    setEditingUser(undefined)
    onNotice(created ? '用户已创建。' : '用户信息已更新。')
    void reload()
  }

  async function handleDelete(user: ManagedUser) {
    if (deletingUserId || user.id === currentUser?.id) return
    const confirmed = window.confirm(`确定删除用户“${user.displayName}（@${user.username}）”吗？该操作不可恢复。`)
    if (!confirmed) return

    setDeletingUserId(user.id)
    setError('')
    try {
      const response = await apiFetch(`/api/admin/users/${user.id}`, {
        method: 'DELETE',
        headers: mutationHeaders(),
      }).catch(() => null)
      const body = (await response?.json().catch(() => null)) as { error?: string } | null
      if (!response?.ok) {
        setError(body?.error ?? '用户删除失败。')
        return
      }

      const nextUsers = users.filter((item) => item.id !== user.id)
      setUsers(nextUsers)
      onUsersCountChange?.(nextUsers.length)
      onNotice(`已删除用户“${user.displayName}”。`)
    } finally {
      setDeletingUserId(undefined)
    }
  }

  const filteredUsers = useMemo(() => {
    return users.filter((u) => {
      if (roleFilter === 'admin' && u.role !== 'admin') return false
      if (roleFilter === 'researcher' && u.role !== 'researcher') return false
      if (roleFilter === 'disabled' && u.status !== 'disabled') return false
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase()
        return u.displayName.toLowerCase().includes(q) || u.username.toLowerCase().includes(q)
      }
      return true
    })
  }, [users, roleFilter, searchQuery])

  const stats = useMemo(() => {
    const admins = users.filter((u) => u.role === 'admin').length
    const researchers = users.filter((u) => u.role === 'researcher').length
    const active = users.filter((u) => u.status === 'active').length
    return { total: users.length, admins, researchers, active }
  }, [users])
  const activeAdminCount = useMemo(() => users.filter((user) => user.role === 'admin' && user.status === 'active').length, [users])

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col pb-2">
      {/* Header */}
      <header className="shrink-0 border-b border-yx-line pb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <IconBadge icon={Users} size="lg" />
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold tracking-tight text-yx-ink">用户管理</h1>
                <span className="rounded-md border border-yx-line bg-yx-surface px-2 py-0.5 font-mono text-xs font-medium text-yx-muted">
                  {users.length} 个账号
                </span>
              </div>
              <p className="mt-0.5 text-xs text-yx-muted">查看全员账号状态、分配管理员与研究员角色，或重置访问凭据。</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setEditingUser(null)}
            className="flex h-8 items-center gap-1.5 rounded-md bg-yx-brand px-3.5 text-xs font-medium text-white shadow-xs transition-colors duration-150 hover:bg-yx-brand-hover"
          >
            <UserPlus className="h-3.5 w-3.5 text-white" />
            <span>新增用户</span>
          </button>
        </div>

        {/* Refined Metric Ribbon */}
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-lg border border-yx-line bg-yx-surface p-3">
            <p className="text-[10px] font-medium text-yx-muted">总账号数</p>
            <p className="mt-0.5 font-mono text-base font-bold text-yx-ink">{stats.total}</p>
          </div>
          <div className="rounded-lg border border-yx-line bg-yx-surface p-3">
            <p className="text-[10px] font-medium text-yx-muted">管理员</p>
            <p className="mt-0.5 font-mono text-base font-bold text-yx-ink">{stats.admins}</p>
          </div>
          <div className="rounded-lg border border-yx-line bg-yx-surface p-3">
            <p className="text-[10px] font-medium text-yx-muted">研究员</p>
            <p className="mt-0.5 font-mono text-base font-bold text-yx-ink">{stats.researchers}</p>
          </div>
          <div className="rounded-lg border border-yx-line bg-yx-surface p-3">
            <p className="text-[10px] font-medium text-yx-muted">正常启用</p>
            <p className="mt-0.5 font-mono text-base font-bold text-yx-ink">{stats.active}</p>
          </div>
        </div>
      </header>

      {/* Toolbar: Search + Role Tabs */}
      <div className="mt-4 flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[12rem] max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索用户名或显示名称..."
            className="w-full pl-8 pr-3 py-2 bg-yx-paper border border-gray-200 rounded-md text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-yx-brand focus:border-transparent transition-all"
          />
        </div>
        <div className="flex rounded-md border border-yx-line bg-yx-surface p-0.5 text-xs">
          {[
            { id: 'all', label: '全部' },
            { id: 'admin', label: '管理员' },
            { id: 'researcher', label: '研究员' },
            { id: 'disabled', label: '已停用' },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setRoleFilter(tab.id as typeof roleFilter)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-all duration-150 ${
                roleFilter === tab.id
                  ? 'bg-yx-paper font-semibold text-yx-ink shadow-2xs'
                  : 'text-yx-muted hover:text-yx-ink'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div role="alert" className="mt-4 flex shrink-0 items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-yx-brand" />
        </div>
      ) : filteredUsers.length > 0 ? (
        <div className="yx-subtle-scrollbar mt-4 min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pr-1">
          {filteredUsers.map((user) => {
            const isCurrentUser = user.id === currentUser?.id
            const isLastActiveAdmin = user.role === 'admin' && user.status === 'active' && activeAdminCount <= 1
            const deleteDisabled = isCurrentUser || isLastActiveAdmin || deletingUserId !== undefined
            const deleteTitle = isCurrentUser
              ? '不能删除当前登录账号'
              : isLastActiveAdmin
                ? '至少需要保留一名启用的管理员'
                : '删除用户'

            return (
              <UserManagementRow
                key={user.id}
                user={user}
                onEdit={() => setEditingUser(user)}
                onDelete={() => void handleDelete(user)}
                deleting={deletingUserId === user.id}
                deleteDisabled={deleteDisabled}
                deleteTitle={deleteTitle}
              />
            )
          })}
        </div>
      ) : (
        <div className="mt-4 flex min-h-0 flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-yx-line bg-yx-surface px-4 py-12 text-center">
          <Users className="mx-auto h-7 w-7 text-yx-brand" />
          <p className="mt-2 text-xs font-medium text-yx-ink">
            {searchQuery || roleFilter !== 'all' ? '未找到符合条件的用户' : '暂无用户'}
          </p>
          <p className="mt-0.5 text-[10px] text-yx-muted">
            {searchQuery || roleFilter !== 'all' ? '请尝试更换搜索词或筛选条件' : '点击上方「新增用户」创建系统账号'}
          </p>
        </div>
      )}

      {editingUser !== undefined && (
        <UserEditorDialog
          user={editingUser ?? undefined}
          onClose={() => setEditingUser(undefined)}
          onSaved={handleSaved}
        />
      )}
    </div>
  )
}

function UserManagementRow({
  user,
  onEdit,
  onDelete,
  deleting,
  deleteDisabled,
  deleteTitle,
}: {
  user: ManagedUser
  onEdit: () => void
  onDelete: () => void
  deleting: boolean
  deleteDisabled: boolean
  deleteTitle: string
}) {
  const roleLabel = user.role === 'admin' ? '管理员' : '研究员'
  const lastLogin = user.lastLoginAt ? user.lastLoginAt.slice(0, 16).replace('T', ' ') : '从未登录'
  const avatarText = user.displayName.length <= 2 ? user.displayName : user.displayName.slice(-2)

  return (
    <div className="group relative flex flex-wrap items-center gap-3 rounded-lg border border-yx-line bg-yx-surface p-3.5 transition-all duration-150 hover:border-yx-brand hover:bg-yx-hover hover:shadow-xs">
      {/* Drag handle */}
      <div className="flex-none select-none pl-0.5 text-xs leading-none text-yx-faint transition-colors duration-150 group-hover:text-yx-muted cursor-grab">
        ⋮⋮
      </div>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-yx-brand font-mono text-xs font-bold text-white shadow-2xs">
        {avatarText}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-xs font-semibold text-yx-ink" title={user.displayName}>
            {user.displayName}
          </span>
          <span className="rounded border border-yx-line bg-yx-paper px-1.5 py-0.2 text-[10px] font-medium text-yx-ink">
            {roleLabel}
          </span>
          <span
            className={`rounded px-1.5 py-0.2 text-[10px] font-medium border ${
              user.status === 'active'
                ? 'border-yx-brand/30 bg-yx-brand/10 text-yx-brand-hover'
                : 'border-yx-line bg-yx-paper text-yx-muted'
            }`}
          >
            {user.status === 'active' ? '启用' : '已停用'}
          </span>
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] text-yx-muted">
          <span className="truncate" title={user.username}>
            @{user.username}
          </span>
          <span className="shrink-0 text-yx-faint">·</span>
          <span>最近登录：{lastLogin}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onEdit}
          disabled={deleting}
          aria-label={`编辑用户：${user.displayName}`}
          title="编辑用户"
          className="flex h-7 items-center gap-1.5 rounded-md border border-yx-line bg-yx-paper px-2.5 text-xs font-medium text-yx-ink shadow-2xs transition-all duration-150 hover:border-yx-brand hover:bg-yx-hover hover:text-yx-ink disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Pencil className="h-3 w-3 text-yx-muted" />
          <span>修改</span>
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={deleteDisabled}
          aria-label={deleting ? `正在删除用户：${user.displayName}` : `删除用户：${user.displayName}`}
          title={deleting ? '正在删除用户' : deleteTitle}
          className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-yx-muted transition-colors duration-150 hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          <span>{deleting ? '删除中' : '删除'}</span>
        </button>
      </div>
    </div>
  )
}

function UserEditorDialog({
  user,
  onClose,
  onSaved,
}: {
  user?: ManagedUser
  onClose: () => void
  onSaved: (user: ManagedUser, created: boolean) => void
}) {
  const usernameRef = useRef<HTMLInputElement>(null)
  const isEditing = Boolean(user)
  const [username, setUsername] = useState(user?.username ?? '')
  const [displayName, setDisplayName] = useState(user?.displayName ?? '')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<SessionUser['role']>(user?.role ?? 'researcher')
  const [status, setStatus] = useState<ManagedUser['status']>(user?.status ?? 'active')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (loading) return
    const normalizedUsername = username.trim()
    const normalizedDisplayName = displayName.trim()
    if (!normalizedUsername || !normalizedDisplayName) {
      setError('请填写用户名和显示名称。')
      usernameRef.current?.focus()
      return
    }
    if (!isEditing && !password) {
      setError('请设置初始密码。')
      return
    }

    setLoading(true)
    setError('')
    const response = await apiFetch(user ? `/api/admin/users/${user.id}` : '/api/admin/users', {
      method: user ? 'PATCH' : 'POST',
      headers: mutationHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        username: normalizedUsername,
        displayName: normalizedDisplayName,
        password: password || undefined,
        role,
        ...(user ? { status, updatedAt: user.updatedAt } : {}),
      }),
    }).catch(() => null)
    const body = (await response?.json().catch(() => null)) as { user?: ManagedUser; error?: string } | null
    if (!response?.ok || !body?.user) {
      setError(body?.error ?? '用户保存失败。')
      setLoading(false)
      return
    }
    onSaved(body.user, !user)
  }

  return (
    <Dialog onClose={onClose} labelledBy="user-editor-title" zIndex={70} initialFocusRef={usernameRef}>
        <form onSubmit={submit}>
          <DialogHeader
            title={isEditing ? '编辑用户' : '新增用户'}
            description="维护账号身份与角色权限。"
            titleId="user-editor-title"
            icon={Users}
            onClose={onClose}
            closeLabel="关闭用户编辑"
          />
          <DialogBody className="space-y-3 py-4">
          <Field label="用户名" htmlFor="managed-user-username" required>
            <Input
              ref={usernameRef}
              id="managed-user-username"
              required
              maxLength={32}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              placeholder="例如：wangzheng"
            />
          </Field>
          <Field label="显示名称" htmlFor="managed-user-display-name" required>
            <Input
              id="managed-user-display-name"
              required
              maxLength={80}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="例如：王政"
            />
          </Field>
          <Field label={isEditing ? '重置密码' : '初始密码'} htmlFor="managed-user-password" required={!isEditing}>
            <Input
              id="managed-user-password"
              type="password"
              minLength={12}
              maxLength={128}
              required={!isEditing}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              placeholder={isEditing ? '留空则保持原密码不变' : '至少 12 位，需包含字母和数字'}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="text-xs font-semibold text-yx-ink">
              <span>权限组</span>
              <CustomSelect
                id="managed-user-role"
                ariaLabel="权限组"
                value={role}
                onChange={(value) => setRole(value as SessionUser['role'])}
                options={[
                  { value: 'researcher', label: '研究员', description: '普通业务账号' },
                  { value: 'admin', label: '管理员', description: '全局管理权限' },
                ]}
                className="mt-1.5"
              />
            </div>
            {isEditing && (
              <div className="text-xs font-semibold text-yx-ink">
                <span>账号状态</span>
                <CustomSelect
                  id="managed-user-status"
                  ariaLabel="账号状态"
                  value={status}
                  onChange={(value) => setStatus(value as ManagedUser['status'])}
                  options={[
                    { value: 'active', label: '启用', description: '允许登录和使用系统' },
                    { value: 'disabled', label: '停用', description: '禁止登录，保留历史数据' },
                  ]}
                  className="mt-1.5"
                />
              </div>
            )}
          </div>

          {error ? <FormError>{error}</FormError> : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>取消</Button>
            <Button type="submit" loading={loading}>{isEditing ? '保存更改' : '创建用户'}</Button>
          </DialogFooter>
        </form>
    </Dialog>
  )
}

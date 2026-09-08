'use client'

import { Eye, EyeOff, FolderKanban, Loader2, Pencil, Search, Sparkles, Trash2, UserPlus, Users, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconBadge } from '@/components/ui/icon-badge'
import { Dialog, DialogHeader } from '@/components/ui/dialog'
import { FormError } from '@/components/ui/field'
import { apiFetch, fetchAllPages, mutationHeaders } from '@/lib/client-request'
import type { ProjectWithCapabilities } from '@/modules/projects/domain'
import type { ManagedUser } from '@/modules/users/domain'

type ManagedProjectRole = 'owner' | 'editor'
type ManagedProjectMember = { userId: string; username: string; displayName: string; role: ManagedProjectRole; status: 'active' | 'disabled' }

const projectRoleSegments: Array<{ value: ManagedProjectRole; label: string; title: string }> = [
  { value: 'owner', label: '负责人', title: '可管理并删除课题；每个课题仅一名负责人' },
  { value: 'editor', label: '协作者', title: '可编辑课题和处理报告，每个课题最多 3 名' },
]

export function ProjectManagementSettings({
  projects,
  hiddenProjectIds = [],
  onToggleHideProject,
  onEditProject,
  onDeleteProject,
  onMembersChanged,
}: {
  projects: ProjectWithCapabilities[]
  hiddenProjectIds?: string[]
  onToggleHideProject?: (projectId: string) => void
  onEditProject?: (project: ProjectWithCapabilities) => void
  onDeleteProject: (project: ProjectWithCapabilities) => void
  onMembersChanged: () => void
}) {
  const [memberTarget, setMemberTarget] = useState<ProjectWithCapabilities>()
  const [searchQuery, setSearchQuery] = useState('')

  const filteredProjects = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return projects
    return projects.filter(
      (project) =>
        project.title.toLowerCase().includes(query) ||
        project.ownerName.toLowerCase().includes(query)
    )
  }, [projects, searchQuery])

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col">
      {/* Header */}
      <header className="shrink-0 border-b border-yx-line pb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <IconBadge icon={FolderKanban} size="lg" />
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold tracking-tight text-yx-ink">课题管理</h1>
                <span className="rounded-md border border-yx-line bg-yx-surface px-2 py-0.5 font-mono text-xs font-medium text-yx-muted">
                  {projects.length} 个课题
                </span>
              </div>
              <p className="mt-0.5 text-xs text-yx-muted">
                集中管理系统中所有研究课题信息、权限组与课题生命周期（管理员拥有全部课题修改与删除权限）。
              </p>
            </div>
          </div>
        </div>
      </header>

      {/* Toolbar */}
      <div className="mt-4 flex shrink-0 items-center justify-between gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索课题名称或负责人..."
            className="w-full pl-8 pr-3 py-2 bg-yx-paper border border-gray-200 rounded-md text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-yx-brand focus:border-transparent transition-all"
          />
        </div>
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery('')}
            className="text-xs font-medium text-yx-muted transition-colors hover:text-yx-ink"
          >
            清除筛选
          </button>
        )}
      </div>

      {/* Project List */}
      {filteredProjects.length > 0 ? (
        <div className="yx-subtle-scrollbar mt-4 min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pr-1">
          {filteredProjects.map((project) => {
            const isHidden = hiddenProjectIds.includes(project.id)

            return (
              <div
                key={project.id}
                className={`group relative flex items-center gap-3 rounded-lg border p-3.5 transition-all duration-150 ${
                  isHidden
                    ? 'border-dashed border-yx-line bg-yx-surface opacity-80 hover:opacity-100 hover:border-yx-brand'
                    : 'border-yx-line bg-yx-surface hover:border-yx-brand hover:bg-yx-hover hover:shadow-xs'
                }`}
              >
                {/* Drag Handle */}
                <div className="flex-none select-none pl-0.5 text-xs leading-none text-yx-faint transition-colors duration-150 group-hover:text-yx-muted cursor-grab">
                  ⋮⋮
                </div>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-yx-brand text-white shadow-2xs">
                  <FolderKanban className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-xs font-semibold text-yx-ink" title={project.title}>
                      {project.title}
                    </p>
                    {project.isExample && (
                      <span className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700 border border-amber-200">
                        示例课题
                      </span>
                    )}
                    <span className="shrink-0 rounded bg-yx-brand/10 px-1.5 py-0.5 text-[9px] font-bold text-yx-brand-hover border border-yx-brand/20">
                      全部权限
                    </span>
                    {isHidden && (
                      <span className="shrink-0 rounded bg-gray-200/80 px-1.5 py-0.5 text-[9px] font-medium text-yx-muted">
                        已隐藏
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-yx-muted">
                    <span className="truncate" title={project.ownerName}>
                      负责人：{project.ownerName}
                    </span>
                    {project.collaboratorNames && (
                      <>
                        <span className="shrink-0 text-yx-faint">·</span>
                        <span className="truncate" title={project.collaboratorNames}>
                          协作者：{project.collaboratorNames}
                        </span>
                      </>
                    )}
                    <span className="shrink-0 text-yx-faint">·</span>
                    <span className="shrink-0 font-mono tabular-nums">更新于 {project.updatedAt.slice(0, 10)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {/* 修改课题按钮：所有人与管理员均可修改 */}
                  {onEditProject && project.canManage && (
                    <button
                      type="button"
                      onClick={() => onEditProject(project)}
                      aria-label={`修改课题：${project.title}`}
                      title="修改课题信息、目标与阶段"
                      className="flex h-7 items-center gap-1 rounded-md border border-yx-line bg-yx-paper px-2.5 text-xs font-medium text-yx-ink shadow-2xs transition-all duration-150 hover:border-yx-brand hover:bg-yx-hover"
                    >
                      <Pencil className="h-3 w-3 text-yx-muted" />
                      <span>修改</span>
                    </button>
                  )}

                  {/* 权限组管理按钮 */}
                  <button
                    type="button"
                    onClick={() => setMemberTarget(project)}
                    aria-label={`编辑课题权限组：${project.title}`}
                    title="权限组与成员管理"
                    className="flex h-7 items-center gap-1 rounded-md border border-yx-line bg-yx-paper px-2.5 text-xs font-medium text-yx-ink shadow-2xs transition-all duration-150 hover:border-yx-brand hover:bg-yx-hover"
                  >
                    <Users className="h-3 w-3 text-yx-muted" />
                    <span>权限组</span>
                  </button>

                  {project.isExample ? (
                    onToggleHideProject && (
                      <button
                        type="button"
                        onClick={() => onToggleHideProject(project.id)}
                        aria-label={isHidden ? `取消隐藏示例课题：${project.title}` : `隐藏示例课题：${project.title}`}
                        title={isHidden ? '显示示例课题' : '隐藏示例课题'}
                        className={`flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs font-medium transition-all duration-150 ${
                          isHidden
                            ? 'border-yx-brand bg-yx-brand/10 text-yx-brand-hover hover:bg-yx-brand/20'
                            : 'border-yx-line bg-yx-paper text-yx-muted hover:border-amber-300 hover:text-amber-800 hover:bg-amber-50'
                        }`}
                      >
                        {isHidden ? <Eye className="h-3.5 w-3.5 text-yx-brand" /> : <EyeOff className="h-3.5 w-3.5 text-yx-muted" />}
                        <span>{isHidden ? '显示' : '隐藏'}</span>
                      </button>
                    )
                  ) : project.canDelete ? (
                    <button
                      type="button"
                      onClick={() => onDeleteProject(project)}
                      aria-label={`删除课题：${project.title}`}
                      title="删除课题"
                      className="flex h-7 w-7 items-center justify-center rounded-md text-yx-faint transition-colors duration-150 hover:bg-rose-50 hover:text-rose-600"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-dashed border-yx-line bg-yx-surface px-4 py-12 text-center">
          <FolderKanban className="mx-auto h-7 w-7 text-yx-brand" />
          <p className="mt-2 text-xs font-medium text-yx-ink">
            {searchQuery ? '没有找到匹配的课题' : '暂无课题'}
          </p>
          <p className="mt-0.5 text-[10px] text-yx-muted">
            {searchQuery ? '请尝试使用其他关键词搜索' : '新创建的课题会显示在此列表中'}
          </p>
        </div>
      )}

      {memberTarget && (
        <ProjectMembersDialog
          project={memberTarget}
          onClose={() => setMemberTarget(undefined)}
          onSaved={() => {
            setMemberTarget(undefined)
            onMembersChanged()
          }}
        />
      )}
    </div>
  )
}

export function ProjectMembersDialog({
  project,
  onClose,
  onSaved,
}: {
  project: ProjectWithCapabilities
  onClose: () => void
  onSaved: () => void
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [users, setUsers] = useState<ManagedUser[]>([])
  const [roles, setRoles] = useState<Record<string, ManagedProjectRole>>({})
  const [membershipRevision, setMembershipRevision] = useState<number>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [searchMember, setSearchMember] = useState('')

  const memberCount = Object.keys(roles).length
  const ownerCount = Object.values(roles).filter((role) => role === 'owner').length
  const editorCount = memberCount - ownerCount
  const soleOwnerId = ownerCount === 1 ? Object.entries(roles).find(([, role]) => role === 'owner')?.[0] : undefined

  const sortedUsers = useMemo(() => {
    const roleOrder: Record<ManagedProjectRole, number> = { owner: 0, editor: 1 }
    let list = [...users]
    if (searchMember.trim()) {
      const q = searchMember.trim().toLowerCase()
      list = list.filter((u) => u.displayName.toLowerCase().includes(q) || u.username.toLowerCase().includes(q))
    }
    return list.sort((left, right) => {
      const leftRole = roles[left.id]
      const rightRole = roles[right.id]
      const leftGroup = leftRole === undefined ? 3 : roleOrder[leftRole]
      const rightGroup = rightRole === undefined ? 3 : roleOrder[rightRole]
      if (leftGroup !== rightGroup) return leftGroup - rightGroup
      return left.displayName.localeCompare(right.displayName, 'zh-CN')
    })
  }, [roles, users, searchMember])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const [membersResponse, usersResult] = await Promise.all([
        apiFetch(`/api/admin/projects/${project.id}/members`, { cache: 'no-store' }).catch(() => null),
        fetchAllPages<ManagedUser>('/api/admin/users', 'users', { cache: 'no-store' }).catch(() => null),
      ])
      const membersBody = (await membersResponse?.json().catch(() => null)) as { members?: ManagedProjectMember[]; revision?: unknown; error?: string } | null
      if (cancelled) return
      if (!membersResponse?.ok || !membersBody?.members || !Number.isSafeInteger(membersBody.revision) || !usersResult) {
        setError(membersBody?.error ?? '课题权限读取失败。')
        setLoading(false)
        return
      }
      setRoles(Object.fromEntries(membersBody.members.map((member) => [member.userId, member.role])))
      setMembershipRevision(Number(membersBody.revision))
      setUsers(usersResult.items)
      setLoading(false)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [project.id])

  function setRole(userId: string, role: ManagedProjectRole | undefined) {
    setRoles((current) => {
      const next = { ...current }
      if (role === undefined) delete next[userId]
      else next[userId] = role
      return next
    })
  }

  async function saveMembers() {
    if (ownerCount !== 1) {
      setError('课题必须有且仅有一名负责人。')
      return
    }
    if (memberCount - 1 > 3) {
      setError('课题协作者不能超过 3 人。')
      return
    }
    if (membershipRevision === undefined) {
      setError('成员版本已失效，请刷新后重试。')
      return
    }
    setSaving(true)
    setError('')
    const response = await apiFetch(`/api/admin/projects/${project.id}/members`, {
      method: 'PUT',
      headers: mutationHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ revision: membershipRevision, members: Object.entries(roles).map(([userId, role]) => ({ userId, role })) }),
    }).catch(() => null)
    const body = (await response?.json().catch(() => null)) as { revision?: unknown; error?: string } | null
    if (!response?.ok) {
      setError(body?.error ?? '课题权限保存失败。')
      setSaving(false)
      return
    }
    if (body && Number.isSafeInteger(body.revision)) setMembershipRevision(Number(body.revision))
    onSaved()
  }

  return (
    <Dialog
      onClose={onClose}
      labelledBy="project-members-title"
      size="xl"
      zIndex={70}
      initialFocusRef={closeButtonRef}
      panelClassName="flex max-h-[min(90vh,720px)] flex-col"
    >
      <DialogHeader
        title={'课题权限组 · ' + project.title}
        description={'负责人 ' + ownerCount + ' 人 · 协作者 ' + editorCount + '/3 人'}
        titleId="project-members-title"
        icon={Users}
        onClose={onClose}
        closeRef={closeButtonRef}
        closeLabel="关闭课题权限组"
      />
      <div className="flex min-h-0 flex-1 flex-col px-5 pb-5">

        {loading ? (
          <div className="flex min-h-48 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-yx-brand" />
          </div>
        ) : (
          <>
            {/* Callout guide without raw emoji */}
            <div className="mt-3 flex shrink-0 items-start gap-2.5 rounded-lg border border-yx-line bg-yx-surface p-3 text-xs text-yx-ink">
              <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-yx-brand" />
              <span className="text-[11px] leading-relaxed text-yx-muted">
                每个课题仅一名负责人，协作者最多 3 名；未加入账号点击「加入课题」默认以协作者加入。所有研究员都可以查看全部课题，成员身份仅影响编辑权限。
              </span>
            </div>

            {/* Member Search filter */}
            <div className="mt-3 shrink-0">
              <input
                type="text"
                value={searchMember}
                onChange={(e) => setSearchMember(e.target.value)}
                placeholder="搜索成员名称或账号..."
                className="w-full px-3 py-2 bg-yx-paper border border-gray-200 rounded-md text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-yx-brand focus:border-transparent transition-all"
              />
            </div>

            <div className="yx-subtle-scrollbar mt-3 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
              {sortedUsers.map((user) => {
                const role = roles[user.id]
                const isSoleOwner = user.id === soleOwnerId
                const avatarText = user.displayName.length <= 2 ? user.displayName : user.displayName.slice(-2)
                return (
                  <div
                    key={user.id}
                    className="flex items-center gap-3 rounded-lg border border-yx-line bg-yx-surface p-2.5 transition-all duration-150 hover:border-yx-brand hover:bg-yx-hover"
                  >
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[10px] font-bold border font-mono ${
                        role ? 'border-yx-line bg-yx-paper text-yx-ink' : 'border-yx-line bg-yx-surface text-yx-faint'
                      }`}
                    >
                      {avatarText}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <span className="truncate text-xs font-semibold text-yx-ink" title={user.displayName}>
                          {user.displayName}
                        </span>
                        {user.role === 'admin' && (
                          <span className="rounded border border-yx-line bg-yx-paper px-1.5 py-0.2 text-[9px] font-medium text-yx-ink">
                            管理员
                          </span>
                        )}
                        {user.status === 'disabled' && (
                          <span className="rounded border border-yx-line bg-yx-paper px-1.5 py-0.2 text-[9px] font-medium text-yx-muted">
                            已停用
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-[10px] text-yx-muted font-mono">
                        @{user.username}
                        {role ? ` · ${projectRoleSegments.find((s) => s.value === role)?.label}` : ' · 未加入'}
                      </div>
                    </div>

                    {role ? (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <div className="flex rounded-md border border-yx-line bg-yx-paper p-0.5" role="group" aria-label={`${user.displayName}的课题权限`}>
                          {projectRoleSegments.map((segment) => (
                            <button
                              key={segment.value}
                              type="button"
                              title={segment.title}
                              aria-pressed={role === segment.value}
                              disabled={isSoleOwner && segment.value !== 'owner'}
                              onClick={() => setRole(user.id, segment.value)}
                              className={`rounded px-2 py-0.5 text-[10px] font-medium transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
                                role === segment.value
                                  ? 'bg-yx-surface font-semibold text-yx-ink shadow-2xs'
                                  : 'text-yx-muted hover:text-yx-ink'
                              }`}
                            >
                              {segment.label}
                            </button>
                          ))}
                        </div>
                        <button
                          type="button"
                          disabled={isSoleOwner}
                          title={isSoleOwner ? '至少保留一名负责人' : '移出课题'}
                          aria-label={`移出课题：${user.displayName}`}
                          onClick={() => setRole(user.id, undefined)}
                          className="flex h-6 w-6 items-center justify-center rounded text-yx-faint transition-colors duration-150 hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={user.status === 'disabled' || editorCount >= 3}
                        title={user.status === 'disabled' ? '账号已停用' : editorCount >= 3 ? '协作者最多 3 人' : '以协作者身份加入课题'}
                        onClick={() => setRole(user.id, 'editor')}
                        className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-yx-line bg-yx-paper px-2.5 text-[10px] font-medium text-yx-ink shadow-2xs transition-all duration-150 hover:bg-yx-hover hover:text-yx-ink disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <UserPlus className="h-3 w-3 text-yx-muted" />
                        <span>加入课题</span>
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}

        {error ? <FormError className="mt-3 shrink-0">{error}</FormError> : null}
        <div className="mt-4 flex shrink-0 justify-end gap-2 border-t border-yx-line pt-3">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button onClick={saveMembers} disabled={loading || !memberCount} loading={saving}>保存权限</Button>
        </div>
      </div>
    </Dialog>
  )
}

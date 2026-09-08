'use client'

import { Check, FileCode2, FolderKanban, Gauge, Layers3, Network, Palette, Settings, Users, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { AdminModelSettings } from '@/components/admin/model-settings'
import { AiBudgetSettingsPanel } from '@/components/admin/ai-budget-settings'
import { BrandingSettingsPanel } from '@/components/admin/branding-settings'
import { ProjectManagementSettings } from '@/components/admin/project-management-settings'
import { UserManagementSettings } from '@/components/admin/user-management-settings'
import { PromptSettings } from '@/components/prompt-settings'
import { AI_PROMPT_TARGETS } from '@/lib/ai/prompt-defaults'
import { Dialog, DialogCloseButton } from '@/components/ui/dialog'
import { useToast } from '@/components/use-toast'
import { apiFetch } from '@/lib/client-request'
import type { ProjectWithCapabilities } from '@/modules/projects/domain'
import type { ManagedUser, SessionUser } from '@/modules/users/domain'
import { modelSelectionTargets, type AiModelSettings } from '@/components/admin/ai-settings-types'

type AdminSettingsPage = 'projects' | 'users' | 'branding' | 'channels' | 'selections' | 'prompts' | 'budget'
type NavigationItem = { id: AdminSettingsPage; label: string; icon: LucideIcon; tag?: string }
type NavigationGroup = { label: string; items: NavigationItem[] }

export function AdminSettingsDialog({
  currentUser,
  projects,
  onClose,
  onEditProject,
  onDeleteProject,
  onProjectsChanged,
  hiddenProjectIds = [],
  onToggleHideProject,
}: {
  currentUser?: SessionUser
  projects: ProjectWithCapabilities[]
  onClose: () => void
  onEditProject?: (project: ProjectWithCapabilities) => void
  onDeleteProject: (project: ProjectWithCapabilities) => void
  onProjectsChanged: () => void
  hiddenProjectIds?: string[]
  onToggleHideProject?: (projectId: string) => void
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState<AdminSettingsPage>('projects')
  const { notice, showNotice, clearNotice } = useToast()
  const [userCount, setUserCount] = useState<number>()
  const [channelCount, setChannelCount] = useState<number>()
  const userCountGenerationRef = useRef(0)
  const channelCountGenerationRef = useRef(0)

  // Fetch counts for settings tabs on mount
  useEffect(() => {
    const userGeneration = ++userCountGenerationRef.current
    const channelGeneration = ++channelCountGenerationRef.current
    let cancelled = false
    void apiFetch('/api/admin/users', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data: { users?: ManagedUser[]; total?: number }) => {
        if (!cancelled && userGeneration === userCountGenerationRef.current && data?.users) {
          setUserCount(typeof data.total === 'number' ? data.total : data.users.length)
        }
      })
      .catch(() => {})

    void apiFetch('/api/admin/ai-settings', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data: { settings?: AiModelSettings }) => {
        if (!cancelled && channelGeneration === channelCountGenerationRef.current && data?.settings?.channels) {
          setChannelCount(data.settings.channels.length)
        }
      })
      .catch(() => {})

    return () => {
      cancelled = true
      userCountGenerationRef.current += 1
      channelCountGenerationRef.current += 1
    }
  }, [])

  function handleUsersCountChange(count: number) {
    userCountGenerationRef.current += 1
    setUserCount(count)
  }

  function handleChannelsCountChange(count: number) {
    channelCountGenerationRef.current += 1
    setChannelCount(count)
  }

  const navigationGroups: NavigationGroup[] = [
    {
      label: '界面',
      items: [
        { id: 'branding', label: '界面与品牌', icon: Palette },
      ],
    },
    {
      label: '资源与权限',
      items: [
        { id: 'projects', label: '课题管理', icon: FolderKanban, tag: `${projects.length}` },
        { id: 'users', label: '用户管理', icon: Users, tag: userCount !== undefined ? `${userCount}` : undefined },
      ],
    },
    {
      label: 'AI 配置',
      items: [
        { id: 'channels', label: '渠道模型', icon: Network, tag: channelCount !== undefined ? `${channelCount}` : undefined },
        { id: 'selections', label: '模型选择', icon: Layers3, tag: `${modelSelectionTargets.length}` },
        { id: 'prompts', label: '提示词设置', icon: FileCode2, tag: `${AI_PROMPT_TARGETS.length}` },
        { id: 'budget', label: 'AI 使用预算', icon: Gauge },
      ],
    },
  ]

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 })
  }, [page])

  function handleClose() {
    clearNotice()
    onClose()
  }

  return (
    <Dialog
      onClose={handleClose}
      label="主要设置"
      size="5xl"
      initialFocusRef={closeButtonRef}
      className="p-3 sm:p-6"
      panelClassName="flex h-[min(50rem,calc(100vh-1.5rem))] flex-col sm:h-[min(50rem,calc(100vh-3rem))] md:flex-row"
    >
        <DialogCloseButton
          buttonRef={closeButtonRef}
          onClose={handleClose}
          label="关闭设置"
          className="absolute right-3.5 top-3.5 z-20 sm:right-4 sm:top-4"
        />

        {notice && (
          <div
            role="status"
            className="pointer-events-none absolute left-1/2 top-3.5 z-30 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-yx-ink bg-yx-ink px-3.5 py-1.5 text-xs font-medium text-white shadow-lg animate-in fade-in duration-150"
          >
            <Check className="h-3.5 w-3.5 text-emerald-400" />
            <span>{notice}</span>
          </div>
        )}

        <aside className="flex w-full shrink-0 flex-col border-b border-yx-line bg-yx-surface p-3.5 sm:p-4 md:w-56 md:border-b-0 md:border-r md:p-4">
          <div className="flex items-center gap-2.5 px-1 py-1">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-yx-ink shadow-xs">
              <Settings className="h-4 w-4 text-white stroke-[2.2]" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold leading-tight text-yx-ink">主要设置</p>
              <p className="mt-0.5 text-[10px] font-medium text-yx-muted">
                系统管理与模型编排
              </p>
            </div>
          </div>

          <nav aria-label="主要设置导航" className="yx-subtle-scrollbar mt-3 flex min-w-0 gap-1 overflow-x-auto pb-1 md:mt-2 md:block md:overflow-visible">
            {navigationGroups.map((group) => (
              <div key={group.label} className="contents md:mb-4 md:block">
                <span className="hidden px-2 text-[10px] font-semibold uppercase tracking-wider text-yx-muted md:block">{group.label}</span>
                <div className="contents md:mt-1 md:block">
                  {group.items.map((item) => {
                    const selected = page === item.id
                    const Icon = item.icon
                    return (
                      <button
                        key={item.id}
                        type="button"
                        aria-current={selected ? 'page' : undefined}
                        onClick={() => setPage(item.id)}
                        className={`group flex min-h-9 min-w-[9.5rem] shrink-0 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-xs font-medium whitespace-nowrap transition-all duration-150 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-yx-brand md:min-w-0 md:w-full ${
                          selected
                            ? 'bg-yx-brand font-semibold text-white shadow-2xs'
                            : 'text-yx-ink-soft hover:bg-yx-hover hover:text-yx-ink'
                        }`}
                      >
                        <Icon className={`h-4 w-4 shrink-0 transition-colors ${selected ? 'text-white' : 'text-yx-muted group-hover:text-yx-ink'}`} />
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {item.tag !== undefined && (
                          <span
                            className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium transition-colors ${
                              selected
                                ? 'bg-white/20 text-white'
                                : 'bg-yx-line text-yx-muted'
                            }`}
                          >
                            {item.tag}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        <div
          ref={contentRef}
          className={`min-h-0 flex-1 bg-yx-paper p-5 pr-12 sm:p-7 sm:pr-14 md:p-8 md:pr-16 ${
            page === 'projects' || page === 'users' || page === 'channels' || page === 'selections' || page === 'prompts'
              ? 'flex flex-col overflow-hidden'
              : 'yx-subtle-scrollbar overflow-y-auto'
          }`}
        >
          {page === 'projects' ? (
            <ProjectManagementSettings
              projects={projects}
              hiddenProjectIds={hiddenProjectIds}
              onToggleHideProject={onToggleHideProject}
              onEditProject={onEditProject}
              onDeleteProject={onDeleteProject}
              onMembersChanged={onProjectsChanged}
            />
          ) : page === 'users' ? (
            <UserManagementSettings
              currentUser={currentUser}
              onNotice={showNotice}
              onUsersCountChange={handleUsersCountChange}
            />
          ) : page === 'branding' ? (
            <BrandingSettingsPanel onNotice={showNotice} />
          ) : page === 'budget' ? (
            <AiBudgetSettingsPanel onNotice={showNotice} />
          ) : page === 'prompts' ? (
            <PromptSettings onNotice={showNotice} />
          ) : (
            <AdminModelSettings
              page={page}
              onNotice={showNotice}
              onChannelsCountChange={handleChannelsCountChange}
            />
          )}
        </div>
    </Dialog>
  )
}

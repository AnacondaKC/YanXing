'use client'

import { CalendarRange, FolderKanban, NotebookPen, Users } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogCloseButton } from '@/components/ui/dialog'
import { MultiSelect } from '@/components/ui/multi-select'
import { ProjectConfigurationInfo, ProjectConfigurationPlan } from '@/components/project-configuration-fields'
import { configurationDraft, ConfigurationSaveError, ConfigurationSaveSession, fetchConfigurationTeam, type ConfigurationTab } from '@/lib/workspace-project-configuration'
import { fetchWorkspaceProject } from '@/lib/workspace-submission-client'
import type { WorkspaceProjectDetail } from '@/lib/workspace-submission'
import type { SessionUser } from '@/modules/users/domain'

const tabs = [
  { id: 'info', label: '01 课题信息', icon: NotebookPen },
  { id: 'team', label: '02 研究团队', icon: Users },
  { id: 'plan', label: '03 计划与排期', icon: CalendarRange },
] as const

export function WorkspaceProjectEditDialog({ detail, currentUser, onClose, onSaved }: {
  detail: WorkspaceProjectDetail
  currentUser?: SessionUser
  onClose: () => void
  onSaved: (detail: WorkspaceProjectDetail) => void
}) {
  const isAdmin = currentUser?.role === 'admin'
  const [session, setSession] = useState(() => new ConfigurationSaveSession(detail, isAdmin))
  const [draft, setDraft] = useState(() => configurationDraft(detail))
  const [activeTab, setActiveTab] = useState<ConfigurationTab>('info')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [users, setUsers] = useState<SessionUser[]>([])
  const [teamError, setTeamError] = useState('')
  const [teamLoading, setTeamLoading] = useState(isAdmin)
  const [teamAttempt, setTeamAttempt] = useState(0)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const busyRef = useRef(false)
  const ownerDirtyRef = useRef(false)
  const disabled = loading || session.blocked || session.writesComplete

  useEffect(() => {
    if (!isAdmin) return
    const controller = new AbortController()
    fetchConfigurationTeam(detail.project.id, controller.signal).then(({ users: nextUsers, snapshot }) => {
      if (controller.signal.aborted) return
      session.members = snapshot
      const ownerId = snapshot.members.find(member => member.role === 'owner')!.userId
      session.baseline = { ...session.baseline, ownerId }
      setUsers(nextUsers)
      if (!ownerDirtyRef.current) setDraft(current => ({ ...current, ownerId }))
      setTeamError('')
      setTeamLoading(false)
    }).catch(() => {
      if (controller.signal.aborted) return
      setTeamLoading(false)
      setTeamError('团队配置读取失败。可重试；不影响保存课题信息或计划。')
    })
    return () => controller.abort()
  }, [detail.project.id, isAdmin, session, teamAttempt])

  function close() {
    if (!busyRef.current) onClose()
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busyRef.current || session.blocked) return
    busyRef.current = true
    setLoading(true)
    setError('')
    let savedDetail: WorkspaceProjectDetail | undefined
    try { savedDetail = await session.save(draft) }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败，请重试。')
      if (failure instanceof ConfigurationSaveError && failure.tab) setActiveTab(failure.tab)
    } finally {
      busyRef.current = false
      setLoading(false)
    }
    // Parent notification is not part of the write transaction.
    if (savedDetail) onSaved(savedDetail)
  }

  async function reload() {
    if (busyRef.current || !window.confirm('重新载入会丢弃所有未保存草稿，并读取最新配置。确定继续？')) return
    busyRef.current = true
    setLoading(true)
    try {
      const fresh = await fetchWorkspaceProject(detail.project.id)
      ownerDirtyRef.current = false
      setDraft(configurationDraft(fresh))
      setSession(new ConfigurationSaveSession(fresh, isAdmin))
      setUsers([])
      setTeamLoading(isAdmin)
      setTeamError('')
      setError('')
    } catch { setError('重新载入失败。草稿仍保留，未发送任何修改；请重试重新载入。') }
    finally { busyRef.current = false; setLoading(false) }
  }

  const ownerOptions = users.map(user => ({ value: user.id, label: user.displayName + '（' + user.username + '）', textLabel: user.displayName + ' ' + user.username }))
  if (!ownerOptions.some(option => option.value === draft.ownerId)) ownerOptions.push({ value: draft.ownerId, label: session.detail.project.ownerName, textLabel: session.detail.project.ownerName })
  const collaborators = session.members?.members.filter(member => member.role === 'editor').map(member => member.displayName || member.userId).join('、') ?? session.detail.project.collaboratorNames

  return <Dialog onClose={close} label="修改课题配置" size="4xl" zIndex={70} initialFocusRef={closeButtonRef} className="p-3 sm:p-6" panelClassName="flex h-[min(54rem,calc(100vh-2rem))] flex-col md:flex-row">
    <DialogCloseButton buttonRef={closeButtonRef} onClose={close} label="关闭编辑" className="absolute right-4 top-4 z-20 h-8 w-8" />
    <aside className="flex w-full shrink-0 flex-col border-b border-yx-line bg-yx-surface p-4 sm:p-5 md:w-60 md:border-b-0 md:border-r md:p-6">
      <div className="flex items-center gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-yx-brand text-white shadow-xs"><FolderKanban className="h-5 w-5" /></span><div className="min-w-0"><h2 className="text-sm font-extrabold tracking-tight text-yx-ink">修改课题配置</h2><p className="truncate text-[10px] text-yx-muted">{session.detail.project.title}</p></div></div>
      <div className="mt-6 hidden md:block"><span className="px-1 text-[10px] font-semibold uppercase tracking-wider text-yx-muted">配置分区</span></div>
      <nav aria-label="配置分区" className="mt-2 grid grid-cols-3 gap-1 md:grid-cols-1">
        {tabs.map(tab => <button key={tab.id} type="button" aria-current={activeTab === tab.id ? 'page' : undefined} onClick={() => setActiveTab(tab.id)} className={'flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-semibold transition-all ' + (activeTab === tab.id ? 'bg-yx-brand text-white shadow-2xs' : 'text-yx-ink-soft hover:bg-yx-hover hover:text-yx-ink')}><tab.icon className="h-4 w-4 shrink-0" /><span className="truncate">{tab.label}</span></button>)}
      </nav>
    </aside>
    <form noValidate onSubmit={submit} aria-busy={loading} className="flex min-h-0 min-w-0 flex-1 flex-col justify-between overflow-hidden bg-yx-paper">
      <div className={'min-h-0 flex-1 p-6 sm:p-8 ' + (activeTab === 'plan' ? 'flex flex-col overflow-hidden pb-4' : 'yx-subtle-scrollbar overflow-y-auto')}>
        {error && <div role="alert" className="mb-4 shrink-0 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-700">{error}</div>}
        {session.blocked && <div className="mb-3 shrink-0"><Button type="button" variant="outline" disabled={loading} onClick={() => void reload()}>重新载入（丢弃未保存草稿）</Button></div>}
        <fieldset disabled={disabled} className={activeTab === 'plan' ? 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden' : 'min-w-0'}>
          {activeTab === 'info' && <ProjectConfigurationInfo value={draft.metadata} onChange={metadata => setDraft(current => ({ ...current, metadata }))} />}
          {activeTab === 'plan' && <ProjectConfigurationPlan stages={draft.stages} frozen={session.frozen} onChange={stages => setDraft(current => ({ ...current, stages }))} />}
          {activeTab === 'team' && <div className="space-y-5">
            <div><h3 className="text-base font-bold text-yx-ink">研究团队与协同分工</h3><p className="mt-0.5 text-xs text-yx-muted">配置负责统筹与审核的课题负责人，以及参与研究和计划协作的协作者。</p></div>
            <div><label className="block text-xs font-bold text-yx-ink">课题负责人 <span className="text-rose-500">*</span></label><p className="mt-0.5 text-[11px] text-yx-muted">{isAdmin ? '负责人对课题整体进度与质量负责；每个课题仅一名负责人。' : '课题负责人仅管理员可调整，如需变更请联系管理员。'}</p>
              <MultiSelect id="configuration-owner" ariaLabel="课题负责人" value={draft.ownerId ? [draft.ownerId] : []} onChange={ids => { ownerDirtyRef.current = true; setDraft(current => ({ ...current, ownerId: ids[ids.length - 1] ?? '' })) }} options={ownerOptions} placeholder="请选择课题负责人" searchPlaceholder="搜索系统用户..." searchable disabled={disabled || !isAdmin || teamLoading || !session.members} multipleLabel={() => '已指定 1 位负责人'} emptyText="暂无可选用户" className="mt-1.5" />
              {teamLoading && <p role="status" className="mt-2 text-xs text-yx-muted">正在读取团队配置…</p>}
              {teamError && <div className="mt-2 text-xs text-rose-700"><p>{teamError}</p><Button type="button" variant="outline" onClick={() => { setTeamLoading(true); setTeamAttempt(value => value + 1) }}>重试读取团队</Button></div>}
            </div>
            <div className="border-t border-yx-hover pt-2"><label className="block text-xs font-bold text-yx-ink">课题协作者</label><p className="mt-0.5 text-[11px] text-yx-muted">协作者可编辑课题信息与研究计划（最多 3 人）；报告提交仍由负责人或管理员操作。</p><div className="mt-1.5 rounded-md border border-yx-line bg-yx-surface px-3 py-2 text-xs text-yx-ink">{collaborators || '暂无协作者，请管理员在「主要设置 → 权限组」中添加。'}</div></div>
          </div>}
        </fieldset>
      </div>
      <div className="flex shrink-0 items-center justify-between gap-4 border-t border-yx-line bg-yx-surface px-6 py-4">
        <div className="flex min-w-0 flex-1 items-center gap-2"><span className="block min-w-0 truncate text-xs text-yx-muted" title={session.detail.project.title}>正在修改: <strong className="text-yx-ink">{session.detail.project.title}</strong></span></div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="ghost" disabled={loading} onClick={close}>取消</Button>
          <Button type="submit" size="lg" loading={loading} disabled={session.blocked}>{session.writesComplete ? '仅重新读取' : '保存课题配置'}</Button>
        </div>
      </div>
    </form>
  </Dialog>
}

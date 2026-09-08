'use client'

import { CalendarRange, FolderKanban, NotebookPen, Plus, RefreshCw, Trash2, Users } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogBody, DialogCloseButton, DialogFooter, DialogHeader } from '@/components/ui/dialog'
import { FormError } from '@/components/ui/field'
import { FileDropzone, reportFileContentType } from '@/components/ui/file-dropzone'
import { Input } from '@/components/ui/input'
import { MultiSelect } from '@/components/ui/multi-select'
import { Textarea } from '@/components/ui/textarea'
import { apiFetch, fetchAllPages, mutationHeaders } from '@/lib/client-request'
import { dateWeeksFromNow } from '@/modules/projects/milestone-presets'
import type { Milestone, ProjectProgressStatus, ProjectWithCapabilities } from '@/modules/projects/domain'
import type { ReportVersion } from '@/modules/reports/domain'
import type { SessionUser } from '@/modules/users/domain'

function buildUserSelectOptions(users: SessionUser[]) {
  return users.map((user) => ({
    value: user.id,
    label: `${user.displayName}（${user.username}）`,
    textLabel: `${user.displayName} ${user.username}`,
    description: user.role === 'admin' ? '管理员账号' : '研究员账号',
    badge: user.role === 'admin' ? '管理员' : '研究员',
  }))
}

function initialOwnerId(project: ProjectWithCapabilities, users: SessionUser[]) {
  if (project.ownerId) return project.ownerId
  const owner = users.find((user) => user.displayName === project.ownerName.trim())
  return owner?.id ?? ''
}


type EditMilestoneDraft = {
  key: string
  id?: string
  title: string
  targetDate: string
  description: string
  status: ProjectProgressStatus
  reportIds?: string[]
}

export function EditProjectDialog({
  project,
  users,
  currentUser,
  onClose,
  onUpdated,
}: {
  project: ProjectWithCapabilities
  users: SessionUser[]
  currentUser?: SessionUser
  onClose: () => void
  onUpdated: (project: ProjectWithCapabilities) => void
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [activeTab, setActiveTab] = useState<'info' | 'team' | 'plan'>('info')
  const [userList, setUserList] = useState<SessionUser[]>(users)

  // 1. 课题信息
  const [title, setTitle] = useState(project.title)
  const [objective, setObjective] = useState(project.objective || '')
  const [description, setDescription] = useState(project.description || '')

  // 2. 团队
  const [ownerId, setOwnerId] = useState<string>(() => initialOwnerId(project, users))
  // 成员角色由独立的权限组管理，编辑课题时不再根据展示名反推成员。
  const ownerDirtyRef = useRef(false)
  function selectOwner(id: string) {
    ownerDirtyRef.current = true
    setOwnerId(id)
  }

  // 3. 计划与阶段排期
  const [milestones, setMilestones] = useState<EditMilestoneDraft[]>(() => {
    if (project.milestones && project.milestones.length > 0) {
      return project.milestones.map((m, idx) => ({
        key: `ms-${m.id || idx}-${Date.now()}`,
        id: m.id,
        title: m.title,
        targetDate: m.targetDate || dateWeeksFromNow((idx + 1) * 2),
        description: m.description || '',
        status: m.status || 'not_started',
        reportIds: m.reportIds,
      }))
    }
    return [
      {
        key: `ms-default-${Date.now()}`,
        title: '课题立项与大纲拟定',
        targetDate: dateWeeksFromNow(2),
        description: '确立研究框架、核心假设与章节大纲，明确分工与时间节奏。',
        status: 'not_started' as const,
      },
    ]
  })

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // 确保用户列表随时可用
  useEffect(() => {
    if (users && users.length > 0) {
      setUserList(users)
      return
    }
    const controller = new AbortController()
    let cancelled = false
    void fetchAllPages<SessionUser>('/api/users', 'users', { cache: 'no-store', signal: controller.signal })
      .then(({ items }) => {
        if (!cancelled) setUserList(items)
      })
      .catch(() => {})
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [users])

  // 管理员可读取成员角色；普通成员使用已有课题和当前用户数据。
  // ownerDirty：用户已手动改选负责人后，晚到的成员响应不再覆盖其选择。
  useEffect(() => {
    if (currentUser?.role !== 'admin') return
    let cancelled = false
    void apiFetch(`/api/admin/projects/${project.id}/members`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((data: { members?: Array<{ userId: string; role: string }> }) => {
        if (!cancelled && data?.members && !ownerDirtyRef.current) {
          const owner = data.members.find((m) => m.role === 'owner')
          if (owner) setOwnerId(owner.userId)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [currentUser?.role, project.id])

  const ownerOptions = useMemo(() => buildUserSelectOptions(userList), [userList])
  const canChangeOwner = currentUser?.role === 'admin'

  function addMilestone() {
    setMilestones((prev) => [
      ...prev,
      {
        key: `ms-draft-${Date.now()}-${prev.length}`,
        title: '',
        targetDate: dateWeeksFromNow((prev.length + 1) * 2),
        description: '',
        status: 'not_started',
      },
    ])
  }

  function removeMilestone(index: number) {
    const milestone = milestones[index]
    if (milestone?.reportIds?.length) {
      setError('该阶段已关联报告，请先调整报告所属阶段后再删除。')
      return
    }
    if (milestones.length <= 1) {
      setError('课题至少需要保留一个研究阶段。')
      return
    }
    setMilestones((prev) => prev.filter((_, idx) => idx !== index))
  }

  function updateMilestone(index: number, patch: Partial<EditMilestoneDraft>) {
    setMilestones((prev) => prev.map((m, idx) => (idx === index ? { ...m, ...patch } : m)))
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (loading) return

    const normalizedTitle = title.trim()
    if (!normalizedTitle) {
      setError('课题标题不能为空。')
      setActiveTab('info')
      return
    }

    if (!objective.trim()) {
      setError('研究目标与核心问题不能为空。')
      setActiveTab('info')
      return
    }

    if (!description.trim()) {
      setError('研究背景与说明不能为空。')
      setActiveTab('info')
      return
    }

    if (canChangeOwner && !ownerId) {
      setError('请选择课题负责人。')
      setActiveTab('team')
      return
    }

    if (milestones.length === 0) {
      setError('请至少保留一个有效的课题研究阶段。')
      setActiveTab('plan')
      return
    }

    for (let i = 0; i < milestones.length; i++) {
      if (!milestones[i].title.trim()) {
        setError(`请填写阶段 ${i + 1} 的阶段名称。`)
        setActiveTab('plan')
        return
      }
      if (!milestones[i].targetDate.trim()) {
        setError(`阶段 ${i + 1}「${milestones[i].title}」尚未选择计划完成日期。`)
        setActiveTab('plan')
        return
      }
      if (!milestones[i].description.trim()) {
        setError(`请填写阶段 ${i + 1}「${milestones[i].title}」的工作内容与预期成果。`)
        setActiveTab('plan')
        return
      }
    }

    setLoading(true)
    setError('')

    const payload = {
      title: normalizedTitle,
      objective: objective.trim(),
      description: description.trim(),
      updatedAt: project.updatedAt,
      ...(canChangeOwner ? { ownerId } : {}),
      milestones: milestones.map((item, index): Milestone => ({
        id: item.id || `stage-${Date.now()}-${index}`,
        title: item.title.trim(),
        targetDate: item.targetDate,
        description: item.description.trim(),
        status: item.status,
        reportIds: item.reportIds,
      })),
    }

    const response = await apiFetch(`/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: mutationHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    }).catch(() => null)

    const body = (await response?.json().catch(() => null)) as { project?: ProjectWithCapabilities; error?: string } | null

    if (!response?.ok || !body?.project) {
      setError(body?.error ?? '修改失败，请重试。')
      setLoading(false)
      return
    }

    onUpdated(body.project)
    onClose()
  }

  return (
    <Dialog
      onClose={onClose}
      label="修改课题配置"
      size="4xl"
      zIndex={70}
      initialFocusRef={closeButtonRef}
      className="p-3 sm:p-6"
      panelClassName="flex h-[min(54rem,calc(100vh-2rem))] flex-col md:flex-row"
    >
        <DialogCloseButton
          buttonRef={closeButtonRef}
          onClose={onClose}
          label="关闭编辑"
          className="absolute right-4 top-4 z-20 h-8 w-8"
        />

        {/* 左侧分区导航栏 */}
        <aside className="flex w-full shrink-0 flex-col border-b border-yx-line bg-yx-surface p-4 sm:p-5 md:w-60 md:border-b-0 md:border-r md:p-6">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-yx-brand text-white shadow-xs">
              <FolderKanban className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-extrabold tracking-tight text-yx-ink">修改课题配置</h2>
              <p className="truncate text-[10px] text-yx-muted">{project.title}</p>
            </div>
          </div>

          <div className="mt-6 hidden md:block">
            <span className="px-1 text-[10px] font-semibold uppercase tracking-wider text-yx-muted">配置分区</span>
          </div>

          <nav className="mt-2 grid grid-cols-3 gap-1 md:grid-cols-1">
            <button
              type="button"
              onClick={() => setActiveTab('info')}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-semibold transition-all ${
                activeTab === 'info'
                  ? 'bg-yx-brand text-white shadow-2xs'
                  : 'text-yx-ink-soft hover:bg-yx-hover hover:text-yx-ink'
              }`}
            >
              <NotebookPen className={`h-4 w-4 shrink-0 ${activeTab === 'info' ? 'text-white' : 'text-yx-muted'}`} />
              <span className="truncate">01 课题信息</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('team')}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-semibold transition-all ${
                activeTab === 'team'
                  ? 'bg-yx-brand text-white shadow-2xs'
                  : 'text-yx-ink-soft hover:bg-yx-hover hover:text-yx-ink'
              }`}
            >
              <Users className={`h-4 w-4 shrink-0 ${activeTab === 'team' ? 'text-white' : 'text-yx-muted'}`} />
              <span className="truncate">02 研究团队</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('plan')}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-semibold transition-all ${
                activeTab === 'plan'
                  ? 'bg-yx-brand text-white shadow-2xs'
                  : 'text-yx-ink-soft hover:bg-yx-hover hover:text-yx-ink'
              }`}
            >
              <CalendarRange className={`h-4 w-4 shrink-0 ${activeTab === 'plan' ? 'text-white' : 'text-yx-muted'}`} />
              <span className="truncate">03 计划与排期</span>
            </button>
          </nav>
        </aside>

        {/* 右侧主表单区 */}
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col justify-between bg-yx-paper overflow-hidden">
          <div className={`min-h-0 flex-1 p-6 sm:p-8 ${activeTab === 'plan' ? 'flex flex-col overflow-hidden pb-4' : 'yx-subtle-scrollbar overflow-y-auto'}`}>
            {error && (
              <div className="mb-4 shrink-0 rounded-lg bg-rose-50 border border-rose-200 px-3.5 py-2.5 text-xs text-rose-700">
                {error}
              </div>
            )}

            {/* TAB 1: 课题信息 */}
            {activeTab === 'info' && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-base font-bold text-yx-ink">课题核心信息</h3>
                  <p className="mt-0.5 text-xs text-yx-muted">修改课题标题、研究立项目标与背景说明。</p>
                </div>

                <div>
                  <label className="block text-xs font-bold text-yx-ink">
                    课题标题 <span className="text-rose-500">*</span>
                  </label>
                  <Input
                    required
                    maxLength={160}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="请输入课题标题（如：区域产业政策研究）"
                    className="mt-1.5"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-yx-ink">研究目标与核心问题 <span className="text-rose-500">*</span></label>
                  <Textarea
                    rows={3}
                    required
                    maxLength={2000}
                    value={objective}
                    onChange={(e) => setObjective(e.target.value)}
                    placeholder="例如：评估政策补贴对产业链上下游的影响，提出优化资源配置的实证依据与落地对策。"
                    className="mt-1.5"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-yx-ink">研究背景与说明 <span className="text-rose-500">*</span></label>
                  <Textarea
                    rows={4}
                    required
                    maxLength={5000}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="补充课题的研究范围、调研对象、关键假设或协同要求。"
                    className="mt-1.5"
                  />
                </div>
              </div>
            )}

            {/* TAB 2: 研究团队 */}
            {activeTab === 'team' && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-base font-bold text-yx-ink">研究团队与协同分工</h3>
                  <p className="mt-0.5 text-xs text-yx-muted">配置负责统筹与审核的课题负责人，以及参与研究与提交成果的协作者。</p>
                </div>

                <div>
                  <label className="block text-xs font-bold text-yx-ink">
                    课题负责人 <span className="text-rose-500">*</span>
                  </label>
                  <p className="mt-0.5 text-[11px] text-yx-muted">
                    {canChangeOwner
                      ? '负责人对课题整体进度与质量负责；每个课题仅一名负责人。'
                      : '课题负责人仅管理员可调整，如需变更请联系管理员。'}
                  </p>
                  <MultiSelect
                    id="edit-project-owners"
                    ariaLabel="课题负责人"
                    value={ownerId ? [ownerId] : []}
                    onChange={(ids) => selectOwner(ids[ids.length - 1] ?? '')}
                    options={canChangeOwner ? ownerOptions : ownerOptions.filter((option) => option.value === ownerId)}
                    placeholder="请选择课题负责人"
                    searchPlaceholder="搜索系统用户..."
                    searchable
                    disabled={!canChangeOwner}
                    multipleLabel={() => '已指定 1 位负责人'}
                    emptyText="暂无可选用户"
                    className="mt-1.5"
                  />
                </div>

                <div className="pt-2 border-t border-yx-hover">
                  <label className="block text-xs font-bold text-yx-ink">课题协作者</label>
                  <p className="mt-0.5 text-[11px] text-yx-muted">
                    协作者可上传阶段报告成果、跟进研究进展并参与课题协同（最多 3 人）。
                  </p>
                  <div className="mt-1.5 rounded-md border border-yx-line bg-yx-surface px-3 py-2 text-xs text-yx-ink">
                    {project.collaboratorNames || '暂无协作者，请管理员在「主要设置 → 权限组」中添加。'}
                  </div>
                </div>
              </div>
            )}

            {/* TAB 3: 计划与排期 */}
            {activeTab === 'plan' && (
              <div className="flex h-full min-h-0 flex-col">
                {/* 固定不动的标题与说明 */}
                <div className="shrink-0 pb-3 border-b border-yx-hover">
                  <h3 className="text-base font-bold text-yx-ink">研究计划与阶段排期</h3>
                  <p className="mt-0.5 text-xs text-yx-muted">拆解各研究阶段名称、计划完成日期与核心成果预期。</p>
                </div>

                {/* 仅阶段卡片列表和新增按钮上下滚动 */}
                <div className="yx-subtle-scrollbar min-h-0 flex-1 overflow-y-auto pt-4 pr-1 space-y-3.5">
                  {milestones.map((m, idx) => (
                    <div key={m.key} className="rounded-lg border border-yx-line bg-yx-surface p-4 transition-all hover:border-yx-brand/60">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <span className="flex h-5.5 w-5.5 items-center justify-center rounded-full bg-yx-brand text-[11px] font-extrabold text-white">
                            0{idx + 1}
                          </span>
                          <span className="text-xs font-bold text-yx-ink">阶段 {idx + 1}</span>
                        </div>

                        {milestones.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeMilestone(idx)}
                            disabled={Boolean(m.reportIds?.length)}
                            className="text-yx-faint transition-colors hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-30"
                            title={m.reportIds?.length ? '该阶段已关联报告，不能直接删除' : '删除此阶段'}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>

                      {/* 阶段名称与计划完成时间 */}
                      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_200px]">
                        <div>
                          <Input
                            value={m.title}
                            onChange={(e) => updateMilestone(idx, { title: e.target.value })}
                            placeholder="阶段名称（如：产业调研与事实萃取）"
                            required
                          />
                        </div>
                        <div>
                          <Input
                            type="date"
                            value={m.targetDate}
                            onChange={(e) => updateMilestone(idx, { targetDate: e.target.value })}
                            required
                          />
                        </div>
                      </div>

                      {/* 阶段目标与预期成果 */}
                      <div className="mt-2.5">
                        <Textarea
                          rows={2}
                          required
                          maxLength={300}
                          value={m.description}
                          onChange={(e) => updateMilestone(idx, { description: e.target.value })}
                          placeholder="工作内容与预期成果（必填，如：完成政策文件梳理与实证数据初筛）"
                        />
                      </div>
                    </div>
                  ))}

                  <button
                    type="button"
                    onClick={addMilestone}
                    className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-yx-line bg-yx-paper py-2.5 text-xs font-semibold text-yx-brand transition-all hover:border-yx-brand hover:bg-yx-brand/5"
                  >
                    <Plus className="h-4 w-4" />
                    <span>添加新的研究阶段</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 底部操作工具栏 */}
          <div className="flex shrink-0 items-center justify-between gap-4 border-t border-yx-line bg-yx-surface px-6 py-4">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="block min-w-0 truncate text-xs text-yx-muted" title={project.title}>
                正在修改: <strong className="text-yx-ink">{project.title}</strong>
              </span>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <Button variant="ghost" onClick={onClose}>取消</Button>
              <Button type="submit" loading={loading} size="lg">保存课题配置</Button>
            </div>
          </div>
        </form>
    </Dialog>
  )
}

function ReportPreviewCard({ report, fileLabel }: { report: ReportVersion; fileLabel?: string }) {
  return (
    <div className="rounded-lg bg-yx-surface px-3 py-3">
      <div className="flex items-center gap-2">
        <span className="rounded bg-yx-brand px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-white">V{report.version}</span>
        <p className="min-w-0 truncate text-xs font-semibold text-yx-ink" title={report.title}>{report.title}</p>
      </div>
      <p className="mt-1.5 truncate text-[10px] text-yx-muted" title={report.fileName}>{fileLabel ? fileLabel + report.fileName : report.fileName}</p>
    </div>
  )
}


export function DeleteReportDialog({ report, onClose, onDeleted }: { report: ReportVersion; onClose: () => void; onDeleted: (report: ReportVersion) => void }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function confirmDelete() {
    if (loading) return
    setLoading(true)
    setError('')
    const response = await apiFetch(`/api/reports/${report.id}`, { method: 'DELETE', headers: mutationHeaders() }).catch(() => null)
    const body = response
      ? await response.json().catch(() => null) as { ok?: boolean; error?: string } | null
      : null
    if (!response?.ok || !body?.ok) {
      setError(body?.error ?? '删除报告版本失败。')
      setLoading(false)
      return
    }
    onDeleted(report)
  }

  return (
    <ConfirmDialog
      title="删除报告版本"
      description="删除后无法恢复，该版本的源文件、分析任务、评分与洞察将一并清除。"
      titleId="delete-report-title"
      descriptionId="delete-report-description"
      confirmLabel="确认删除"
      loading={loading}
      error={error}
      onClose={onClose}
      onConfirm={confirmDelete}
    >
      <ReportPreviewCard report={report} />
    </ConfirmDialog>
  )
}

export function ReplaceReportDialog({ report, onClose, onReplaced }: { report: ReportVersion; onClose: () => void; onReplaced: (report: ReportVersion) => void }) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const [file, setFile] = useState<File>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function confirmReplace() {
    if (!file || loading) {
      if (!file) setError('请选择用于替换的 DOCX 或 PDF 文件。')
      return
    }
    setLoading(true)
    setError('')
    const response = await apiFetch(`/api/reports/${report.id}`, {
      method: 'PUT',
      headers: mutationHeaders({
        'Content-Type': reportFileContentType(file.name),
        'X-File-Name': encodeURIComponent(file.name),
      }),
      body: file,
    }).catch(() => null)
    const body = response
      ? await response.json().catch(() => null) as { report?: ReportVersion; error?: string } | null
      : null
    if (!response?.ok || !body?.report) {
      setError(body?.error ?? '替换报告失败。')
      setLoading(false)
      return
    }
    onReplaced(body.report)
  }

  return (
    <Dialog onClose={onClose} labelledBy="replace-report-title" describedBy="replace-report-description" initialFocusRef={cancelButtonRef}>
      <DialogHeader
        title="替换历史阶段报告"
        description="保留当前版本号与阶段归属，原文件及分析结果会被新文件替换并重新分析。"
        titleId="replace-report-title"
        descriptionId="replace-report-description"
        icon={RefreshCw}
        iconTone="brand"
        onClose={onClose}
      />
      <DialogBody className="space-y-3 py-4">
        <ReportPreviewCard report={report} fileLabel="当前文件：" />
        <FileDropzone
          file={file}
          disabled={loading}
          onFile={(next) => { setFile(next); setError('') }}
          onInvalid={setError}
          emptyTitle="选择新的 DOCX 或 PDF 报告"
        />
        {error ? <FormError>{error}</FormError> : null}
      </DialogBody>
      <DialogFooter>
        <Button ref={cancelButtonRef} variant="ghost" onClick={onClose} disabled={loading}>取消</Button>
        <Button onClick={confirmReplace} disabled={!file} loading={loading}>确认替换</Button>
      </DialogFooter>
    </Dialog>
  )
}

export function DeleteProjectDialog({ project, onClose, onDeleted }: { project: ProjectWithCapabilities; onClose: () => void; onDeleted: (projectId: string) => void }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function confirmDelete() {
    if (loading) return
    if (!project.canDelete) {
      setError('当前账号没有删除课题的权限。')
      return
    }
    setLoading(true)
    setError('')
    const response = await apiFetch(`/api/projects/${project.id}`, { method: 'DELETE', headers: mutationHeaders() }).catch(() => null)
    const body = response
      ? await response.json().catch(() => null) as { ok?: boolean; error?: string } | null
      : null
    if (!response?.ok || !body?.ok) {
      setError(body?.error ?? '删除失败。')
      setLoading(false)
      return
    }
    onDeleted(project.id)
  }

  return (
    <ConfirmDialog
      title="删除课题"
      description="删除后无法恢复，课题下的报告、分析任务与洞察将一并清除。"
      titleId="delete-project-title"
      descriptionId="delete-project-description"
      confirmLabel="确认删除"
      loading={loading}
      error={error}
      onClose={onClose}
      onConfirm={confirmDelete}
    >
      <div className="rounded-lg bg-yx-surface px-3 py-3">
        <p className="text-[10px] text-yx-muted">即将删除</p>
        <p className="mt-0.5 text-xs font-semibold text-yx-ink">{project.title}</p>
        <p className="mt-1 line-clamp-2 text-[10px] text-yx-muted">{project.objective}</p>
      </div>
    </ConfirmDialog>
  )
}

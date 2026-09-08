'use client'

import { BookOpen, Building2, CalendarPlus, ChevronDown, ChevronRight, Download, FolderOpen, GraduationCap, HardDrive, Landmark, Layers3, LineChart, Loader2, Search, Trash2, Upload, UserRound } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { CardAura, GroupCardDecoration } from '@/components/ui/card-decoration'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Field, FormError } from '@/components/ui/field'
import { FileDropzone } from '@/components/ui/file-dropzone'
import { Input } from '@/components/ui/input'
import { CellCaption, RepositoryStatCell } from '@/components/ui/repository-stats'
import { CustomSelect } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { apiFetch, fetchAllPages, mutationHeaders } from '@/lib/client-request'
import { formatBytes, formatRelativeTime, formatReportDate } from '@/lib/format'
import { cumulativeTrend } from '@/lib/overview-trends'
import { knowledgeMaxUploadBytes } from '@/lib/upload-limits'
import type { KnowledgeItem } from '@/components/workspace-types'

const KNOWLEDGE_CATEGORIES = ['宏观政策', '行业研报', '企业研究', '学术资料', '其他'] as const

const categoryIcons: Record<string, LucideIcon> = {
  宏观政策: Landmark,
  行业研报: LineChart,
  企业研究: Building2,
  学术资料: GraduationCap,
  其他: FolderOpen,
}

function categoryOf(item: KnowledgeItem) {
  return item.category.trim() || '其他'
}

function categoryIcon(category: string) {
  return categoryIcons[category] ?? FolderOpen
}

function fileKind(fileName: string) {
  return fileName.toLowerCase().endsWith('.pdf') ? 'PDF' : 'DOC'
}

function firstSeenEvents(entries: Array<{ key: string; at: string }>) {
  const first = new Map<string, string>()
  for (const entry of entries) {
    const existing = first.get(entry.key)
    if (!existing || entry.at < existing) first.set(entry.key, entry.at)
  }
  return [...first.values()].map((at) => ({ at, value: 1 }))
}

export function KnowledgeBaseWorkspace({
  onNotice,
  onKnowledgeCountChange,
}: {
  onNotice: (message: string) => void
  onKnowledgeCountChange?: () => void
}) {
  const [items, setItems] = useState<KnowledgeItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [expandedCategoryIds, setExpandedCategoryIds] = useState<string[]>([])
  const [uploadOpen, setUploadOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeItem | undefined>()
  const [deletingId, setDeletingId] = useState<string>()

  // 用 ref 持有回调，避免父组件每次渲染传入的新函数触发 fetchItems 重建与重复请求
  const onKnowledgeCountChangeRef = useRef(onKnowledgeCountChange)
  onKnowledgeCountChangeRef.current = onKnowledgeCountChange

  const loadSequenceRef = useRef(0)
  const loadControllerRef = useRef<AbortController | undefined>(undefined)

  const fetchItems = useCallback(async () => {
    const requestSequence = ++loadSequenceRef.current
    loadControllerRef.current?.abort()
    const controller = new AbortController()
    loadControllerRef.current = controller
    setLoading(true)
    try {
      const result = await fetchAllPages<KnowledgeItem>('/api/knowledge', 'items', { cache: 'no-store', signal: controller.signal })
      if (controller.signal.aborted || requestSequence !== loadSequenceRef.current) return
      setItems(result.items)
      onKnowledgeCountChangeRef.current?.()
      setLoadError('')
    } catch {
      if (controller.signal.aborted || requestSequence !== loadSequenceRef.current) return
      setLoadError('知识库刷新失败，已保留上次成功加载的内容。')
    } finally {
      if (loadControllerRef.current === controller) loadControllerRef.current = undefined
      if (!controller.signal.aborted && requestSequence === loadSequenceRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchItems()
    return () => {
      loadSequenceRef.current += 1
      loadControllerRef.current?.abort()
    }
  }, [fetchItems])

  const categoryOptions = useMemo(() => {
    const canonical = new Set<string>(KNOWLEDGE_CATEGORIES)
    const extras = [...new Set(items.map(categoryOf))].filter((category) => !canonical.has(category))
    const counts = new Map<string, number>()
    for (const item of items) {
      const category = categoryOf(item)
      counts.set(category, (counts.get(category) ?? 0) + 1)
    }
    return [
      {
        value: 'all',
        label: `全部分类 (${items.length})`,
        textLabel: '全部分类',
        icon: BookOpen,
      },
      ...[...KNOWLEDGE_CATEGORIES, ...extras].map((category) => ({
        value: category,
        label: category,
        textLabel: category,
        icon: categoryIcon(category),
        badge: String(counts.get(category) ?? 0),
        badgeTone: 'gray' as const,
      })),
    ]
  }, [items])

  const filteredItems = useMemo(() => {
    const query = search.trim().toLowerCase()
    return items.filter((item) => {
      if (categoryFilter !== 'all' && categoryOf(item) !== categoryFilter) return false
      if (!query) return true
      return (
        item.title.toLowerCase().includes(query) ||
        item.fileName.toLowerCase().includes(query) ||
        item.description.toLowerCase().includes(query) ||
        item.uploadedBy.toLowerCase().includes(query) ||
        categoryOf(item).toLowerCase().includes(query) ||
        item.tags.some((tag) => tag.toLowerCase().includes(query))
      )
    })
  }, [categoryFilter, items, search])

  const groupedItems = useMemo(() => {
    const groups = new Map<string, KnowledgeItem[]>()
    for (const item of filteredItems) {
      const category = categoryOf(item)
      const list = groups.get(category)
      if (list) list.push(item)
      else groups.set(category, [item])
    }
    for (const list of groups.values()) {
      list.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.title.localeCompare(right.title, 'zh-CN'))
    }
    const ordered: Array<{ category: string; items: KnowledgeItem[] }> = []
    for (const category of KNOWLEDGE_CATEGORIES) {
      const list = groups.get(category)
      if (!list?.length) continue
      ordered.push({ category, items: list })
      groups.delete(category)
    }
    for (const [category, list] of groups) ordered.push({ category, items: list })
    return ordered
  }, [filteredItems])

  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000
  const weeklyNewItems = filteredItems.filter((item) => {
    const time = new Date(item.createdAt).getTime()
    return !Number.isNaN(time) && time >= weekAgo
  })
  const totalBytes = filteredItems.reduce((sum, item) => sum + item.fileSize, 0)
  const knowledgeStats = [
    { label: '收录资料', value: filteredItems.length.toLocaleString('zh-CN'), unit: '份', icon: BookOpen, points: cumulativeTrend(filteredItems.map((item) => ({ at: item.createdAt, value: 1 }))), trendLabel: '近 7 日收录资料累计走势' },
    { label: '覆盖分类', value: groupedItems.length.toLocaleString('zh-CN'), unit: '个', icon: Layers3, points: cumulativeTrend(firstSeenEvents(filteredItems.map((item) => ({ key: categoryOf(item), at: item.createdAt })))), trendLabel: '近 7 日覆盖分类累计走势' },
    { label: '总容量', value: formatBytes(totalBytes), unit: '', icon: HardDrive, points: cumulativeTrend(filteredItems.map((item) => ({ at: item.createdAt, value: item.fileSize }))), trendLabel: '近 7 日资料容量累计走势' },
    { label: '近 7 日新增', value: weeklyNewItems.length.toLocaleString('zh-CN'), unit: '份', icon: CalendarPlus, points: cumulativeTrend(weeklyNewItems.map((item) => ({ at: item.createdAt, value: 1 }))), trendLabel: '近 7 日新增资料累计走势' },
  ]

  function toggleCategoryExpanded(category: string) {
    setExpandedCategoryIds((current) => current.includes(category)
      ? current.filter((id) => id !== category)
      : [...current, category])
  }

  async function handleDelete(item: KnowledgeItem) {
    if (deletingId) return
    setDeletingId(item.id)
    const response = await apiFetch('/api/knowledge/' + item.id, {
      method: 'DELETE',
      headers: mutationHeaders(),
    }).catch(() => null)
    if (response?.ok) {
      setItems((current) => current.filter((entry) => entry.id !== item.id))
      setDeleteTarget(undefined)
      onKnowledgeCountChangeRef.current?.()
      onNotice('参考研报已删除。')
    } else {
      onNotice('删除失败。')
    }
    setDeletingId(undefined)
  }

  return (
    <div className="space-y-6">
      <h1 className="sr-only">知识库</h1>
      {loadError && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-yx-warning/25 bg-yx-warning-soft px-4 py-3 text-xs text-yx-warning-text">
          <span>{loadError}</span>
          <button type="button" onClick={() => void fetchItems()} className="shrink-0 font-semibold underline decoration-yx-warning/40 underline-offset-2">重试</button>
        </div>
      )}

      {/* 工具面板：标题 + 搜索筛选 + 统计磁贴，装饰语言对齐总览与报告库 */}
      <section className="relative overflow-hidden rounded-lg border border-yx-line bg-yx-paper p-5 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-[border-color,box-shadow] duration-200 hover:border-yx-brand/25 hover:shadow-[0_12px_28px_-14px_color-mix(in_srgb,var(--yx-brand-strong)_25%,transparent)]">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
          <CardAura showTopHighlight={false} />
        </div>
        <div className="relative z-10">
          <div className="flex min-h-8 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="flex min-w-0 items-center gap-2 text-[13px] font-bold text-yx-ink">
              <BookOpen className="h-[17px] w-[17px] shrink-0 text-yx-muted" />
              知识库
              <span className="rounded-full bg-yx-surface px-2 py-0.5 text-[9.5px] font-semibold text-yx-muted ring-1 ring-yx-line">
                {filteredItems.length} 份资料 · {groupedItems.length} 个分类
              </span>
            </h2>
            <button
              type="button"
              onClick={() => setUploadOpen(true)}
              className="flex items-center justify-center gap-1.5 rounded-full bg-yx-brand px-3.5 py-1.5 text-[11px] font-semibold text-white shadow-2xs transition-colors hover:bg-yx-brand-hover"
            >
              <Upload className="h-3.5 w-3.5 text-white" />
              上传参考研报
            </button>
          </div>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative max-w-sm flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-yx-faint" />
              <input
                type="text"
                placeholder="搜索资料标题、标签、摘要或上传者..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="w-full rounded-md border border-yx-line bg-yx-surface/70 px-3 py-2 pl-9 text-xs text-yx-ink placeholder:text-yx-faint transition-all focus:border-transparent focus:bg-yx-paper focus:outline-none focus:ring-2 focus:ring-yx-brand"
              />
            </div>
            <div className="w-56 shrink-0 sm:w-64">
              <CustomSelect
                value={categoryFilter}
                onChange={(value) => setCategoryFilter(value)}
                options={categoryOptions}
                placeholder="筛选资料分类..."
                size="md"
                variant="notion"
                ariaLabel="筛选资料分类"
              />
            </div>
          </div>

          <div className="mt-4 overflow-hidden rounded-lg border border-yx-line">
            <div className="grid grid-cols-2 gap-px bg-yx-line sm:grid-cols-4">
              {knowledgeStats.map((stat, index) => (
                <RepositoryStatCell key={stat.label} gradientId={'yx-knowledge-trend-' + index} {...stat} />
              ))}
            </div>
          </div>
        </div>
      </section>

      {loading ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-[11px] text-yx-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-yx-brand" />
            正在加载知识库...
          </div>
          {[0, 1].map((key) => (
            <div key={key} className="overflow-hidden rounded-lg border border-yx-line bg-yx-paper">
              <div className="flex items-center gap-3 px-4 py-3">
                <span className="h-4 w-4 rounded-full bg-yx-hover" />
                <span className="h-4 w-36 rounded-full bg-yx-hover" />
                <span className="ml-auto h-4 w-48 rounded-full bg-yx-hover" />
              </div>
            </div>
          ))}
        </div>
      ) : groupedItems.length > 0 ? (
        <div className="space-y-4">
          {groupedItems.map((group, groupIndex) => {
            const CategoryIcon = categoryIcon(group.category)
            const collapsed = !expandedCategoryIds.includes(group.category)
            const groupBytes = group.items.reduce((sum, item) => sum + item.fileSize, 0)
            const latestAt = group.items[0]?.createdAt
            return (
              <section key={group.category} className={`relative overflow-hidden rounded-lg border bg-yx-paper shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-[border-color,box-shadow] duration-200 hover:shadow-[0_12px_28px_-14px_color-mix(in_srgb,var(--yx-brand-strong)_25%,transparent)] ${collapsed ? 'border-yx-line hover:border-yx-brand/30' : 'border-yx-brand/35'}`}>
                <GroupCardDecoration />
                <header className={`group relative z-10 flex items-center justify-between gap-3 px-4 py-3 transition-colors ${collapsed ? 'bg-yx-paper hover:bg-yx-brand-soft/35' : 'border-b border-yx-line bg-yx-brand-soft/40'}`}>
                  <button
                    type="button"
                    onClick={() => toggleCategoryExpanded(group.category)}
                    aria-expanded={!collapsed}
                    aria-label={collapsed ? '展开' + group.category + '的资料' : '折叠' + group.category + '的资料'}
                    className="absolute inset-0 z-0 rounded-[inherit] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-yx-brand"
                  />
                  <div className="pointer-events-none relative z-10 flex min-w-0 items-center gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-yx-brand-soft text-yx-brand">
                      {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    </span>
                    <span
                      aria-hidden="true"
                      className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-yx-brand-soft px-1.5 text-[10px] font-bold tabular-nums text-yx-brand"
                    >
                      {groupIndex + 1}
                    </span>
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-yx-brand-soft text-yx-brand">
                      <CategoryIcon className="h-3 w-3" />
                    </span>
                    <span className="truncate text-[13px] font-semibold text-yx-ink">{group.category}</span>
                  </div>
                  <div className="pointer-events-none relative z-10 flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-1.5 text-[10px] font-medium text-yx-muted">
                    {latestAt && (
                      <span className="inline-flex items-center rounded-full bg-yx-paper/80 px-2 py-0.5">
                        最近 {formatRelativeTime(latestAt)}
                      </span>
                    )}
                    <span className="inline-flex items-center rounded-full bg-yx-paper/80 px-2 py-0.5 tabular-nums">{formatBytes(groupBytes)}</span>
                    <span className="inline-flex items-center rounded-full bg-yx-paper/80 px-2 py-0.5 tabular-nums">{group.items.length} 份</span>
                  </div>
                </header>
                {!collapsed && (
                  <div className="relative z-10 overflow-x-auto">
                    <table className="w-full min-w-[720px] text-left text-xs">
                      <tbody className="divide-y divide-yx-line/80 text-yx-ink">
                        {group.items.map((item) => {
                          const isPdf = fileKind(item.fileName) === 'PDF'
                          return (
                            <tr key={item.id} className="transition-colors hover:bg-yx-brand-soft/25">
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-2.5">
                                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[9px] font-bold ${isPdf ? 'bg-yx-brand-soft text-yx-brand' : 'bg-yx-surface text-yx-ink-soft ring-1 ring-yx-line'}`}>
                                    {isPdf ? 'PDF' : 'DOC'}
                                  </span>
                                  <div className="min-w-0">
                                    <a
                                      href={'/api/knowledge/' + item.id + '/file'}
                                      download={item.fileName}
                                      className="block max-w-[18rem] truncate font-semibold text-yx-ink transition-colors hover:text-yx-brand"
                                      title={item.title}
                                    >
                                      {item.title}
                                    </a>
                                    <span className="block max-w-[18rem] truncate text-[10px] text-yx-muted" title={item.description || item.fileName}>
                                      {item.fileName}{item.description ? ' · ' + item.description : ''}
                                    </span>
                                  </div>
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                <CellCaption label="标签">
                                  {item.tags.length > 0 ? (
                                    <div className="flex flex-wrap items-center justify-center gap-1">
                                      {item.tags.slice(0, 3).map((tag) => (
                                        <span key={tag} className="rounded-full bg-yx-surface px-2 py-0.5 text-[10px] text-yx-ink-soft ring-1 ring-yx-line">
                                          #{tag}
                                        </span>
                                      ))}
                                      {item.tags.length > 3 ? <span className="text-[10px] text-yx-faint">+{item.tags.length - 3}</span> : null}
                                    </div>
                                  ) : (
                                    <span className="text-yx-faint">--</span>
                                  )}
                                </CellCaption>
                              </td>
                              <td className="px-4 py-3">
                                <CellCaption label="上传者">
                                  <span className="inline-flex max-w-28 items-center gap-1 text-yx-ink-soft" title={item.uploadedBy}>
                                    <UserRound className="h-3 w-3 shrink-0 text-yx-brand" />
                                    <span className="truncate">{item.uploadedBy || '--'}</span>
                                  </span>
                                </CellCaption>
                              </td>
                              <td className="px-4 py-3">
                                <CellCaption label="上传时间">
                                  <span className="text-[11px] tabular-nums text-yx-muted">{formatReportDate(item.createdAt)}</span>
                                </CellCaption>
                              </td>
                              <td className="px-4 py-3">
                                <CellCaption label="大小">
                                  <span className="tabular-nums text-yx-ink">{formatBytes(item.fileSize)}</span>
                                </CellCaption>
                              </td>
                              <td className="px-4 py-3 text-right">
                                <div className="flex items-center justify-end gap-1.5">
                                  <a
                                    href={'/api/knowledge/' + item.id + '/file'}
                                    download={item.fileName}
                                    aria-label={'下载 ' + item.title}
                                    title="下载原件"
                                    className="flex h-7 w-7 items-center justify-center rounded-full text-yx-muted transition-colors hover:bg-yx-brand-soft hover:text-yx-brand"
                                  >
                                    <Download className="h-3.5 w-3.5" />
                                  </a>
                                  {item.canDelete && (
                                    <button
                                      type="button"
                                      onClick={() => setDeleteTarget(item)}
                                      aria-label={'删除 ' + item.title}
                                      title="删除"
                                      className="flex h-7 w-7 items-center justify-center rounded-full text-yx-muted transition-colors hover:bg-rose-50 hover:text-rose-600"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )
          })}
        </div>
      ) : (
        <EmptyState
          icon={BookOpen}
          title={items.length ? '暂无匹配的参考资料' : '暂无参考研报'}
          description={items.length ? '请尝试调整搜索关键词或分类筛选。' : '您可以上传外部权威研报、行业宏观政策文件等作为知识储备。'}
          className="py-16"
          action={!items.length ? (
            <Button onClick={() => setUploadOpen(true)}>
              <Upload className="h-4 w-4 text-white" />
              上传第一份研报
            </Button>
          ) : undefined}
        />
      )}

      {uploadOpen && (
        <UploadKnowledgeDialog
          onClose={() => setUploadOpen(false)}
          onUploaded={(newItem) => {
            setItems((current) => [newItem, ...current])
            setCategoryFilter('all')
            onKnowledgeCountChangeRef.current?.()
            setUploadOpen(false)
            onNotice('参考研报已收录到知识库。')
          }}
        />
      )}

      {deleteTarget && (
        <DeleteKnowledgeDialog
          item={deleteTarget}
          loading={deletingId === deleteTarget.id}
          onClose={() => setDeleteTarget(undefined)}
          onConfirm={() => void handleDelete(deleteTarget)}
        />
      )}
    </div>
  )
}

function DeleteKnowledgeDialog({
  item,
  loading = false,
  onClose,
  onConfirm,
}: {
  item: KnowledgeItem
  loading?: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <ConfirmDialog
      title="确认删除此研报？"
      description={'确认删除「' + item.title + '」？此操作无法撤销。'}
      titleId="delete-knowledge-title"
      descriptionId="delete-knowledge-description"
      confirmLabel="确认删除"
      loading={loading}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  )
}

function UploadKnowledgeDialog({
  onClose,
  onUploaded,
}: {
  onClose: () => void
  onUploaded: (item: KnowledgeItem) => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState('行业研报')
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!file) {
      setError('请选择要上传的研报文件。')
      return
    }
    setSaving(true)
    setError('')
    const formData = new FormData()
    formData.append('file', file)
    formData.append('title', title.trim() || file.name)
    formData.append('category', category)
    formData.append('description', description.trim())
    formData.append('tags', tags.trim())
    const response = await apiFetch('/api/knowledge', {
      method: 'POST',
      headers: mutationHeaders(),
      body: formData,
    }).catch(() => null)
    const body = (await response?.json().catch(() => null)) as { item?: KnowledgeItem; error?: string } | null
    if (!response?.ok || !body?.item) {
      setError(body?.error ?? '上传失败。')
      setSaving(false)
      return
    }
    onUploaded(body.item)
  }

  return (
    <Dialog onClose={onClose} labelledBy="upload-knowledge-title" describedBy="upload-knowledge-description" initialFocusRef={closeButtonRef}>
      <form onSubmit={submit}>
        <DialogHeader
          title="上传参考研报"
          description="上传行业研报、宏观政策与参考文献进入知识库。"
          titleId="upload-knowledge-title"
          descriptionId="upload-knowledge-description"
          icon={BookOpen}
          onClose={onClose}
          closeRef={closeButtonRef}
          closeLabel="关闭上传参考研报对话框"
        />
        <DialogBody className="space-y-3.5 py-4">
          <Field label="研报文件 (DOCX / PDF)" required>
            <FileDropzone
              file={file}
              maxBytes={knowledgeMaxUploadBytes}
              disabled={saving}
              onFile={(next) => {
                setFile(next)
                setTitle((current) => current || next.name.replace(/\.[^/.]+$/, ''))
                setError('')
              }}
              onInvalid={setError}
              emptyTitle="选择或拖拽 DOCX / PDF 研报"
            />
          </Field>
          <Field label="研报标题" htmlFor="knowledge-title" required>
            <Input
              id="knowledge-title"
              required
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如：2026年新能源储能行业深度研究报告"
            />
          </Field>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="分类归属">
              <CustomSelect
                value={category}
                onChange={(value) => setCategory(value)}
                options={[
                  { value: '宏观政策', label: '宏观政策' },
                  { value: '行业研报', label: '行业研报' },
                  { value: '企业研究', label: '企业研究' },
                  { value: '学术资料', label: '学术资料' },
                  { value: '其他', label: '其他' },
                ]}
                size="md"
                variant="notion"
                ariaLabel="分类归属"
              />
            </Field>
            <Field label="标签 (逗号分隔)" htmlFor="knowledge-tags">
              <Input
                id="knowledge-tags"
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                placeholder="如: 新能源, 储能"
              />
            </Field>
          </div>
          <Field label="摘要 / 说明 (选填)" htmlFor="knowledge-description">
            <Textarea
              id="knowledge-description"
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="请输入该研报的核心要点、研究结论或参考价值..."
            />
          </Field>
          {error ? <FormError>{error}</FormError> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button type="submit" loading={saving}>确认上传</Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}

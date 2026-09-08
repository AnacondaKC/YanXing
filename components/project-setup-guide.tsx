'use client'

import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Calendar,
  CalendarRange,
  Check,
  CheckCircle2,
  FolderKanban,
  Loader2,
  NotebookPen,
  Plus,
  Rocket,
  Search,
  Trash2,
  Users,
  Workflow,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { IconBadge } from '@/components/ui/icon-badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { Milestone, ProjectWithCapabilities } from '@/modules/projects/domain'
import { dateWeeksFromNow } from '@/modules/projects/milestone-presets'
import type { SessionUser } from '@/modules/users/domain'
import { apiFetch, mutationHeaders } from '@/lib/client-request'

interface ProjectSetupGuideViewProps {
  users: SessionUser[]
  currentUser?: SessionUser
  onProjectCreated: (project: ProjectWithCapabilities) => void
}

type MilestoneDraft = {
  key: string
  title: string
  targetDate: string
  description: string
}


// 计划模板
const PLAN_PRESETS = [
  {
    id: 'thinktank-4',
    name: '智库决策标准四阶段',
    tag: '推荐 · 最全面',
    desc: '从立项大纲到产业调研、AI深度研判与成果评审的完整智库研究闭环',
    milestones: [
      { title: '课题立项与大纲拟定', offsetWeeks: 1, description: '确立研究框架、核心假设与章节大纲，明确分工与时间节奏。' },
      { title: '产业调研与事实萃取', offsetWeeks: 3, description: '搜集政策文件、行业研报与关键指标数据，形成事实素材库。' },
      { title: '报告起草与 AI 深度研判', offsetWeeks: 6, description: '完成报告初稿，借助多模型流水线进行事实萃取与质量评估。' },
      { title: '成果评审与终稿交付', offsetWeeks: 8, description: '组织专家评审与复核，形成决策洞察并归档最终成果。' },
    ],
  },
  {
    id: 'academic-3',
    name: '实证学术研究三阶段',
    tag: '学术实证',
    desc: '聚焦理论模型推演、实证数据采集分析与论文成稿复核',
    milestones: [
      { title: '理论框架与文献推演', offsetWeeks: 2, description: '文献综述、理论模型推导与核心假说确立。' },
      { title: '实证调研与数据清洗', offsetWeeks: 6, description: '微观问卷与宏观数据搜集，完成计量回归与稳健性检验。' },
      { title: '论文撰写与成果答辩', offsetWeeks: 10, description: '撰写完整学术论文初稿，修改定稿并准备成果汇报。' },
    ],
  },
  {
    id: 'agile-2',
    name: '敏捷专项调研两阶段',
    tag: '快速研判',
    desc: '适用于快速专项调研与应急决策支持任务，周期紧凑高效',
    milestones: [
      { title: '专项材料梳理与痛点剖析', offsetWeeks: 1, description: '快速聚合多源材料，提炼核心矛盾与关键发现。' },
      { title: '深度研判与决策建议输出', offsetWeeks: 2, description: '完成高管速读报告，提炼针对性对策建议。' },
    ],
  },
]

function makeDraftKey() {
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function userInitial(user: SessionUser) {
  return user.avatar || (user.displayName.length <= 2 ? user.displayName : user.displayName.slice(-2))
}

export function memberPickerAtCapacity(maxSelect: number | undefined, selectedCount: number) {
  return maxSelect !== undefined && maxSelect !== 1 && selectedCount >= maxSelect
}

export function nextOwnerIdAfterCurrentUser(input: {
  currentOwnerId: string
  currentUserId?: string
  ownerTouched: boolean
}) {
  if (input.ownerTouched || input.currentOwnerId || !input.currentUserId) return input.currentOwnerId
  return input.currentUserId
}

export function ProjectSetupGuideView({
  users,
  currentUser,
  onProjectCreated,
}: ProjectSetupGuideViewProps) {
  // 步骤索引：0 = 选题与立项, 1 = 团队与协同, 2 = 计划与排期, 3 = 确认与启动
  const [step, setStep] = useState<number>(0)
  const [title, setTitle] = useState('')
  const [objective, setObjective] = useState('')
  const [description, setDescription] = useState('')
  const [ownerId, setOwnerId] = useState<string>(() => currentUser?.id || '')
  const [collaboratorIds, setCollaboratorIds] = useState<string[]>([])
  const ownerTouchedRef = useRef(false)
  const [milestones, setMilestones] = useState<MilestoneDraft[]>(() =>
    PLAN_PRESETS[0].milestones.map((item) => ({
      title: item.title,
      targetDate: dateWeeksFromNow(item.offsetWeeks),
      description: item.description,
      key: makeDraftKey(),
    }))
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [templateNotice, setTemplateNotice] = useState<string | null>(null)
  // 负责人默认为创建者本人；研究员不能指定他人，管理员可以。
  const canChooseOwner = currentUser?.role === 'admin'

  const titleInputRef = useRef<HTMLInputElement>(null)
  const templateNoticeTimerRef = useRef<number | undefined>(undefined)

  // currentUser 可能在组件挂载后才到达（/api/auth/me 异步）：仅首次且用户未编辑时回填。
  useEffect(() => {
    const nextOwnerId = nextOwnerIdAfterCurrentUser({
      currentOwnerId: ownerId,
      currentUserId: currentUser?.id,
      ownerTouched: ownerTouchedRef.current,
    })
    if (nextOwnerId !== ownerId) setOwnerId(nextOwnerId)
  }, [currentUser?.id, ownerId])

  useEffect(() => () => {
    if (templateNoticeTimerRef.current !== undefined) window.clearTimeout(templateNoticeTimerRef.current)
  }, [])

  // 步骤切换焦点
  useEffect(() => {
    if (step !== 0) return
    const timer = window.setTimeout(() => titleInputRef.current?.focus(), 80)
    return () => window.clearTimeout(timer)
  }, [step])

  const selectedOwner = useMemo(
    () => users.find((u) => u.id === ownerId),
    [ownerId, users]
  )
  const selectedCollaborators = useMemo(
    () => collaboratorIds.map((id) => users.find((u) => u.id === id)).filter((u): u is SessionUser => Boolean(u)),
    [collaboratorIds, users]
  )
  // 应用推进计划预设
  function applyPlanPreset(preset: typeof PLAN_PRESETS[number]) {
    setMilestones(
      preset.milestones.map((item) => ({
        title: item.title,
        targetDate: dateWeeksFromNow(item.offsetWeeks),
        description: item.description,
        key: makeDraftKey(),
      }))
    )
    setTemplateNotice(`已应用计划模板「${preset.name}」`)
    if (templateNoticeTimerRef.current !== undefined) window.clearTimeout(templateNoticeTimerRef.current)
    templateNoticeTimerRef.current = window.setTimeout(() => {
      setTemplateNotice(null)
      templateNoticeTimerRef.current = undefined
    }, 3000)
  }

  function addMilestone() {
    setMilestones((prev) => [
      ...prev,
      {
        key: makeDraftKey(),
        title: '',
        targetDate: dateWeeksFromNow(prev.length + 1),
        description: '',
      },
    ])
  }

  function updateMilestone(key: string, patch: Partial<MilestoneDraft>) {
    setMilestones((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)))
  }

  function removeMilestone(key: string) {
    if (milestones.length <= 1) {
      setError('课题至少需要保留一个研究阶段。')
      return
    }
    setMilestones((prev) => prev.filter((item) => item.key !== key))
  }

  function validateStep(target: number): string {
    if (target >= 1 && !title.trim()) return '请先输入课题名称。'
    if (target >= 1 && title.trim().length > 160) return '课题名称不能超过 160 个字。'
    if (target >= 1 && !objective.trim()) return '请填写研究目标与核心问题。'
    if (target >= 1 && !description.trim()) return '请填写研究背景与说明。'
    if (target >= 2 && !ownerId) return '请指定课题负责人。'
    if (target >= 2 && collaboratorIds.length > 3) return '课题协作者不能超过 3 人。'
    if (target >= 3) {
      if (!milestones.length) return '请至少创建一个研究阶段。'
      for (const [index, milestone] of milestones.entries()) {
        if (!milestone.title.trim()) return `请填写阶段 ${index + 1} 的阶段名称。`
        if (!milestone.targetDate?.trim()) return `请为阶段 ${index + 1}「${milestone.title.trim()}」设定计划完成日期。`
        if (!milestone.description.trim()) return `请填写阶段 ${index + 1}「${milestone.title.trim()}」的工作内容与预期成果。`
      }
    }
    return ''
  }

  function goToStep(target: number) {
    const problem = validateStep(target)
    if (problem) {
      setError(problem)
      return
    }
    setError('')
    setStep(target)
  }

  async function handleCreateProject() {
    if (loading) return
    const problem = validateStep(3)
    if (problem) {
      setError(problem)
      return
    }
    setLoading(true)
    setError('')

    const payload = {
      title: title.trim(),
      objective: objective.trim(),
      description: description.trim(),
      ownerId,
      collaboratorIds,
      milestones: milestones.map((item, index): Milestone => ({
        id: `stage-${index + 1}`,
        title: item.title.trim(),
        targetDate: item.targetDate.trim(),
        description: item.description.trim(),
        status: 'not_started',
      })),
    }

    try {
      const response = await apiFetch('/api/projects', {
        method: 'POST',
        headers: mutationHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      })
      const body = (await response.json().catch(() => null)) as {
        project?: ProjectWithCapabilities
        error?: string
      } | null

      if (!response.ok || !body?.project) {
        setError(body?.error ?? '创建课题失败，请检查网络或重试。')
        setLoading(false)
        return
      }

      onProjectCreated(body.project)
    } catch {
      setError('网络连接异常，请稍后重试。')
      setLoading(false)
    }
  }

  const stepsList = [
    { id: 0, title: '选题与立项', sub: '课题名称与核心目标', icon: NotebookPen },
    { id: 1, title: '团队与协同', sub: '负责人与协作者分配', icon: Users },
    { id: 2, title: '计划与排期', sub: '阶段里程碑与日新推进', icon: CalendarRange },
    { id: 3, title: '确认与启动', sub: '全景核对与 AI 赋能就绪', icon: CheckCircle2 },
  ]

  return (
    <div className="space-y-6 pb-12">
      {/* 1. 顶部长廊 Hero Banner */}
      <div className="relative overflow-hidden rounded-lg border border-yx-line bg-gradient-to-br from-yx-paper via-yx-surface to-yx-brand-soft p-6 sm:p-8 shadow-xs">
        {/* 背景光晕装饰 */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full bg-yx-brand/10 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-24 left-1/3 h-64 w-64 rounded-full bg-emerald-500/5 blur-2xl"
        />

        <div className="relative z-10 flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-3xl">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-yx-brand px-3 py-1 text-xs font-bold text-white shadow-xs">
                <Workflow className="h-3.5 w-3.5 text-white" />
                研行 · 课题设立工坊
              </span>
            </div>

            <h2 className="mt-3 text-2xl font-extrabold tracking-tight text-yx-ink sm:text-3xl lg:text-[2rem] lg:leading-tight">
              开启您的第一项 <span className="text-yx-brand">深度研究课题</span>
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-yx-muted">
              规范的开题设计是高质量课题研究的基石，在下方确立课题定位、配置课题组成员并明确推进计划。
            </p>
          </div>
        </div>
      </div>

      {/* 2. 主体工作台：左右联动架构 */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px] xl:grid-cols-[1fr_390px]">
        {/* 左侧：步骤引导与表单工作区 */}
        <div className="flex flex-col rounded-lg border border-yx-line bg-yx-paper shadow-xs overflow-hidden">
          {/* 步骤条指示器 */}
          <div className="border-b border-yx-line bg-yx-surface px-4 py-3 sm:px-6">
            <nav aria-label="开题向导步骤" className="flex items-center justify-between gap-2 overflow-x-auto yx-subtle-scrollbar">
              {stepsList.map((item, index) => {
                const Icon = item.icon
                const isActive = step === item.id
                const isPassed = step > item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => goToStep(item.id)}
                    className={`group flex min-w-0 items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-all ${
                      isActive
                        ? 'bg-yx-paper font-bold text-yx-ink shadow-xs ring-1 ring-black/5'
                        : isPassed
                          ? 'text-yx-ink hover:bg-black/5'
                          : 'text-yx-muted hover:bg-black/5'
                    }`}
                  >
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white transition-all ${
                        isActive
                          ? 'bg-yx-brand shadow-xs'
                          : isPassed
                            ? 'bg-yx-brand-hover'
                            : 'bg-yx-muted'
                      }`}
                    >
                      {isPassed ? <BadgeCheck className="h-4 w-4 text-white" /> : <Icon className="h-3.5 w-3.5 text-white" />}
                    </span>
                    <div className="hidden min-w-0 sm:block">
                      <span className="block text-xs leading-none font-bold">
                        0{index + 1} {item.title}
                      </span>
                      <span className="mt-0.5 block truncate text-[10px] font-normal text-yx-faint">
                        {item.sub}
                      </span>
                    </div>
                  </button>
                )
              })}
            </nav>
          </div>

          {/* 步骤主体内容 */}
          <div className="flex-1 p-6 sm:p-8">
            {/* Step 0: 课题信息与选题定位 */}
            {step === 0 && (
              <section aria-label="课题信息" className="space-y-6">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-yx-brand/10 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-yx-brand-hover">
                      Step 01 · 选题与立项
                    </span>
                  </div>
                  <h3 className="mt-2 text-xl font-extrabold text-yx-ink sm:text-2xl">
                    明确课题名称与核心研究目标
                  </h3>
                  <p className="mt-1 text-xs text-yx-muted">
                    请完整填写课题名称、研究目标与核心问题以及研究背景与说明，这些信息将作为后续报告 AI 评价的重要基准。
                  </p>
                </div>

                {/* 课题名称 */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label htmlFor="guide-project-title" className="text-xs font-bold text-yx-ink">
                      课题名称 <span className="text-yx-brand-hover">*</span>
                    </label>
                    <span className="text-[11px] text-yx-faint tabular-nums">{title.length}/160</span>
                  </div>
                  <Input
                    ref={titleInputRef}
                    id="guide-project-title"
                    inputSize="lg"
                    value={title}
                    maxLength={160}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="例如：低空经济全产业链发展瓶颈与跨域协同政策路径研究"
                  />
                </div>

                {/* 研究目标 & 研究说明 */}
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 pt-2 border-t border-yx-hover">
                  <div>
                    <label htmlFor="guide-project-objective" className="mb-2 block text-xs font-bold text-yx-ink">
                      研究目标与核心问题 <span className="text-yx-brand-hover">*</span>
                    </label>
                    <Textarea
                      id="guide-project-objective"
                      required
                      value={objective}
                      maxLength={2000}
                      rows={4}
                      onChange={(e) => setObjective(e.target.value)}
                      placeholder="用 1-2 句话阐述本课题拟解决的关键痛点、预期核心结论与决策咨询价值…"
                    />
                  </div>

                  <div>
                    <label htmlFor="guide-project-description" className="mb-2 block text-xs font-bold text-yx-ink">
                      研究背景与说明 <span className="text-yx-brand-hover">*</span>
                    </label>
                    <Textarea
                      id="guide-project-description"
                      required
                      value={description}
                      maxLength={5000}
                      rows={4}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="补充行业背景、重点关注方向、数据来源或团队分工约定等…"
                    />
                  </div>
                </div>
              </section>
            )}

            {/* Step 1: 课题团队与协同 */}
            {step === 1 && (
              <section aria-label="研究团队" className="space-y-6">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-yx-brand/10 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-yx-brand-hover">
                      Step 02 · 团队与协同
                    </span>
                  </div>
                  <h3 className="mt-2 text-xl font-extrabold text-yx-ink sm:text-2xl">
                    组建课题组研究团队
                  </h3>
                  <p className="mt-1 text-xs text-yx-muted">
                    课题负责人统筹研究大纲与最终结论，协作者可协同上传报告版本与跟进里程碑。
                  </p>
                </div>

                {/* 负责人选择器 */}
                <UserPickerSection
                  title="课题负责人"
                  requiredMark
                  tag="统筹管理"
                  description={
                    canChooseOwner
                      ? '负责人默认为您本人，管理员可指定其他人；每个课题仅一名负责人。'
                      : '课题负责人默认为您本人，如需变更为其他人请联系管理员。'
                  }
                  users={users}
                  selectedIds={ownerId ? [ownerId] : []}
                  excludeIds={collaboratorIds}
                  maxSelect={1}
                  locked={!canChooseOwner}
                  onChange={(ids) => {
                    ownerTouchedRef.current = true
                    setOwnerId(ids[ids.length - 1] ?? '')
                    setCollaboratorIds((prev) => prev.filter((id) => !ids.includes(id)))
                  }}
                  emptyHint="请指定课题负责人"
                />

                {/* 协作者选择器 */}
                <UserPickerSection
                  title="课题协作者"
                  tag="协同攻关"
                  description="协作者可参与研报初稿上传、数据核验与阶段里程碑推进，最多 3 人。"
                  users={users}
                  selectedIds={collaboratorIds}
                  excludeIds={ownerId ? [ownerId] : []}
                  maxSelect={3}
                  onChange={setCollaboratorIds}
                  emptyHint="可选。如暂无协作者，创建后亦可随时邀请加入"
                />
              </section>
            )}

            {/* Step 2: 研究计划与日新排期 */}
            {step === 2 && (
              <section aria-label="研究计划" className="space-y-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-yx-brand/10 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-yx-brand-hover">
                        Step 03 · 计划与排期
                      </span>
                    </div>
                    <h3 className="mt-2 text-xl font-extrabold text-yx-ink sm:text-2xl">
                      编排研究推进阶段与里程碑
                    </h3>
                    <p className="mt-1 text-xs text-yx-muted">
                      将研究任务拆解为阶段里程碑，将驱动课题专属的「日新」进度看板与交付追踪。
                    </p>
                  </div>
                </div>

                {/* 模板快速套用 */}
                <div className="rounded-lg border border-yx-line bg-yx-surface p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-yx-ink">推荐标准推进流水线模板：</span>
                    <span className="text-[10px] text-yx-muted">点击一键切换</span>
                  </div>
                  <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-3">
                    {PLAN_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => applyPlanPreset(preset)}
                        className="rounded-lg border border-yx-line bg-yx-paper p-2.5 text-left transition-all hover:border-yx-brand hover:shadow-2xs"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-yx-ink">{preset.name}</span>
                          <span className="rounded bg-yx-brand/10 px-1.5 py-0.2 text-[9px] font-semibold text-yx-brand-hover">
                            {preset.tag}
                          </span>
                        </div>
                        <p className="mt-1 text-[10px] text-yx-muted line-clamp-2">{preset.desc}</p>
                      </button>
                    ))}
                  </div>
                  {templateNotice && (
                    <p role="status" className="mt-2 text-[10px] font-semibold text-yx-brand-hover">{templateNotice}</p>
                  )}
                </div>

                {/* 里程碑编辑列表 */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-xs font-bold text-yx-ink">
                    <span>阶段里程碑列表 ({milestones.length} 阶段)</span>
                    <button
                      type="button"
                      onClick={addMilestone}
                      className="flex items-center gap-1 text-yx-brand-hover hover:underline"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>添加阶段</span>
                    </button>
                  </div>

                  {milestones.map((item, index) => (
                    <div
                      key={item.key}
                      className="group relative rounded-lg border border-yx-line bg-yx-paper p-4 shadow-2xs transition-all hover:border-yx-brand/40"
                    >
                      <div className="flex items-start gap-3">
                        <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-yx-brand/10 text-xs font-extrabold text-yx-brand-hover tabular-nums">
                          0{index + 1}
                        </span>
                        <div className="min-w-0 flex-1 space-y-2">
                          <div className="grid min-w-0 grid-cols-1 gap-2.5 sm:grid-cols-[minmax(0,1fr)_165px]">
                            <Input
                              value={item.title}
                              aria-label={`阶段 ${index + 1} 名称（必填）`}
                              required
                              maxLength={120}
                              inputSize="sm"
                              onChange={(e) => updateMilestone(item.key, { title: e.target.value })}
                              placeholder="阶段名称（必填），例如：产业调研与事实数据萃取"
                              className="font-bold"
                            />
                            <Input
                              type="date"
                              required
                              inputSize="sm"
                              value={item.targetDate || ''}
                              onChange={(e) => updateMilestone(item.key, { targetDate: e.target.value })}
                              title="设定计划完成日期（必填）"
                              className="text-xs text-yx-ink tabular-nums"
                            />
                          </div>
                          <Textarea
                            value={item.description}
                            aria-label={`阶段 ${index + 1} 工作内容与预期成果（必填）`}
                            required
                            rows={2}
                            maxLength={300}
                            textareaSize="sm"
                            onChange={(e) => updateMilestone(item.key, { description: e.target.value })}
                            placeholder="工作内容与预期成果（必填），例如：完成政策文件梳理与实证数据初筛…"
                            className="w-full"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => removeMilestone(item.key)}
                          disabled={milestones.length <= 1}
                          aria-label={`删除第 ${index + 1} 阶段`}
                          className="mt-1 rounded-md p-1 text-yx-faint opacity-0 transition-all hover:bg-red-50 hover:text-red-500 focus:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-20"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}

                  {milestones.length < 12 && (
                    <button
                      type="button"
                      onClick={addMilestone}
                      className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-yx-line py-3 text-xs font-semibold text-yx-muted transition-all hover:border-yx-brand/50 hover:bg-yx-brand/5 hover:text-yx-brand-hover"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>追加新的推进阶段</span>
                    </button>
                  )}
                </div>
              </section>
            )}

            {/* Step 3: 全景核对与启动开题 */}
            {step === 3 && (
              <section aria-label="确认创建" className="space-y-6">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-yx-brand/10 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-yx-brand-hover">
                      Step 04 · 确认与启动
                    </span>
                  </div>
                  <h3 className="mt-2 text-xl font-extrabold text-yx-ink sm:text-2xl">
                    核对课题信息并开启研究
                  </h3>
                  <p className="mt-1 text-xs text-yx-muted">
                    立项完成后，系统将自动创建课题空间，您可以立即上传研报初稿并激活 AI 深度研判。
                  </p>
                </div>

                {/* 课题总览卡片 */}
                <div className="overflow-hidden rounded-lg border border-yx-line bg-yx-surface">
                  <div className="border-b border-yx-line bg-gradient-to-br from-emerald-500/[0.08] to-transparent p-5">
                    <span className="text-[10px] font-extrabold uppercase tracking-wider text-yx-brand-hover">
                      研究课题档案
                    </span>
                    <h4 className="mt-1 text-lg font-extrabold text-yx-ink">
                      {title.trim() || '（未输入课题名称）'}
                    </h4>
                    {objective.trim() && (
                      <p className="mt-2 text-xs leading-relaxed text-yx-ink-soft">
                        <strong className="text-yx-ink">研究目标：</strong>
                        {objective.trim()}
                      </p>
                    )}
                  </div>

                  <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
                    <div>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-yx-muted">
                        课题负责人 ({selectedOwner ? 1 : 0})
                      </span>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {selectedOwner && (
                          <span
                            className="inline-flex items-center gap-2 rounded-full border border-yx-brand/30 bg-yx-brand/10 py-1 pl-1 pr-3 text-xs font-bold text-yx-brand-hover"
                          >
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-yx-brand text-[10px] font-bold text-white leading-none">
                              {userInitial(selectedOwner)}
                            </span>
                            <span>{selectedOwner.displayName}</span>
                          </span>
                        )}
                      </div>
                    </div>

                    <div>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-yx-muted">
                        课题协作者 ({selectedCollaborators.length})
                      </span>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {selectedCollaborators.length ? (
                          selectedCollaborators.map((u) => (
                            <span
                              key={u.id}
                              className="inline-flex items-center gap-2 rounded-full border border-yx-line bg-yx-paper py-1 pl-1 pr-3 text-xs font-medium text-yx-ink"
                            >
                              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-black/10 text-[10px] font-bold text-yx-ink-soft leading-none">
                                {userInitial(u)}
                              </span>
                              <span>{u.displayName}</span>
                            </span>
                          ))
                        ) : (
                          <span className="text-xs text-yx-faint">暂未指定协作者</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {milestones.length > 0 && (
                    <div className="border-t border-yx-line bg-yx-paper p-5">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-yx-muted">
                        规划推进阶段 ({milestones.length} 阶段)
                      </span>
                      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {milestones.map((ms, idx) => (
                          <div
                            key={ms.key}
                            className="flex items-start gap-2.5 rounded-lg border border-yx-hover bg-yx-surface p-2.5 text-xs"
                          >
                            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-yx-brand/15 text-[10px] font-bold text-yx-brand-hover">
                              {idx + 1}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-bold text-yx-ink truncate">{ms.title}</span>
                                {ms.targetDate && (
                                  <span className="inline-flex shrink-0 items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 border border-emerald-200/60">
                                    <Calendar className="h-3 w-3 text-emerald-600" />
                                    {ms.targetDate.replace(/-/g, '/')}
                                  </span>
                                )}
                              </div>
                              {ms.description && (
                                <p className="mt-0.5 text-[10px] text-yx-muted line-clamp-1">{ms.description}</p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>


              </section>
            )}

            {/* 错误提示 */}
            {error && (
              <p
                role="alert"
                className="mt-4 rounded-xl border border-orange-200 bg-orange-50 px-4 py-2.5 text-xs font-semibold text-orange-600"
              >
                {error}
              </p>
            )}
          </div>

          {/* 步骤操作底栏 */}
          <div className="flex items-center justify-between border-t border-yx-line bg-yx-surface px-6 py-4">
            <div>
              {step > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    setError('')
                    setStep(step - 1)
                  }}
                  disabled={loading}
                  className="flex items-center gap-1.5 rounded-xl border border-yx-line bg-yx-paper px-4 py-2 text-xs font-bold text-yx-ink shadow-2xs transition-all hover:bg-yx-surface disabled:opacity-50"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  <span>上一步</span>
                </button>
              ) : (
                <span className="text-[11px] text-yx-faint">按照指引完成开题配置</span>
              )}
            </div>

            <div className="flex items-center gap-2.5">
              {step < 3 ? (
                <button
                  type="button"
                  onClick={() => goToStep(step + 1)}
                  className="flex items-center gap-1.5 rounded-xl bg-yx-brand px-6 py-2.5 text-xs font-bold text-white shadow-xs transition-all hover:bg-yx-brand-hover hover:shadow-md"
                >
                  <span>下一步</span>
                  <ArrowRight className="h-3.5 w-3.5 text-white" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleCreateProject}
                  disabled={loading}
                  className="flex items-center gap-2 rounded-xl bg-yx-brand px-7 py-2.5 text-xs font-bold text-white shadow-sm transition-all hover:bg-yx-brand-hover hover:shadow-md disabled:opacity-60"
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin text-white" /> : <Rocket className="h-4 w-4 text-white" />}
                  <span>{loading ? '正在设立课题…' : '设立课题并开启研究'}</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* 右侧：实时立项档案全景看板 Live Preview */}
        <aside className="space-y-5">
          <div className="relative overflow-hidden rounded-lg border border-yx-line bg-yx-paper p-5 shadow-xs">
            <div className="flex items-center justify-between border-b border-yx-hover pb-3">
              <div className="flex items-center gap-2">
                <IconBadge icon={FolderKanban} />
                <div>
                  <h4 className="text-xs font-extrabold text-yx-ink">课题立项卡片预览</h4>
                  <p className="text-[10px] text-yx-faint">所见即所得 · 实时渲染</p>
                </div>
              </div>
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-yx-brand-hover border border-emerald-200">
                就绪中
              </span>
            </div>

            {/* 实时卡片内容 */}
            <div className="mt-4 space-y-3.5">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-yx-faint">课题名称</span>
                <p className={`mt-1 text-sm font-extrabold leading-snug ${title.trim() ? 'text-yx-ink' : 'text-gray-300 italic'}`}>
                  {title.trim() || '尚未输入课题名称…'}
                </p>
              </div>

              {objective.trim() && (
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-yx-faint">研究目标</span>
                  <p className="mt-0.5 text-xs text-yx-ink-soft line-clamp-3 leading-relaxed">
                    {objective.trim()}
                  </p>
                </div>
              )}

              {/* 团队阵容 */}
              <div className="pt-2 border-t border-yx-hover">
                <span className="text-[10px] font-bold uppercase tracking-wider text-yx-faint">课题团队</span>
                <div className="mt-2 flex items-center gap-2">
                  <div className="flex -space-x-2 overflow-hidden">
                    {selectedOwner && (
                      <span
                        title={`负责人: ${selectedOwner.displayName}`}
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-yx-brand text-[11px] font-bold text-white ring-2 ring-white leading-none select-none"
                      >
                        {userInitial(selectedOwner)}
                      </span>
                    )}
                    {selectedCollaborators.map((u) => (
                      <span
                        key={u.id}
                        title={`协作者: ${u.displayName}`}
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-200 text-[11px] font-bold text-yx-ink ring-2 ring-white leading-none select-none"
                      >
                        {userInitial(u)}
                      </span>
                    ))}
                  </div>
                  <div className="text-[11px] text-yx-muted">
                    <span className="font-bold text-yx-ink">{selectedOwner?.displayName ?? '—'}</span> 为负责人
                    {selectedCollaborators.length > 0 && (
                      <> · <span className="font-bold text-yx-ink">{selectedCollaborators.length}</span> 位协作者</>
                    )}
                  </div>
                </div>
              </div>

              {/* 阶段时间轴迷你图 */}
              <div className="pt-2 border-t border-yx-hover">
                <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-yx-faint">
                  <span>推进路线图</span>
                  <span className="text-yx-brand-hover font-bold">{milestones.length} 阶段</span>
                </div>
                <div className="mt-2 space-y-1.5">
                  {milestones.slice(0, 4).map((ms) => (
                    <div key={ms.key} className="flex items-center gap-2 text-[11px]">
                      <span className="h-1.5 w-1.5 rounded-full bg-yx-brand" />
                      <span className="truncate font-medium text-yx-ink flex-1">{ms.title}</span>
                      <span className="text-[10px] text-yx-faint shrink-0">
                        {ms.targetDate ? ms.targetDate.slice(5).replace('-', '/') : ''}
                      </span>
                    </div>
                  ))}
                  {milestones.length > 4 && (
                    <div className="text-[10px] text-yx-faint pl-3.5">
                      + 还有 {milestones.length - 4} 个阶段…
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}

// 成员选择子模块
interface UserPickerSectionProps {
  title: string
  description: string
  tag: string
  users: SessionUser[]
  selectedIds: string[]
  excludeIds: string[]
  onChange: (ids: string[]) => void
  emptyHint: string
  requiredMark?: boolean
  /** 最多可选人数：1 表示单选（负责人），3 为协作者上限。 */
  maxSelect?: number
  /** 锁定后不可增删，仅展示当前选中成员。 */
  locked?: boolean
}

function UserPickerSection({
  title,
  description,
  tag,
  users,
  selectedIds,
  excludeIds,
  onChange,
  emptyHint,
  requiredMark = false,
  maxSelect,
  locked = false,
}: UserPickerSectionProps) {
  const [search, setSearch] = useState('')
  const excluded = useMemo(() => new Set(excludeIds), [excludeIds])
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])
  const atCapacity = memberPickerAtCapacity(maxSelect, selectedIds.length)

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase()
    return users.filter((u) => {
      if (excluded.has(u.id)) return false
      if (!q) return true
      return u.displayName.toLowerCase().includes(q) || u.username.toLowerCase().includes(q)
    })
  }, [users, excluded, search])

  function toggleUser(id: string) {
    if (locked) return
    if (selected.has(id)) {
      onChange(selectedIds.filter((item) => item !== id))
      return
    }
    if (maxSelect === 1) {
      onChange([id])
      return
    }
    if (atCapacity) return
    onChange([...selectedIds, id])
  }

  return (
    <div className="rounded-lg border border-yx-line bg-yx-surface p-4 sm:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h4 className="text-xs font-extrabold text-yx-ink">
              {title}
              {requiredMark && <span className="ml-1 text-yx-brand-hover">*</span>}
            </h4>
            <span className="rounded bg-yx-ink/5 px-2 py-0.2 text-[10px] font-bold text-yx-muted">
              {tag}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-yx-muted">{description}</p>
        </div>

        {/* 搜索框 */}
        <div className="relative w-full sm:w-48">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-yx-faint z-10" />
          <Input
            value={search}
            inputSize="sm"
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索成员姓名/账号…"
            className="pl-8 pr-2.5"
          />
        </div>
      </div>

      {/* 成员网格 */}
      <div className="mt-3.5 grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
        {filteredUsers.map((user) => {
          const isChecked = selected.has(user.id)
          const initial = userInitial(user)
          const disabled = locked || (!isChecked && atCapacity)
          return (
            <button
              key={user.id}
              type="button"
              onClick={() => toggleUser(user.id)}
              disabled={disabled}
              title={disabled && !locked && atCapacity ? `最多选择 ${maxSelect} 位成员` : locked ? '课题负责人仅管理员可调整' : undefined}
              className={`flex items-center gap-2.5 rounded-xl border p-2.5 text-left transition-all ${
                isChecked
                  ? 'border-yx-brand bg-yx-paper shadow-2xs ring-2 ring-yx-brand/15'
                  : 'border-yx-hover bg-white/70 hover:border-yx-brand/40 hover:bg-yx-paper'
              } disabled:cursor-not-allowed ${disabled && !isChecked ? 'opacity-50' : ''}`}
            >
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold leading-none select-none transition-colors ${
                  isChecked ? 'bg-yx-brand text-white' : 'bg-black/5 text-yx-ink-soft'
                }`}
              >
                {user.avatar ? <span className="text-sm">{initial}</span> : initial}
              </span>
              <div className="min-w-0 flex-1">
                <span className="block truncate text-xs font-bold text-yx-ink">
                  {user.displayName}
                </span>
                <span className="block truncate text-[10px] text-yx-faint">
                  @{user.username} · {user.role === 'admin' ? '管理员' : '研究员'}
                </span>
              </div>
              <span
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-all ${
                  isChecked
                    ? 'border-yx-brand bg-yx-brand text-white'
                    : 'border-yx-line text-transparent'
                }`}
              >
                <Check className="h-2.5 w-2.5" />
              </span>
            </button>
          )
        })}
      </div>

      {!filteredUsers.length && (
        <div className="mt-3 rounded-lg bg-yx-paper p-4 text-center text-xs text-yx-faint">
          {users.length ? '未找到符合条件的成员' : '暂无可指派成员'}
        </div>
      )}

      <div className="mt-2.5 text-[11px]">
        {selectedIds.length > 0 ? (
          <span className="font-semibold text-yx-brand-hover">
            已指定 {selectedIds.length}{maxSelect ? `/${maxSelect}` : ''} 位成员
          </span>
        ) : (
          <span className={`${requiredMark ? 'font-semibold text-orange-500' : 'text-yx-faint'}`}>
            {emptyHint}
          </span>
        )}
      </div>
    </div>
  )
}

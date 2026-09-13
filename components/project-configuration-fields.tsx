'use client'

import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { createIdempotencyKey } from '@/lib/workspace-submission'
import { PROJECT_FIELD_LIMITS } from '@/modules/projects/validation'
import { STAGE_FIELD_LIMITS } from '@/modules/projects/stage-domain'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { ConfigurationDraft, ConfigurationStage } from '@/lib/workspace-project-configuration'

export function ProjectConfigurationInfo({ value, onChange }: {
  value: ConfigurationDraft['metadata']; onChange: (value: ConfigurationDraft['metadata']) => void
}) {
  return <div className="space-y-5">
    <div><h3 className="text-base font-bold text-yx-ink">课题核心信息</h3><p className="mt-0.5 text-xs text-yx-muted">修改课题标题、研究立项目标与背景说明。</p></div>
    <div><label htmlFor="configuration-title" className="block text-xs font-bold text-yx-ink">课题标题 <span className="text-rose-500">*</span></label>
      <Input id="configuration-title" required maxLength={PROJECT_FIELD_LIMITS.title} value={value.title} onChange={event => onChange({ ...value, title: event.target.value })} placeholder="请输入课题标题（如：区域产业政策研究）" className="mt-1.5" /></div>
    <div><label htmlFor="configuration-objective" className="block text-xs font-bold text-yx-ink">研究目标与核心问题 <span className="text-rose-500">*</span></label>
      <Textarea id="configuration-objective" rows={3} required maxLength={PROJECT_FIELD_LIMITS.objective} value={value.objective} onChange={event => onChange({ ...value, objective: event.target.value })} placeholder="例如：评估政策补贴对产业链上下游的影响，提出优化资源配置的实证依据与落地对策。" className="mt-1.5" /></div>
    <div><label htmlFor="configuration-description" className="block text-xs font-bold text-yx-ink">研究背景与说明 <span className="text-rose-500">*</span></label>
      <Textarea id="configuration-description" rows={4} required maxLength={PROJECT_FIELD_LIMITS.description} value={value.description} onChange={event => onChange({ ...value, description: event.target.value })} placeholder="补充课题的研究范围、调研对象、关键假设或协同要求。" className="mt-1.5" /></div>
  </div>
}

export function ProjectConfigurationPlan({ stages, frozen, onChange }: {
  stages: ConfigurationStage[]; frozen: boolean; onChange: (stages: ConfigurationStage[]) => void
}) {
  function update(id: string, patch: Partial<ConfigurationStage>) {
    onChange(stages.map(stage => stage.id === id ? { ...stage, ...patch } : stage))
  }
  function move(index: number, destination: number) {
    if (frozen || destination < 0 || destination >= stages.length) return
    const next = [...stages]
    ;[next[index], next[destination]] = [next[destination], next[index]]
    onChange(next)
  }
  return <div className="flex h-full min-h-0 flex-col">
    <div className="shrink-0 border-b border-yx-hover pb-3">
      <h3 className="text-base font-bold text-yx-ink">研究计划与阶段排期</h3>
      <p className="mt-0.5 text-xs text-yx-muted">拆解各研究阶段名称、计划完成日期与核心成果预期。工作内容与日期可留空。</p>
      {frozen && <p className="mt-2 text-xs text-yx-brand">正式提交后阶段结构已冻结；仍可修改名称、工作内容与计划日期。</p>}
    </div>
    <div className="yx-subtle-scrollbar min-h-0 flex-1 space-y-3.5 overflow-y-auto pt-4 pr-1">
      {stages.map((stage, index) => <div key={stage.id} className="rounded-lg border border-yx-line bg-yx-surface p-4 transition-all hover:border-yx-brand/60">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2"><span className="flex h-5.5 w-5.5 items-center justify-center rounded-full bg-yx-brand text-[11px] font-extrabold text-white">{String(index + 1).padStart(2, '0')}</span><span className="text-xs font-bold text-yx-ink">阶段 {index + 1}</span></div>
          <div className="flex items-center gap-2 text-yx-faint">
            <button type="button" aria-label={'上移阶段 ' + (index + 1)} disabled={frozen || index === 0} onClick={() => move(index, index - 1)} className="disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button>
            <button type="button" aria-label={'下移阶段 ' + (index + 1)} disabled={frozen || index === stages.length - 1} onClick={() => move(index, index + 1)} className="disabled:opacity-30"><ArrowDown className="h-4 w-4" /></button>
            <button type="button" aria-label={'删除阶段 ' + (index + 1)} disabled={frozen || stages.length <= 1} onClick={() => { if (!frozen && stages.length > 1) onChange(stages.filter(item => item.id !== stage.id)) }} className="hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-30"><Trash2 className="h-4 w-4" /></button>
          </div>
        </div>
        <div className="mt-3"><Input aria-label={'阶段 ' + (index + 1) + ' 名称'} required maxLength={STAGE_FIELD_LIMITS.title} value={stage.title} onChange={event => update(stage.id, { title: event.target.value })} placeholder="阶段名称（必填）" /></div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-[11px] text-yx-muted">计划开始日期<Input type="date" aria-label={'阶段 ' + (index + 1) + ' 计划开始日期'} value={stage.plannedStartAt || ''} onChange={event => update(stage.id, { plannedStartAt: event.target.value })} className="mt-1" /></label>
          <label className="text-[11px] text-yx-muted">计划完成日期<Input type="date" aria-label={'阶段 ' + (index + 1) + ' 计划完成日期'} value={stage.plannedEndAt || ''} onChange={event => update(stage.id, { plannedEndAt: event.target.value })} className="mt-1" /></label>
        </div>
        <Textarea aria-label={'阶段 ' + (index + 1) + ' 工作内容与预期成果'} rows={2} maxLength={STAGE_FIELD_LIMITS.description} value={stage.description || ''} onChange={event => update(stage.id, { description: event.target.value })} placeholder="本阶段的工作内容与预期成果（选填）" className="mt-3 text-xs" />
      </div>)}
      <button type="button" disabled={frozen || stages.length >= STAGE_FIELD_LIMITS.stages} onClick={() => { if (!frozen && stages.length < STAGE_FIELD_LIMITS.stages) onChange([...stages, { id: 'stage-' + createIdempotencyKey(10), title: '', description: '' }]) }} className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-yx-line py-3 text-xs font-semibold text-yx-muted hover:border-yx-brand hover:text-yx-brand disabled:cursor-not-allowed disabled:opacity-40"><Plus className="h-4 w-4" />新增研究阶段（{stages.length}/{STAGE_FIELD_LIMITS.stages}）</button>
    </div>
  </div>
}

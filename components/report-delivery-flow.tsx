'use client'

import { Check, FileCheck2, Milestone as MilestoneIcon, Rocket } from 'lucide-react'
import { CustomSelect } from '@/components/ui/select'
import type { ReportDeliveryType } from '@/modules/reports/domain'
import type { Milestone } from '@/modules/projects/domain'
import { cx } from '@/lib/cn'

export const DELIVERY_STEPS = [
  { step: 1 as const, label: '选择报告类型', desc: '确定交付成果' },
  { step: 2 as const, label: '确认交付阶段', desc: '选择成果归属' },
  { step: 3 as const, label: '上传报告并归档', desc: '入档并完成推进' },
]

export type DeliveryStep = 1 | 2 | 3

export function expectedCompletedCount(
  milestones: Milestone[],
  selectedId: string,
  deliveryType: ReportDeliveryType,
) {
  const completed = milestones.filter((milestone) => milestone.status === 'completed').length
  const targetAlreadyCompleted = milestones.find((milestone) => milestone.id === selectedId)?.status === 'completed'
  return deliveryType === 'final'
    ? milestones.length
    : Math.min(milestones.length, completed + (targetAlreadyCompleted ? 0 : 1))
}

export function lockedMilestoneMessage(
  milestones: Milestone[],
  selectedId: string,
  deliveryType: ReportDeliveryType,
) {
  if (deliveryType === 'final') return ''
  const targetIdx = milestones.findIndex((milestone) => milestone.id === selectedId)
  if (targetIdx <= 0) return ''
  const previous = milestones[targetIdx - 1]
  if (previous.status === 'completed') return ''
  const current = milestones[targetIdx]
  return '阶段 0' + (targetIdx + 1) + '「' + (current?.title || '') + '」处于锁定状态，需在阶段 0' + targetIdx + '「' + previous.title + '」结项后方可推进。'
}

export function selectDefaultMilestoneId(milestones: Milestone[], preferredId?: string) {
  if (preferredId) {
    const targetIdx = milestones.findIndex((milestone) => milestone.id === preferredId)
    if (targetIdx === 0) return preferredId
    if (targetIdx > 0 && milestones[targetIdx - 1]?.status === 'completed') return preferredId
  }
  const doing = milestones.find((milestone, index) => {
    if (milestone.status !== 'in_progress' && milestone.status !== 'at_risk') return false
    if (index === 0) return true
    return milestones[index - 1]?.status === 'completed'
  })
  if (doing) return doing.id
  const uncompleted = milestones.find((milestone, index) => {
    if (milestone.status === 'completed') return false
    if (index === 0) return true
    return milestones[index - 1]?.status === 'completed'
  })
  return uncompleted?.id || milestones[0]?.id || 'stage-1'
}

export function DeliveryStepIndicator({ currentStep }: { currentStep: DeliveryStep }) {
  return (
    <div className="flex items-center justify-between">
      {DELIVERY_STEPS.map((item) => {
        const isActive = currentStep === item.step
        const isPassed = currentStep > item.step
        return (
          <div
            key={item.step}
            className={cx(
              'flex items-center gap-2.5 transition-colors',
              isActive ? 'text-yx-brand' : isPassed ? 'text-yx-brand-hover' : 'text-yx-faint',
            )}
          >
            <span
              className={cx(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-lg font-mono text-xs font-extrabold transition-all',
                isActive
                  ? 'bg-yx-brand text-white shadow-2xs ring-2 ring-yx-brand/20'
                  : isPassed
                    ? 'bg-yx-brand text-white shadow-2xs'
                    : 'bg-black/5 text-yx-faint',
              )}
            >
              {isPassed ? <Check className="h-3.5 w-3.5 stroke-[3] text-white" /> : '0' + item.step}
            </span>
            <div className="hidden text-left sm:block">
              <span className={cx('block text-xs font-bold leading-tight', isActive ? 'text-yx-brand' : isPassed ? 'text-yx-brand-hover' : 'text-yx-muted')}>
                {item.label}
              </span>
              <span className="block text-[10px] text-yx-faint">{item.desc}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function DeliveryTypePicker({
  value,
  onChange,
}: {
  value: ReportDeliveryType
  onChange: (value: ReportDeliveryType) => void
}) {
  return (
    <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
      <DeliveryTypeCard
        selected={value === 'stage'}
        tone="warning"
        icon={FileCheck2}
        badge="阶段结项"
        title="上传阶段报告"
        description="单个研究阶段的最终成果研报，交付后本阶段标记为已结项。"
        footerLeft="自动开启下一阶段"
        footerRight="完成阶段办结"
        onSelect={() => onChange('stage')}
      />
      <DeliveryTypeCard
        selected={value === 'final'}
        tone="brand"
        icon={Rocket}
        badge="全课题结项"
        title="上传最终报告"
        description="课题终审验收总报告、决策咨询终稿，标志课题全面圆满完成。"
        footerLeft="全流程阶段闭环"
        footerRight="课题结题"
        onSelect={() => onChange('final')}
      />
    </div>
  )
}

function DeliveryTypeCard({
  selected,
  tone,
  icon: Icon,
  badge,
  title,
  description,
  footerLeft,
  footerRight,
  onSelect,
}: {
  selected: boolean
  tone: 'warning' | 'brand'
  icon: typeof FileCheck2
  badge: string
  title: string
  description: string
  footerLeft: string
  footerRight: string
  onSelect: () => void
}) {
  const selectedClass = tone === 'warning'
    ? 'border-yx-warning bg-yx-warning-soft shadow-sm ring-2 ring-yx-warning/25 -translate-y-0.5'
    : 'border-yx-brand bg-yx-brand-soft shadow-sm ring-2 ring-yx-brand/25 -translate-y-0.5'
  const idleClass = tone === 'warning'
    ? 'border-yx-line bg-yx-surface hover:border-yx-warning hover:shadow-xs'
    : 'border-yx-line bg-yx-surface hover:border-yx-brand hover:shadow-xs'
  const iconClass = tone === 'warning' ? 'bg-yx-warning' : 'bg-yx-brand'
  const badgeClass = tone === 'warning'
    ? 'border-yx-warning-soft bg-yx-warning-soft text-yx-warning-text'
    : 'border-yx-brand-soft bg-yx-brand-soft text-yx-brand-hover'
  const footerClass = tone === 'warning' ? 'border-yx-warning/15 text-yx-warning' : 'border-yx-brand/15 text-yx-brand-hover'

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cx(
        'relative flex cursor-pointer flex-col justify-between rounded-lg border-2 p-4.5 text-left select-none transition-all duration-200 active:scale-[0.98]',
        selected ? selectedClass : idleClass,
      )}
    >
      <div>
        <div className="flex items-center justify-between">
          <span className={cx('flex h-9 w-9 items-center justify-center rounded-xl text-white shadow-2xs', iconClass)}>
            <Icon className="h-4.5 w-4.5 text-white" />
          </span>
          <span className={cx('rounded-full border px-2 py-0.5 text-[10px] font-bold', badgeClass)}>{badge}</span>
        </div>
        <h4 className="mt-3.5 text-sm font-bold text-yx-ink">{title}</h4>
        <p className="mt-1 text-[11px] leading-relaxed text-yx-muted">{description}</p>
      </div>
      <div className={cx('mt-4 flex items-center justify-between border-t pt-3 text-[11px] font-semibold', footerClass)}>
        <span>{footerLeft}</span>
        <span className="text-xs">{footerRight}</span>
      </div>
    </div>
  )
}

export function DeliveryMilestoneStep({
  deliveryType,
  milestones,
  selectedMilestoneId,
  expectedCount,
  onChange,
}: {
  deliveryType: ReportDeliveryType
  milestones: Milestone[]
  selectedMilestoneId: string
  expectedCount: number
  onChange: (id: string) => void
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between border-b border-yx-hover pb-2">
        <div>
          <h3 className="text-sm font-extrabold text-yx-ink">
            {deliveryType === 'stage' ? '选择结项阶段' : '确认最终报告归档与全课题结项'}
          </h3>
          <p className="mt-0.5 text-xs text-yx-muted">
            {deliveryType === 'stage'
              ? '选择本次交付成果所对应的具体研究阶段。'
              : '系统将自动将全流程研究阶段闭环并标记课题为已完成。'}
          </p>
        </div>
        <span className="rounded-md bg-yx-brand/10 px-2.5 py-1 text-xs font-bold text-yx-brand-hover">
          交付后完成：{expectedCount}/{milestones.length} 阶段
        </span>
      </div>
      {deliveryType !== 'final' ? (
        <div>
          <label className="mb-1.5 block text-xs font-bold text-yx-ink">
            选择归属研究阶段 <span className="text-yx-danger">*</span>
          </label>
          <CustomSelect
            value={selectedMilestoneId}
            onChange={onChange}
            variant="notion"
            size="sm"
            placeholder="请选择研究阶段…"
            options={milestones.map((milestone, index) => {
              const previous = index > 0 ? milestones[index - 1] : null
              const isLocked = index > 0 && previous?.status !== 'completed'
              return {
                value: milestone.id,
                label: '阶段 0' + (index + 1) + '：' + milestone.title,
                badge: isLocked
                  ? '需先完成上一阶段'
                  : milestone.status === 'completed'
                    ? '已结项'
                    : milestone.status === 'in_progress'
                      ? '进行中'
                      : milestone.status === 'at_risk'
                        ? '存在风险'
                        : '未开始',
                badgeTone: isLocked ? 'gray' as const : milestone.status === 'completed' ? 'emerald' as const : milestone.status === 'in_progress' || milestone.status === 'at_risk' ? 'orange' as const : 'gray' as const,
                disabled: isLocked,
                icon: <MilestoneIcon className="h-3.5 w-3.5 text-yx-brand" />,
              }
            })}
          />
        </div>
      ) : (
        <div className="rounded-lg border border-yx-brand-soft bg-yx-brand-soft p-4">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-yx-brand text-white shadow-2xs">
              <Rocket className="h-3.5 w-3.5 text-white" />
            </span>
            <span className="text-xs font-extrabold text-yx-brand-hover">全课题终稿交付确认</span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-yx-brand-hover">
            最终报告将作为课题全周期的核心交付物，课题所有前序阶段将自动标记为结项，课题状态变更为「已完成」。
          </p>
        </div>
      )}
    </div>
  )
}

export function DeliverySummaryBanner({
  deliveryType,
  milestoneTitle,
  expectedCount,
  totalCount,
}: {
  deliveryType: ReportDeliveryType
  milestoneTitle?: string
  expectedCount: number
  totalCount: number
}) {
  const isStage = deliveryType === 'stage'
  return (
    <div className={cx(
      'flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3.5',
      isStage ? 'border-yx-warning-soft bg-yx-warning-soft' : 'border-yx-brand-soft bg-yx-brand-soft',
    )}>
      <div className="flex items-center gap-2.5">
        <span className={cx('flex h-8 w-8 items-center justify-center rounded-lg text-white shadow-2xs', isStage ? 'bg-yx-warning' : 'bg-yx-brand')}>
          {isStage ? <FileCheck2 className="h-4 w-4 text-white" /> : <Rocket className="h-4 w-4 text-white" />}
        </span>
        <div>
          <span className={cx('text-xs font-extrabold', isStage ? 'text-yx-warning-text' : 'text-yx-brand-hover')}>
            {isStage ? '上传阶段成果报告' : '上传全课题最终报告'}
          </span>
          <span className={cx('ml-2 text-[11px]', isStage ? 'text-yx-warning-text' : 'text-yx-brand-hover')}>
            {isStage ? '→ 归属于「' + (milestoneTitle || '目标阶段') + '」' : '→ 全课题归档并结项'}
          </span>
        </div>
      </div>
      <span className={cx(
        'rounded-full border bg-yx-paper px-2.5 py-0.5 text-[11px] font-bold shadow-2xs',
        isStage ? 'border-yx-warning-soft text-yx-warning-text' : 'border-yx-brand-soft text-yx-brand-hover',
      )}>
        交付后完成：{expectedCount}/{totalCount} 阶段
      </span>
    </div>
  )
}

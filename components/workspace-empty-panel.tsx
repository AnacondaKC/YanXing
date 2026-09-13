'use client'

import { ArrowRight, Clock3, FileText } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button, type ButtonProps } from '@/components/ui/button'
import { EmptyPanelDecoration } from '@/components/ui/card-decoration'

export const workspacePanelChromeClassName = '@container relative flex h-full min-h-0 w-full flex-1 flex-col rounded-lg border border-yx-line bg-yx-paper shadow-xs'
export const workspaceEmptyPanelClassName = workspacePanelChromeClassName + ' overflow-y-auto'

const emptyPanelActionClassName = 'h-11! gap-2! rounded-xl px-5 text-sm! font-semibold! focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-yx-brand'

export function WorkspaceEmptyPanel({
  label,
  title,
  description,
  descriptionRole,
  meta,
  action,
  error,
  preview,
  children,
  layout = 'preview',
}: {
  label: string
  title: string
  description: string
  descriptionRole?: 'status'
  meta?: ReactNode
  action?: ReactNode
  error?: ReactNode
  preview: ReactNode
  children?: ReactNode
  layout?: 'preview' | 'form'
}) {
  return (
    <div className="yx-detail-content flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      <section aria-label={label} className={workspaceEmptyPanelClassName}>
        <EmptyPanelDecoration />
        <div className={layout === 'form'
          ? 'relative z-10 mx-auto my-auto grid w-full max-w-6xl shrink-0 items-center gap-10 px-5 py-8 @min-[480px]:px-8 @min-[960px]:grid-cols-[minmax(0,1fr)_20rem] @min-[960px]:gap-12 @min-[1100px]:px-12'
          : 'relative z-10 mx-auto my-auto grid w-full max-w-6xl shrink-0 items-center gap-8 px-6 py-8 sm:px-10 sm:py-10 @min-[720px]:grid-cols-[minmax(0,1fr)_22.5rem] @min-[720px]:gap-12 @min-[960px]:gap-16 @min-[960px]:px-12'}>
          <div className="min-w-0">
            <h2 className="text-balance text-2xl font-semibold leading-snug tracking-tight text-yx-ink sm:text-[28px]">{title}</h2>
            <p role={descriptionRole} className="mt-4 max-w-md text-pretty text-sm leading-7 text-yx-muted sm:text-[15px]">{description}</p>
            {meta}
            {action ? <div className="mt-7 max-w-md">{action}</div> : null}
            {children ? <div className="mt-7 min-w-0">{children}</div> : null}
            {error}
          </div>
          {layout === 'form' ? <div className="hidden min-w-0 @min-[960px]:block">{preview}</div> : preview}
        </div>
      </section>
    </div>
  )
}

export function EmptyPanelAction({ className = '', children, ...props }: ButtonProps) {
  return (
    <Button size="lg" className={emptyPanelActionClassName + (className ? ' ' + className : '')} {...props}>
      {children}
    </Button>
  )
}

export const emptyPanelPreviewCardClassName = 'flex h-[26.5rem] w-full flex-col overflow-hidden rounded-lg border border-yx-line bg-yx-paper shadow-md'
export const emptyPanelPreviewBodyClassName = 'flex min-h-0 flex-1 flex-col justify-between p-6'

function EmptyPanelPreview({ children }: { children: ReactNode }) {
  return (
    <figure className="flex w-full min-w-0 justify-center border-t border-yx-line pt-7 @min-[720px]:justify-self-stretch @min-[720px]:border-t-0 @min-[720px]:pt-0">
      <div aria-hidden="true" className="relative isolate w-full max-w-[22.5rem]">
        <div className="absolute inset-x-3 top-5 -bottom-2 -z-10 rotate-2 rounded-lg border border-yx-brand-tint bg-yx-brand-soft" />
        <div className={emptyPanelPreviewCardClassName}>
          <div className="h-1 shrink-0 bg-yx-brand" />
          <div className={emptyPanelPreviewBodyClassName}>{children}</div>
        </div>
      </div>
    </figure>
  )
}

function PreviewLine({ className }: { className: string }) {
  return <div className={`rounded-full ${className}`} />
}

export function InsightEmptyPreview() {
  return (
    <EmptyPanelPreview>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-yx-brand">
          <FileText className="h-3.5 w-3.5" />报告简页
        </span>
        <span className="flex items-center gap-1 text-[10px] tabular-nums text-yx-muted">
          <Clock3 className="h-3 w-3" />5-10分钟阅读
        </span>
      </div>
      <p className="mt-5 font-serif text-[22px] font-semibold leading-8 tracking-tight text-yx-ink">报告核心主旨</p>
      <p className="mt-1 text-[10px] tracking-wider text-yx-muted">从论点与论据，读懂报告</p>
      <div className="mt-4 rounded-md border border-yx-brand-tint bg-yx-brand-soft p-3">
        <p className="text-[10px] font-semibold text-yx-brand-strong">主旨提要</p>
        <PreviewLine className="mt-2.5 h-1.5 w-full bg-yx-brand-tint" />
        <PreviewLine className="mt-2 h-1.5 w-4/5 bg-yx-brand-tint" />
      </div>
      <div className="mt-5 grid grid-cols-2 gap-4">
        <div>
          <p className="flex items-center gap-1.5 text-[10px] font-semibold text-yx-ink-soft">
            <span className="h-1 w-1 rounded-full bg-yx-brand" />核心论点
          </p>
          <PreviewLine className="mt-2.5 h-1 w-full bg-yx-line" />
          <PreviewLine className="mt-2 h-1 w-4/5 bg-yx-line" />
          <PreviewLine className="mt-2 h-1 w-3/5 bg-yx-line" />
        </div>
        <div className="border-l border-yx-line pl-4">
          <p className="text-[10px] font-semibold text-yx-ink-soft">关键论据</p>
          <PreviewLine className="mt-2.5 h-1 w-full bg-yx-line" />
          <PreviewLine className="mt-2 h-1 w-3/4 bg-yx-line" />
          <PreviewLine className="mt-2 h-1 w-4/5 bg-yx-line" />
        </div>
      </div>
      <div className="mt-5 border-t border-yx-line pt-3">
        <p className="flex items-center justify-between text-[10px] font-semibold text-yx-ink-soft">
          报告建议<ArrowRight className="h-3 w-3 text-yx-brand" />
        </p>
        <PreviewLine className="mt-2.5 h-1 w-full bg-yx-line" />
        <PreviewLine className="mt-2 h-1 w-3/4 bg-yx-line" />
      </div>
    </EmptyPanelPreview>
  )
}

export function AnalysisEmptyPreview() {
  return (
    <EmptyPanelPreview>
      <p className="text-[10px] font-semibold tracking-wider text-yx-brand">综合研判</p>
      <p className="mt-4 font-serif text-[22px] font-semibold leading-8 tracking-tight text-yx-ink">质量评分</p>
      <p className="mt-1 text-[10px] tracking-wider text-yx-muted">六维评测与图谱</p>
      <div className="mt-4 rounded-md border border-yx-brand-tint bg-yx-brand-soft p-3">
        <p className="text-[10px] font-semibold text-yx-brand-strong">综合得分</p>
        <PreviewLine className="mt-2.5 h-1.5 w-full bg-yx-brand-tint" />
        <PreviewLine className="mt-2 h-1.5 w-2/3 bg-yx-brand-tint" />
      </div>
      <div className="mt-5 space-y-3">
        {['证据质量', '逻辑结构', '政策匹配'].map((label) => (
          <div key={label}>
            <p className="text-[10px] font-semibold text-yx-ink-soft">{label}</p>
            <PreviewLine className="mt-2 h-1 w-full bg-yx-line" />
          </div>
        ))}
      </div>
    </EmptyPanelPreview>
  )
}

export function DocumentEmptyPreview() {
  return (
    <EmptyPanelPreview>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-yx-brand">
          <FileText className="h-3.5 w-3.5" />原始文档
        </span>
        <span className="text-[10px] tabular-nums text-yx-muted">PDF / DOCX</span>
      </div>
      <p className="mt-5 font-serif text-[22px] font-semibold leading-8 tracking-tight text-yx-ink">报告正文</p>
      <p className="mt-1 text-[10px] tracking-wider text-yx-muted">保留完整原文页式阅读</p>
      <div className="mt-4 rounded-md border border-yx-brand-tint bg-yx-brand-soft p-3">
        <p className="text-[10px] font-semibold text-yx-brand-strong">原文节选</p>
        <PreviewLine className="mt-2.5 h-1.5 w-full bg-yx-brand-tint" />
        <PreviewLine className="mt-2 h-1.5 w-11/12 bg-yx-brand-tint" />
        <PreviewLine className="mt-2 h-1.5 w-4/5 bg-yx-brand-tint" />
      </div>
      <div className="mt-5 border-t border-yx-line pt-3">
        <PreviewLine className="h-1 w-full bg-yx-line" />
        <PreviewLine className="mt-2 h-1 w-3/4 bg-yx-line" />
      </div>
    </EmptyPanelPreview>
  )
}

export function HistoryEmptyPreview() {
  return (
    <EmptyPanelPreview>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-yx-brand">
          <Clock3 className="h-3.5 w-3.5" />版本记录
        </span>
        <span className="text-[10px] tabular-nums text-yx-muted">按阶段归档</span>
      </div>
      <p className="mt-5 font-serif text-[22px] font-semibold leading-8 tracking-tight text-yx-ink">提交轨迹</p>
      <p className="mt-1 text-[10px] tracking-wider text-yx-muted">每次完整保留原文</p>
      <div className="mt-4 space-y-2.5">
        {['阶段完结 · V3', '阶段更新 · V2', '开题研究 · V1'].map((label, index) => (
          <div key={label} className={index === 0 ? 'rounded-md border border-yx-brand-tint bg-yx-brand-soft px-3 py-2' : 'rounded-md border border-yx-line px-3 py-2'}>
            <p className={`text-[10px] font-semibold ${index === 0 ? 'text-yx-brand-strong' : 'text-yx-ink-soft'}`}>{label}</p>
            <PreviewLine className={`mt-2 h-1 w-3/4 ${index === 0 ? 'bg-yx-brand-tint' : 'bg-yx-line'}`} />
          </div>
        ))}
      </div>
    </EmptyPanelPreview>
  )
}

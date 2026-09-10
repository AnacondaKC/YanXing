'use client'

import { AlertCircle, ArrowRight, Clock3, FileText, Loader2, Sparkles, Upload } from 'lucide-react'
import type { ProjectTabId } from '@/components/project-executive-header'
import { Button } from '@/components/ui/button'
import { insightEmptyCopy, insightEmptyKind } from '@/lib/insight-empty-state'
import type { ReportVersion } from '@/modules/reports/domain'

interface InsightEmptyStateProps {
  report?: ReportVersion
  canManage: boolean
  canGenerateInsight?: boolean
  generating: boolean
  error: string
  onGenerate: () => void
  onNavigate?: (tab: ProjectTabId) => void
}

export function InsightEmptyState(props: InsightEmptyStateProps) {
  const { report, canManage, canGenerateInsight = true, generating, error, onGenerate } = props
  const copy = insightEmptyCopy(insightEmptyKind(Boolean(report), generating))

  return (
    <div className="yx-detail-content flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      <section aria-label="报告洞察启动面板" className="@container flex h-full min-h-0 w-full flex-1 flex-col overflow-y-auto rounded-lg border border-yx-line bg-yx-paper shadow-xs">
        <div className="mx-auto my-auto grid w-full max-w-6xl shrink-0 items-center gap-8 px-6 py-8 sm:px-10 sm:py-10 @min-[720px]:grid-cols-[minmax(0,1fr)_280px] @min-[720px]:gap-12 @min-[960px]:gap-16 @min-[960px]:px-12">
          <div className="min-w-0">
            <h2 className="text-balance text-2xl font-semibold leading-snug tracking-tight text-yx-ink sm:text-[28px]">
              {copy.lead}
            </h2>
            <p className="mt-4 max-w-md text-pretty text-sm leading-7 text-yx-muted sm:text-[15px]">
              {copy.description}
            </p>
            {report && <InsightReportSource report={report} />}
            <div className="mt-7 max-w-md">
              <InsightEmptyAction {...props} />
            </div>
            {error && (
              <div role="alert" className="mt-5 flex max-w-md flex-wrap items-start gap-2.5 rounded-lg border border-yx-danger bg-yx-danger-soft p-4 text-sm leading-6 text-yx-danger-text">
                <AlertCircle aria-hidden="true" className="mt-1 h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1 break-words">
                  <p className="font-semibold">洞察生成异常</p>
                  <p className="mt-0.5">{error}</p>
                </div>
                {canManage && canGenerateInsight && report && (
                  <Button size="sm" disabled={generating} onClick={onGenerate}>重试</Button>
                )}
              </div>
            )}
          </div>
          <InsightBriefPreview />
        </div>
      </section>
    </div>
  )
}

function InsightReportSource({ report }: { report: ReportVersion }) {
  const reportName = report.fileName || report.title

  return (
    <div className="mt-6 flex max-w-md items-start gap-3 border-l-2 border-yx-brand-tint pl-3.5">
      <FileText aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-yx-muted" />
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 text-xs leading-5 text-yx-muted">
          <span>已选报告</span>
          <span className="font-mono tabular-nums">V{report.version}</span>
        </p>
        <p title={reportName} className="mt-1 line-clamp-2 break-all text-sm leading-6 text-yx-ink-soft">{reportName}</p>
      </div>
    </div>
  )
}

function InsightEmptyAction({ report, canManage, canGenerateInsight = true, generating, onGenerate, onNavigate }: InsightEmptyStateProps) {
  if (report && generating) {
    return (
      <div role="status" className="flex items-start gap-2.5 text-sm leading-6 text-yx-brand-strong">
        <Loader2 aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" />
        <span>正在整理报告简页，完成后将自动进入阅读…</span>
      </div>
    )
  }

  if (!canManage) {
    return (
      <p className="rounded-lg bg-yx-surface px-4 py-3 text-sm leading-6 text-yx-muted">
        {report
          ? '您当前以只读权限查看该课题，暂无生成洞察的权限。请联系课题负责人启动洞察。'
          : '您当前以只读权限查看该课题，暂无可上传报告的权限。请联系课题负责人上传报告后再查看洞察。'}
      </p>
    )
  }

  if (!canGenerateInsight) {
    return <p className="rounded-lg bg-yx-surface px-4 py-3 text-sm leading-6 text-yx-muted">历史报告仅支持查看已经生成的洞察；如需重新生成，请先切换到当前报告版本。</p>
  }

  return (
    <Button size="lg" className="h-11! gap-2! rounded-xl px-5 text-sm! font-semibold! focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-yx-brand" onClick={report ? onGenerate : () => onNavigate?.('dashboard')}>
      {report ? <Sparkles aria-hidden="true" className="h-4 w-4" /> : <Upload aria-hidden="true" className="h-4 w-4" />}
      <span>{report ? '生成洞察' : '前往上传报告'}</span>
      <ArrowRight aria-hidden="true" className="ml-2 h-4 w-4" />
    </Button>
  )
}

function InsightBriefPreview() {
  return (
    <figure className="flex min-w-0 flex-col items-center border-t border-yx-line pt-7 @min-[720px]:border-t-0 @min-[720px]:pt-0">
      <div aria-hidden="true" className="relative isolate w-full max-w-[280px] px-2 pb-3 pt-1">
        <div className="absolute inset-x-4 bottom-1 top-4 -z-10 rotate-2 rounded-lg border border-yx-line bg-yx-surface" />
        <div className="overflow-hidden rounded-lg border border-yx-line bg-yx-paper shadow-md">
          <div className="h-1 bg-yx-brand" />
          <div className="p-5">
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
              <div className="mt-2.5 h-1.5 w-full rounded-full bg-yx-brand-tint" />
              <div className="mt-2 h-1.5 w-4/5 rounded-full bg-yx-brand-tint" />
            </div>
            <div className="mt-5 grid grid-cols-2 gap-4">
              <div>
                <p className="flex items-center gap-1.5 text-[10px] font-semibold text-yx-ink-soft">
                  <span className="h-1 w-1 rounded-full bg-yx-brand" />核心论点
                </p>
                <div className="mt-2.5 h-1 w-full rounded-full bg-yx-line" />
                <div className="mt-2 h-1 w-4/5 rounded-full bg-yx-line" />
                <div className="mt-2 h-1 w-3/5 rounded-full bg-yx-line" />
              </div>
              <div className="border-l border-yx-line pl-4">
                <p className="text-[10px] font-semibold text-yx-ink-soft">关键论据</p>
                <div className="mt-2.5 h-1 w-full rounded-full bg-yx-line" />
                <div className="mt-2 h-1 w-3/4 rounded-full bg-yx-line" />
                <div className="mt-2 h-1 w-4/5 rounded-full bg-yx-line" />
              </div>
            </div>
            <div className="mt-5 border-t border-yx-line pt-3">
              <p className="flex items-center justify-between text-[10px] font-semibold text-yx-ink-soft">
                报告建议<ArrowRight className="h-3 w-3 text-yx-brand" />
              </p>
              <div className="mt-2.5 h-1 w-full rounded-full bg-yx-line" />
              <div className="mt-2 h-1 w-3/4 rounded-full bg-yx-line" />
            </div>
          </div>
        </div>
      </div>
      <figcaption className="mt-4 text-center text-xs leading-5 text-yx-muted">
        报告简页样式示意
        <span className="block text-[10px]">非实际生成内容</span>
      </figcaption>
    </figure>
  )
}

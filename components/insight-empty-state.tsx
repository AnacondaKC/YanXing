'use client'

import { AlertCircle, ArrowRight, FileText, Loader2, Sparkles, Upload } from 'lucide-react'
import type { ProjectTabId } from '@/components/project-executive-header'
import { Button } from '@/components/ui/button'
import { EmptyPanelAction, InsightEmptyPreview, WorkspaceEmptyPanel } from '@/components/workspace-empty-panel'
import { insightEmptyCopy } from '@/lib/insight-empty-state'
import type { WorkspaceReportCard } from '@/lib/workspace-submission'

interface InsightEmptyStateProps {
  report?: Pick<WorkspaceReportCard, 'title' | 'fileName' | 'stageVersion'>
  canManage: boolean
  canGenerateInsight?: boolean
  generating: boolean
  canCancel?: boolean
  error: string
  actionLabel?: string
  onGenerate: () => void
  onCancel?: () => void
  onNavigate?: (tab: ProjectTabId) => void
}

export function InsightEmptyState(props: InsightEmptyStateProps) {
  const { report, canManage, canGenerateInsight = true, generating, error, onGenerate } = props
  const copy = insightEmptyCopy({ report, generating })

  return (
    <WorkspaceEmptyPanel
      label="报告洞察启动面板"
      title={copy.lead}
      description={copy.description}
      meta={report ? <InsightReportSource report={report} /> : undefined}
      action={<InsightEmptyAction {...props} />}
      error={error ? (
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
      ) : undefined}
      preview={<InsightEmptyPreview />}
    />
  )
}

function InsightReportSource({ report }: { report: Pick<WorkspaceReportCard, 'title' | 'fileName' | 'stageVersion'> }) {
  const reportName = report.fileName || report.title

  return (
    <div className="mt-6 flex max-w-md items-start gap-3 border-l-2 border-yx-brand-tint pl-3.5">
      <FileText aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-yx-muted" />
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 text-xs leading-5 text-yx-muted">
          <span>已选报告</span>
          <span className="font-mono tabular-nums">V{report.stageVersion}</span>
        </p>
        <p title={reportName} className="mt-1 line-clamp-2 break-all text-sm leading-6 text-yx-ink-soft">{reportName}</p>
      </div>
    </div>
  )
}

function InsightEmptyAction({
  report,
  canManage,
  canGenerateInsight = true,
  generating,
  canCancel = false,
  actionLabel,
  onGenerate,
  onCancel,
  onNavigate,
}: InsightEmptyStateProps) {
  if (report && generating) {
    return (
      <div className="flex flex-col items-start gap-3">
        <div role="status" className="flex items-start gap-2.5 text-sm leading-6 text-yx-brand-strong">
          <Loader2 aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" />
          <span>正在整理报告简页，完成后将自动进入阅读…</span>
        </div>
        {canCancel ? (
          <Button size="sm" variant="ghost" onClick={onCancel}>停止洞察</Button>
        ) : null}
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
    <EmptyPanelAction onClick={report ? onGenerate : () => onNavigate?.('dashboard')}>
      {report ? <Sparkles aria-hidden="true" className="h-4 w-4" /> : <Upload aria-hidden="true" className="h-4 w-4" />}
      <span>{report ? (actionLabel ?? '生成洞察') : '前往上传报告'}</span>
      <ArrowRight aria-hidden="true" className="ml-2 h-4 w-4" />
    </EmptyPanelAction>
  )
}

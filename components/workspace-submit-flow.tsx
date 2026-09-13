'use client'

import { AlertCircle, CircleCheck, Clock3, FileText, Loader2 } from 'lucide-react'
import { useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogCloseButton, DialogFooter } from '@/components/ui/dialog'
import { FileDropzone } from '@/components/ui/file-dropzone'
import { FormError } from '@/components/ui/field'
import { formatBytes } from '@/lib/format'
import {
  allowedReportKinds,
  duplicateSubmitFormError,
  originProjectIdFromSubmit,
  previewSubmissionImpact,
  submitCloseLabel,
  submitCommitEnabled,
  type WorkspaceReportCard,
  type WorkspaceStageGroup,
  type WorkspaceSubmitImpact,
  type WorkspaceSubmitPhase,
} from '@/lib/workspace-submission'
import type { ReportSubmissionKind } from '@/modules/reports/submission-domain'

export function WorkspaceSubmitDialog({
  groups,
  defaultStageId,
  replacementReport,
  canSubmit,
  phase,
  error,
  onFile,
  onConfigure,
  onPrepare,
  onCommit,
  onRefreshConflict,
  onClose,
  currentProjectId,
}: {
  groups: WorkspaceStageGroup[]
  defaultStageId?: string
  replacementReport?: WorkspaceReportCard
  canSubmit: boolean
  phase: WorkspaceSubmitPhase
  error?: string
  currentProjectId?: string
  onFile: (file: File) => void
  onConfigure: (stageId: string, reportKind: ReportSubmissionKind, impact: WorkspaceSubmitImpact) => void
  onPrepare: () => void
  onCommit: () => void
  onRefreshConflict?: () => void
  onClose: () => void
}) {
  const busy = phase.step === 'preparing' || phase.step === 'submitting'
  const titleRef = useRef<HTMLHeadingElement>(null)
  const fallbackStageId = defaultStageId ?? groups.find((group) => group.canSubmitUpdate || group.canSubmitCompletion)?.stage.id
  const stageId = replacementReport?.stageId ?? ('stageId' in phase && phase.stageId ? phase.stageId : fallbackStageId)
  const selected = groups.find((group) => group.stage.id === stageId)
  const reportKind = replacementReport ? 'completion' : 'reportKind' in phase && phase.reportKind ? phase.reportKind : selected ? allowedReportKinds(selected.stage)[0] : undefined
  const file = 'file' in phase ? phase.file : undefined
  const tokensReady = phase.step !== 'conflict' || phase.tokensReady
  const originProjectId = originProjectIdFromSubmit(phase)
  const onOrigin = !originProjectId || originProjectId === currentProjectId
  const canCommit = submitCommitEnabled(phase, currentProjectId)
  const replacementTargetId = 'command' in phase ? phase.command.expectedCompletionReportId : replacementReport?.id
  const replacementTarget = selected?.reports.find((report) => report.id === replacementTargetId) ?? replacementReport

  function confirmImpact() {
    if (!file || !stageId || !reportKind) return
    onConfigure(stageId, reportKind, previewSubmissionImpact({
      stages: groups.map((group) => group.stage),
      targetStageId: stageId,
      reportKind,
    }))
  }

  if (phase.step === 'acknowledged') return null

  return (
    <Dialog
      onClose={onClose}
      labelledBy="workspace-submit-title"
      describedBy="workspace-submit-description"
      size="lg"
      initialFocusRef={titleRef}
      panelClassName="flex max-h-[calc(100dvh-2rem)] flex-col rounded-xl!"
    >
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-yx-line px-5 py-4 sm:px-6">
        <div className="min-w-0">
          <h2 ref={titleRef} tabIndex={-1} id="workspace-submit-title" className="text-lg font-bold tracking-tight text-yx-ink outline-none">
            {phase.step === 'conflict' ? '请重新确认提交' : phase.step === 'uncertain' ? '提交结果未确认' : replacementReport ? '替换阶段完结报告' : '提交研究报告'}
          </h2>
          <p id="workspace-submit-description" className="mt-1.5 text-xs leading-5 text-yx-muted">
            {phase.step === 'uncertain' || phase.step === 'submitting' ? '正在确认本次提交的结果，请勿重新上传。' : '核对所属阶段与报告类型，解析完成后确认提交。'}
          </p>
        </div>
        <DialogCloseButton onClose={onClose} label={submitCloseLabel(phase)} />
      </header>
      <DialogBody className="min-h-0 space-y-4 overflow-y-auto overscroll-contain sm:px-6">
        {phase.step === 'failed' ? <ReportFileStatus phase={phase} /> : null}
        {replacementTarget ? (
          <div className="rounded-lg border border-yx-line bg-yx-surface p-3 text-sm leading-6 text-yx-ink-soft">
            <p className="font-semibold text-yx-ink">{replacementTarget.labels.reportLabel} · {replacementTarget.title}</p>
            <p>上传新报告以替换该阶段的完结报告。替换后，原报告变为阶段更新报告，原文件及已有分析、洞察保留，课题进度不变。</p>
          </div>
        ) : null}
        {phase.step === 'idle' || phase.step === 'configure' || phase.step === 'failed' ? (
          <FileDropzone file={file} disabled={!canSubmit} busy={false} onFile={onFile} />
        ) : null}
        {file && selected && reportKind ? (
          <section aria-label="报告提交说明" className="space-y-3">
            <p className="text-base leading-8 wrap-anywhere text-yx-ink-soft">
              本次提交的是<strong className="font-semibold text-yx-ink">「{selected.stage.title || selected.stageLabel}」</strong>阶段的<strong className="font-semibold text-yx-brand-strong">{reportKind === 'update' ? '阶段报告' : '完结报告'}</strong>。
            </p>
            <p className="text-xs leading-5 text-yx-muted">
              {reportKind === 'update' ? '用于记录本阶段进展，不会结束本阶段。' : selected.stage.lifecycleStatus === 'completed' ? '本阶段已完成，本次补交或更新完结成果，课题进度不变。' : '作为本阶段完结成果，确认提交后将完成本阶段。'}
            </p>
          </section>
        ) : null}
        {phase.step !== 'failed' ? <ReportFileStatus phase={phase} /> : null}
        {originProjectId && !onOrigin ? (
          <p className="text-sm leading-6 text-yx-warning-text">正在返回原课题后再确认同一提交，请勿重新上传。</p>
        ) : null}
        {phase.step === 'conflict' ? (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-yx-danger bg-yx-danger-soft p-3 text-sm text-yx-danger-text">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              {phase.conflict.error}
              {tokensReady ? ' 请核对最新阶段状态及提交影响，再次确认。' : ' 暂时无法获取最新课题状态，请刷新后再确认。'}
            </p>
          </div>
        ) : null}
        {phase.step === 'uncertain' ? (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-yx-warning bg-yx-warning-soft p-3 text-sm text-yx-warning-text">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>{phase.error} 报告可能已保存，请重试同一提交，无需重新上传或解析。</p>
          </div>
        ) : null}
        {error && !(phase.step === 'failed' && error === phase.error) && !duplicateSubmitFormError(phase, error) ? <FormError>{error}</FormError> : null}
      </DialogBody>
      <DialogFooter className="shrink-0 items-center sm:px-6 [&>button]:h-9 [&>button]:rounded-lg">
        <Button variant="ghost" disabled={busy} onClick={onClose}>{submitCloseLabel(phase)}</Button>
        {phase.step === 'configure' ? (
          <Button disabled={!file || !stageId || !reportKind || busy} onClick={confirmImpact}>核对影响</Button>
        ) : null}
        {phase.step === 'confirm' || phase.step === 'failed' ? (
          <Button disabled={!canSubmit} onClick={onPrepare}>{phase.step === 'failed' ? '重试解析' : '解析文件'}</Button>
        ) : null}
        {phase.step === 'prepared' ? <Button disabled={!canCommit} onClick={onCommit}>{replacementReport ? '确认替换' : '确认提交'}</Button> : null}
        {phase.step === 'conflict' && tokensReady ? <Button disabled={!canCommit} onClick={onCommit}>重新确认提交</Button> : null}
        {phase.step === 'conflict' && !tokensReady ? <Button disabled={busy} onClick={onRefreshConflict}>刷新课题状态</Button> : null}
        {phase.step === 'uncertain' ? <Button disabled={!canCommit} onClick={onCommit}>重试同一提交</Button> : null}
        {busy ? (
          <Button disabled>
            {phase.step === 'submitting' ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : null}
            {phase.step === 'submitting' ? '正在提交…' : replacementReport ? '确认替换' : '确认提交'}
          </Button>
        ) : null}
      </DialogFooter>
    </Dialog>
  )
}

function ReportFileStatus({ phase }: { phase: WorkspaceSubmitPhase }) {
  if (!('file' in phase)) return null
  const parsing = phase.step === 'preparing'
  const failed = phase.step === 'failed'
  const parsed = 'upload' in phase
  const preview = parsed ? phase.upload.preview : undefined
  const StatusIcon = parsing ? Loader2 : failed ? AlertCircle : parsed ? CircleCheck : Clock3
  const title = parsing ? '正在解析文件' : failed ? '报告未提交' : parsed ? '解析完成' : '等待解析'

  return (
    <section aria-label="报告文件与解析状态" className="overflow-hidden rounded-lg border border-yx-line bg-yx-surface/50">
      <div className="flex items-center gap-3 border-b border-dashed border-yx-line px-3.5 py-3">
        <span className="flex h-10 w-9 shrink-0 items-center justify-center rounded-md border border-yx-line bg-yx-paper text-yx-muted">
          <FileText aria-hidden="true" className="h-4.5 w-4.5" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-yx-ink" title={phase.file.name}>{phase.file.name}</p>
          <p className="mt-1 text-[11px] text-yx-muted">{phase.file.name.split('.').pop()?.toUpperCase()} · <span className="font-mono">{formatBytes(phase.file.size)}</span></p>
        </div>
      </div>
      <div role={failed ? 'alert' : 'status'} aria-atomic="true" className="flex items-start gap-2.5 px-3.5 py-3">
        <StatusIcon aria-hidden="true" className={`mt-0.5 h-4 w-4 shrink-0 ${parsing ? 'animate-spin text-yx-brand motion-reduce:animate-none' : failed ? 'text-yx-danger-text' : parsed ? 'text-yx-brand' : 'text-yx-muted'}`} />
        <div className="min-w-0 text-xs leading-5">
          <p className={`font-semibold ${failed ? 'text-yx-danger-text' : parsed || parsing ? 'text-yx-brand-strong' : 'text-yx-ink-soft'}`}>{title}</p>
          <div className="mt-0.5 wrap-anywhere text-yx-muted">
            {parsing ? <p>正在提取报告内容，请稍候。解析完成后即可确认提交。</p> : null}
            {failed ? <><p>{phase.error}</p><p>请重试解析，或更换文件后再试。报告尚未提交。</p></> : null}
            {preview ? <p title={preview.title}><span className="font-mono tabular-nums">{preview.paragraphCount.toLocaleString('zh-CN')}</span> 段落 · <span className="font-mono tabular-nums">{preview.characterCount.toLocaleString('zh-CN')}</span> 字</p> : null}
            {phase.step === 'prepared' ? <p>确认后才会写入课题。</p> : null}
            {!parsing && !failed && !parsed ? <p>文件已选定，解析后可确认提交。</p> : null}
          </div>
        </div>
      </div>
    </section>
  )
}


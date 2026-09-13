'use client'

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '@/components/ui/dialog'
import { Field, FormError } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { isTaskInFlight, reportDeleteBlocked, type WorkspaceReportCard } from '@/lib/workspace-submission'
import type { SubmissionTask } from '@/modules/reports/submission-task-domain'

function reportDeletionBlockedMessage(input: {
  report: WorkspaceReportCard
  analysisTask?: SubmissionTask
  insightTask?: SubmissionTask
}): string {
  const { report, analysisTask, insightTask } = input
  if (!reportDeleteBlocked({ canDelete: report.capabilities.canDelete, analysisTask, insightTask })) return ''

  const reasons = report.capabilities.disabledReasons
  if (reasons.includes('REPORT_WRITE_FORBIDDEN')) return '你没有删除此报告的权限。'
  if (report.isCurrentCompletion || reasons.includes('COMPLETION_REPORT_PROTECTED')) {
    return '当前阶段完结报告不能直接删除，请先替换完结报告。'
  }
  if (isTaskInFlight(analysisTask) || isTaskInFlight(insightTask) || reasons.includes('REPORT_PROCESSING')) {
    return '分析或洞察仍在进行（含取消中），请等待任务结束后再删除。'
  }
  return '当前报告暂不可删除，请刷新后重试。'
}

export function WorkspaceDeleteReportDialog({
  report,
  analysisTask,
  insightTask,
  onClose,
  onDelete,
}: {
  report: WorkspaceReportCard
  analysisTask?: SubmissionTask
  insightTask?: SubmissionTask
  onClose: () => void
  onDelete: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const blockedMessage = reportDeletionBlockedMessage({ report, analysisTask, insightTask })
  const blocked = Boolean(blockedMessage)

  async function submit() {
    if (savingRef.current) return
    const nextReason = reason.trim()
    if (!nextReason) {
      setError('删除报告必须填写原因。')
      return
    }
    if (blocked) {
      setError(blockedMessage)
      return
    }
    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      await onDelete(nextReason)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败。')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <Dialog onClose={onClose} labelledBy="delete-report-title">
      <DialogHeader titleId="delete-report-title" title="删除报告" onClose={onClose} />
      <DialogBody className="space-y-3">
        <p className="text-sm leading-6 text-yx-ink-soft">将逻辑删除 {report.labels.reportLabel}。删除后不可通过替换或改挂阶段恢复，必须填写原因。</p>
        <Field label="删除原因" htmlFor="workspace-delete-report-reason" required>
          <Textarea id="workspace-delete-report-reason" name="reason" value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
        <FormError>{blockedMessage || error}</FormError>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" disabled={saving} onClick={onClose}>取消</Button>
        <Button variant="danger" disabled={saving || blocked} onClick={() => void submit()}>确认删除</Button>
      </DialogFooter>
    </Dialog>
  )
}

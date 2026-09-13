'use client'

import { Upload } from 'lucide-react'
import { useId } from 'react'
import { ReportUploadForm } from '@/components/report-upload-form'
import { Dialog, DialogBody, DialogHeader } from '@/components/ui/dialog'
import type { FirstReportDraft } from '@/components/first-report-draft'
import type { WorkspaceProjectDetail } from '@/lib/workspace-submission'

interface WorkspaceUpdateReportDialogProps {
  detail: WorkspaceProjectDetail
  onSubmit: (draft: FirstReportDraft) => void
  onClose: () => void
}

export function WorkspaceUpdateReportDialog({ detail, onSubmit, onClose }: WorkspaceUpdateReportDialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  return (
    <Dialog onClose={onClose} labelledBy={titleId} describedBy={descriptionId} size="xl" panelClassName="flex max-h-[calc(100dvh-2rem)] flex-col">
      <DialogHeader titleId={titleId} title="更新报告" icon={Upload} onClose={onClose} />
      <DialogBody className="yx-subtle-scrollbar min-h-0 overflow-y-auto">
        <p id={descriptionId} className="mb-6 text-sm leading-6 text-yx-muted">选择报告所属阶段和类型，上传本次完整报告以更新研究进展。已有报告及分析结果将保留。</p>
        <ReportUploadForm detail={detail} onSubmit={onSubmit} />
      </DialogBody>
    </Dialog>
  )
}

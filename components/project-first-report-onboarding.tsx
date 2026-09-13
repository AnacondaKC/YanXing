'use client'

import { AnalysisEmptyPreview, WorkspaceEmptyPanel } from '@/components/workspace-empty-panel'
import { ReportUploadForm } from '@/components/report-upload-form'
import type { FirstReportDraft } from '@/components/first-report-draft'
import type { WorkspaceProjectDetail } from '@/lib/workspace-submission'

export type { FirstReportDraft } from '@/components/first-report-draft'

interface ProjectFirstReportOnboardingProps {
  detail: WorkspaceProjectDetail
  onSubmit: (draft: FirstReportDraft) => void
  onResumeSubmit?: () => void
}

export function ProjectFirstReportOnboarding(props: ProjectFirstReportOnboardingProps) {
  const firstSubmission = props.detail.project.submittedReportCount === 0
  return (
    <WorkspaceEmptyPanel
      label="研究报告交付引导"
      title={firstSubmission ? '上传首版交付报告' : '本阶段暂无报告'}
      description="选择报告所属阶段和类型，上传本次完整报告。"
      preview={<AnalysisEmptyPreview />}
      layout="form"
    >
      <ReportUploadForm {...props} />
    </WorkspaceEmptyPanel>
  )
}

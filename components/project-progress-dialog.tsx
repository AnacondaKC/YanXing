'use client'

import { ChevronLeft, ChevronRight, FileText, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogCloseButton } from '@/components/ui/dialog'
import { FileDropzone, reportFileContentType } from '@/components/ui/file-dropzone'
import { FormError } from '@/components/ui/field'
import { CustomSelect } from '@/components/ui/select'
import {
  DeliveryMilestoneStep,
  DeliveryStepIndicator,
  DeliverySummaryBanner,
  DeliveryTypePicker,
  expectedCompletedCount,
  lockedMilestoneMessage,
  selectDefaultMilestoneId,
  type DeliveryStep,
} from '@/components/report-delivery-flow'
import { apiFetch, fetchAllPages, mutationHeaders } from '@/lib/client-request'
import type { Milestone, ProjectWithCapabilities } from '@/modules/projects/domain'
import type { ReportHistoryEntry, ReportVersion } from '@/modules/reports/domain'
import type { ReportDeliveryType } from '@/modules/reports/domain'

export function ProjectProgressDialog({
  project,
  defaultMilestoneId,
  onClose,
  onSaved,
  onReportUploaded,
  onReportAssigned,
  viewGeneration,
}: {
  project: ProjectWithCapabilities
  defaultMilestoneId?: string
  onClose: () => void
  onSaved: (project: ProjectWithCapabilities) => void
  onReportUploaded?: (report: ReportVersion, submitted: { projectId: string; viewGeneration: number }) => void
  onReportAssigned?: (report: ReportVersion) => void
  viewGeneration: number
}) {
  const [currentStep, setCurrentStep] = useState<DeliveryStep>(1)
  const [deliveryType, setDeliveryType] = useState<ReportDeliveryType>('stage')
  const [milestones] = useState<Milestone[]>(() => project.milestones.map((milestone) => ({ ...milestone })))
  const [selectedMilestoneId, setSelectedMilestoneId] = useState(() => selectDefaultMilestoneId(
    project.milestones && project.milestones.length > 0 ? project.milestones : [],
    defaultMilestoneId,
  ))
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [selectedExistingReportId, setSelectedExistingReportId] = useState('')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [reports, setReports] = useState<ReportHistoryEntry[]>([])

  useEffect(() => {
    const controller = new AbortController()
    fetchAllPages<ReportHistoryEntry>(
      '/api/projects/' + project.id + '/reports/history',
      'entries',
      { cache: 'no-store', signal: controller.signal },
    ).then((result) => setReports(result.items)).catch(() => {})
    return () => controller.abort()
  }, [project.id])

  const targetMs = milestones.find((milestone) => milestone.id === selectedMilestoneId) || milestones[0]
  const expectedCount = expectedCompletedCount(milestones, selectedMilestoneId, deliveryType)
  const completedMilestoneCount = milestones.filter((milestone) => milestone.status === 'completed').length

  function goToStep2() {
    if (milestones.length === 0) {
      setError('课题尚未配置研究阶段，请先编辑课题并保存阶段计划。')
      return
    }
    setError('')
    if (deliveryType === 'final') {
      const last = milestones[milestones.length - 1]
      if (last) setSelectedMilestoneId(last.id)
    }
    setCurrentStep(2)
  }

  function goToStep3() {
    const message = lockedMilestoneMessage(milestones, selectedMilestoneId, deliveryType)
    if (message) {
      setError(message)
      return
    }
    setError('')
    setCurrentStep(3)
  }

  async function handleExecuteSubmit() {
    const message = lockedMilestoneMessage(milestones, selectedMilestoneId, deliveryType)
    if (message) {
      setError(message.replace('方可推进。', '方可保存。'))
      return
    }
    if (!selectedFile && !selectedExistingReportId) {
      setError('请先选择或拖拽上传报告文档（.docx / .pdf）。')
      return
    }
    const submitted = { projectId: project.id, viewGeneration }
    setUploading(true)
    setError('')
    try {
      let uploadedReport: ReportVersion | undefined
      let assignedReport: ReportVersion | undefined
      let nextProject: ProjectWithCapabilities | undefined
      if (selectedFile) {
        const response = await apiFetch('/api/projects/' + project.id + '/reports', {
          method: 'POST',
          headers: {
            'Content-Type': reportFileContentType(selectedFile.name),
            'X-File-Name': encodeURIComponent(selectedFile.name),
            'X-Milestone-Id': encodeURIComponent(selectedMilestoneId),
            'X-Report-Delivery-Type': deliveryType,
            ...mutationHeaders(),
          },
          body: selectedFile,
        }).catch(() => null)
        const body = (await response?.json().catch(() => null)) as {
          error?: string
          report?: ReportVersion
          project?: ProjectWithCapabilities
        } | null
        if (!response?.ok || !body?.report) {
          setError(body?.error ?? '报告上传失败，请重试。')
          return
        }
        uploadedReport = body.report
        nextProject = body.project
      } else {
        const associationResponse = await apiFetch('/api/reports/' + selectedExistingReportId, {
          method: 'PATCH',
          headers: mutationHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ milestoneId: selectedMilestoneId, deliveryType }),
        }).catch(() => null)
        const associationBody = (await associationResponse?.json().catch(() => null)) as {
          error?: string
          report?: ReportVersion
          project?: ProjectWithCapabilities
        } | null
        if (!associationResponse?.ok || !associationBody?.report) {
          setError(associationBody?.error ?? '更新报告所属阶段失败。')
          return
        }
        assignedReport = associationBody.report
        nextProject = associationBody.project
      }
      if (!nextProject) {
        setError('课题进度更新失败，请刷新后重试。')
        return
      }
      if (uploadedReport && onReportUploaded) onReportUploaded(uploadedReport, submitted)
      if (assignedReport && onReportAssigned) onReportAssigned(assignedReport)
      onSaved(nextProject)
    } catch {
      setError('操作异常，请检查网络后重试。')
    } finally {
      setUploading(false)
    }
  }

  const closeIfIdle = () => { if (!uploading) onClose() }

  return (
    <Dialog
      onClose={closeIfIdle}
      labelledBy="project-progress-title"
      size="3xl"
      zIndex={70}
      panelClassName="flex h-[min(54rem,calc(100vh-2rem))] flex-col"
    >
      <div className="flex min-h-0 flex-1 flex-col justify-between">
        <div className="shrink-0 border-b border-yx-line bg-yx-surface px-6 py-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-yx-brand text-white shadow-2xs">
                <Upload className="h-5 w-5 text-white" />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 id="project-progress-title" className="text-base font-extrabold tracking-tight text-yx-ink">
                    更新进展 · 成果交付引导
                  </h2>
                  <span className="rounded-full border border-yx-brand/20 bg-yx-brand/10 px-2.5 py-0.5 font-mono text-[11px] font-bold text-yx-brand-hover">
                    已完成 {completedMilestoneCount}/{milestones.length} 阶段
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-yx-muted">
                  围绕报告上传推进研究生命周期，支持阶段结项与终稿归档。
                </p>
              </div>
            </div>
            <DialogCloseButton onClose={closeIfIdle} disabled={uploading} label="关闭进展弹窗" className="h-8 w-8" />
          </div>
          <div className="mt-4 border-t border-yx-hover pt-3">
            <DeliveryStepIndicator currentStep={currentStep} />
          </div>
        </div>

        <div className="yx-subtle-scrollbar min-h-0 flex-1 overflow-y-auto p-6">
          {currentStep === 1 && (
            <div className="space-y-4">
              <div className="border-b border-yx-hover pb-2">
                <h3 className="text-sm font-extrabold text-yx-ink">请选择本次上传报告的类型</h3>
                <p className="mt-0.5 text-xs text-yx-muted">系统将根据报告类型完成阶段结项或全课题归档。</p>
              </div>
              <DeliveryTypePicker value={deliveryType} onChange={setDeliveryType} />
            </div>
          )}
          {currentStep === 2 && (
            <DeliveryMilestoneStep
              deliveryType={deliveryType}
              milestones={milestones}
              selectedMilestoneId={selectedMilestoneId}
              expectedCount={expectedCount}
              onChange={(value) => { setSelectedMilestoneId(value); setError('') }}
            />
          )}
          {currentStep === 3 && (
            <div className="space-y-4">
              <DeliverySummaryBanner
                deliveryType={deliveryType}
                milestoneTitle={targetMs?.title}
                expectedCount={expectedCount}
                totalCount={milestones.length}
              />
              <FileDropzone
                file={selectedFile}
                disabled={uploading}
                onFile={(file) => {
                  setSelectedFile(file)
                  setSelectedExistingReportId('')
                  setError('')
                }}
                onInvalid={setError}
              />
              {reports.length > 0 && !selectedFile ? (
                <div className="border-t border-yx-hover pt-2">
                  <span className="mb-1.5 block text-[11px] font-semibold text-yx-muted">
                    或选择课题已上传的报告版本直接推进：
                  </span>
                  <CustomSelect
                    value={selectedExistingReportId}
                    onChange={(value) => {
                      setSelectedExistingReportId(value)
                      setSelectedFile(null)
                      setError('')
                    }}
                    size="sm"
                    variant="notion"
                    placeholder="从已有历史报告中选择一份…"
                    options={reports.map((entry) => ({
                      value: entry.report.id,
                      label: entry.report.title || entry.report.fileName,
                      badge: 'V' + entry.report.version,
                      badgeTone: 'emerald' as const,
                      icon: <FileText className="h-3.5 w-3.5 text-yx-brand" />,
                    }))}
                  />
                </div>
              ) : null}
            </div>
          )}
        </div>

        {error ? <FormError className="mx-6 mb-2">{error}</FormError> : null}

        <div className="flex shrink-0 items-center justify-between border-t border-yx-line bg-yx-surface px-6 py-4">
          <div>
            {currentStep > 1 ? (
              <Button
                variant="outline"
                disabled={uploading}
                onClick={() => {
                  setError('')
                  setCurrentStep((step) => (step === 3 ? 2 : 1))
                }}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                上一步
              </Button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={closeIfIdle} disabled={uploading}>取消</Button>
            {currentStep === 1 ? (
              <Button size="lg" onClick={goToStep2}>
                下一步: 确认交付阶段
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            ) : null}
            {currentStep === 2 ? (
              <Button size="lg" onClick={goToStep3}>
                下一步: 上传报告文档
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            ) : null}
            {currentStep === 3 ? (
              <Button size="lg" disabled={!selectedFile && !selectedExistingReportId} loading={uploading} onClick={handleExecuteSubmit}>
                {uploading ? '正在上传并更新进展…' : '确认上传并推进课题'}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </Dialog>
  )
}

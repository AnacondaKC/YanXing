'use client'

import { ChevronLeft, ChevronRight, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { FileDropzone, reportFileContentType } from '@/components/ui/file-dropzone'
import { FormError } from '@/components/ui/field'
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
import { apiFetch, mutationHeaders } from '@/lib/client-request'
import type { Milestone, ProjectWithCapabilities } from '@/modules/projects/domain'
import type { ReportVersion } from '@/modules/reports/domain'
import type { ReportDeliveryType } from '@/modules/reports/domain'

export function ProjectFirstReportOnboarding({
  project,
  canManage,
  analyzing,
  viewGeneration,
  onReportUploaded,
  onProjectUpdated,
}: {
  project?: ProjectWithCapabilities
  canManage: boolean
  analyzing: boolean
  viewGeneration: number
  onReportUploaded?: (report: ReportVersion, submitted: { projectId: string; viewGeneration: number }) => void
  onProjectUpdated?: (project: ProjectWithCapabilities) => void
}) {
  const [currentStep, setCurrentStep] = useState<DeliveryStep>(1)
  const [deliveryType, setDeliveryType] = useState<ReportDeliveryType>('stage')
  const milestones: Milestone[] = useMemo(
    () => (project?.milestones ?? []).map((milestone) => ({ ...milestone })),
    [project?.milestones],
  )
  const [selectedMilestoneId, setSelectedMilestoneId] = useState(() => selectDefaultMilestoneId(project?.milestones ?? []))
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const targetMs = milestones.find((milestone) => milestone.id === selectedMilestoneId) || milestones[0]
  const expectedCount = expectedCompletedCount(milestones, selectedMilestoneId, deliveryType)
  const isWorking = analyzing || submitting

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
    if (!project) return
    setError('')
    if (!selectedFile) {
      setError('请先选择或拖拽上传首份报告文档（.docx / .pdf）。')
      return
    }
    const submitted = { projectId: project.id, viewGeneration }
    setSubmitting(true)
    try {
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
      if (body.project && onProjectUpdated) onProjectUpdated(body.project)
      if (onReportUploaded) onReportUploaded(body.report, submitted)
    } catch {
      setError('操作异常，请检查网络后重试。')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col justify-center py-2">
      <div className="relative w-full overflow-hidden rounded-lg border border-yx-line bg-yx-paper p-6 shadow-xs sm:p-10 lg:p-12">
        <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-yx-brand/8 blur-3xl" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-24 -left-20 h-80 w-80 rounded-full bg-yx-brand/5 blur-2xl" />
        <div className="relative z-10 flex flex-col items-center text-center">
          <div className="inline-flex items-center gap-2 rounded-full bg-yx-brand px-4 py-1.5 text-xs font-bold text-white shadow-2xs">
            <Sparkles className="h-3.5 w-3.5 text-white" />
            <span>课题立项已就绪 · 首版研究报告交付引导</span>
          </div>
          <h2 className="mt-4 text-2xl font-extrabold tracking-tight text-yx-ink sm:text-3xl lg:text-4xl">
            开启研究生命周期 · <span className="text-yx-brand">上传首版交付报告</span>
          </h2>
          <p className="mx-auto mt-2 max-w-2xl text-xs leading-relaxed text-yx-muted sm:text-sm">
            支持选择成果交付类型，系统将自动关联对应研究阶段；归档完成后可启动全维 AI 学术质量研判。
          </p>
          <div className="mt-5 w-full max-w-xl border-b border-t border-yx-hover py-2.5">
            <DeliveryStepIndicator currentStep={currentStep} />
          </div>
          <div className="mt-3.5 w-full max-w-2xl text-left">
            {currentStep === 1 && (
              <div className="space-y-4">
                <DeliveryTypePicker value={deliveryType} onChange={setDeliveryType} />
                <div className="flex justify-end pt-3">
                  <Button size="lg" className="rounded-xl px-6" onClick={goToStep2}>
                    <span>下一步: 确认交付阶段</span>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )}
            {currentStep === 2 && (
              <div className="space-y-4">
                <DeliveryMilestoneStep
                  deliveryType={deliveryType}
                  milestones={milestones}
                  selectedMilestoneId={selectedMilestoneId}
                  expectedCount={expectedCount}
                  onChange={(value) => { setSelectedMilestoneId(value); setError('') }}
                />
                <div className="flex items-center justify-between pt-3">
                  <Button variant="outline" className="rounded-xl" onClick={() => { setError(''); setCurrentStep(1) }}>
                    <ChevronLeft className="h-3.5 w-3.5" />
                    上一步
                  </Button>
                  <Button size="lg" className="rounded-xl px-6" onClick={goToStep3}>
                    <span>下一步: 上传报告文档</span>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )}
            {currentStep === 3 && (
              <div className="space-y-4">
                <DeliverySummaryBanner
                  deliveryType={deliveryType}
                  milestoneTitle={targetMs?.title}
                  expectedCount={expectedCount}
                  totalCount={milestones.length}
                />
                {canManage ? (
                  <div>
                    <FileDropzone
                      file={selectedFile}
                      disabled={isWorking}
                      onFile={(file) => { setSelectedFile(file); setError('') }}
                      onInvalid={setError}
                    />
                    <div className="mt-4 flex items-center justify-between">
                      <Button variant="outline" className="rounded-xl" disabled={isWorking} onClick={() => { setError(''); setCurrentStep(2) }}>
                        <ChevronLeft className="h-3.5 w-3.5" />
                        上一步
                      </Button>
                      <Button size="lg" className="rounded-xl px-7" disabled={!selectedFile} loading={isWorking} onClick={handleExecuteSubmit}>
                        {isWorking ? '正在上传并更新课题…' : '确认上传并完成课题推进'}
                      </Button>
                    </div>
                    {isWorking ? (
                      <div className="mt-4 flex items-center justify-center gap-2 rounded-full border border-yx-brand-tint bg-yx-brand-soft px-5 py-2 text-xs font-bold text-yx-brand-strong">
                        <span className="h-2 w-2 animate-ping rounded-full bg-yx-brand" />
                        <span>正在全速解析并生成六维研判与知识导图，完成后将自动进入全景看板…</span>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="rounded-lg border border-yx-warning-soft bg-yx-warning-soft p-4 text-xs text-yx-warning-text">
                    您当前以只读权限查看该课题，暂无可上传新版本的权限。请联系课题负责人上传首版报告。
                  </div>
                )}
              </div>
            )}
          </div>
          {error ? <FormError className="mt-4 w-full max-w-2xl text-left">{error}</FormError> : null}
          <div className="mt-10 grid w-full grid-cols-1 gap-4 text-left sm:grid-cols-3">
            {[
              { n: '1', title: '章节解构与过程萃取', text: '自动解析正文大纲、事实证据链、图表引用与字符量化指标。', tone: 'warning' as const },
              { n: '2', title: '六维学术价值研判', text: '严谨评测理论支撑、逻辑自洽、论据充实与落地可行性雷达得分。', tone: 'warning' as const },
              { n: '3', title: '思维导图与终稿速读', text: '全自动生成层次化知识思维导图、高频词云与 5 分钟高管决策速读。', tone: 'brand' as const },
            ].map((card) => (
              <div key={card.n} className="rounded-lg border border-yx-line bg-yx-paper p-5 shadow-2xs transition-colors hover:border-yx-brand-tint">
                <div className="flex items-center gap-2.5">
                  <span className={'flex h-7 w-7 items-center justify-center rounded-lg text-xs font-bold text-white shadow-2xs ' + (card.tone === 'brand' ? 'bg-yx-brand' : 'bg-yx-warning')}>
                    {card.n}
                  </span>
                  <h4 className="text-xs font-bold text-yx-ink sm:text-sm">{card.title}</h4>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-yx-muted">{card.text}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

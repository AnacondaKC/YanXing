'use client'

import { ChevronRight, Info, Upload, X } from 'lucide-react'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { FileDropzone } from '@/components/ui/file-dropzone'
import { FormError } from '@/components/ui/field'
import { CustomSelect } from '@/components/ui/select'
import { createFirstReportDraft, reconcileFirstReportDraft, selectFirstReportStage, type FirstReportDraft } from '@/components/first-report-draft'
import { allowedReportKinds, previewSubmissionImpact, SKIPPED_EMPTY_COPY, type WorkspaceProjectDetail } from '@/lib/workspace-submission'
import type { ReportSubmissionKind } from '@/modules/reports/submission-domain'

interface ReportUploadFormProps {
  detail: WorkspaceProjectDetail
  onSubmit: (draft: FirstReportDraft) => void
  onResumeSubmit?: () => void
}

const fieldLabelClass = 'text-sm font-semibold text-yx-ink'
const reportTypeOptions = [
  { value: 'update', label: '阶段报告' },
  { value: 'completion', label: '完结报告' },
] as const

function ReportKindSelector({ value, availableKinds, description, onChange }: {
  value?: ReportSubmissionKind
  availableKinds: ReportSubmissionKind[]
  description: string
  onChange: (kind: ReportSubmissionKind) => void
}) {
  const id = useId()
  const selectedIndex = value === 'completion' ? 1 : value === 'update' ? 0 : -1
  return (
    <fieldset className="min-w-0" aria-label="本次报告类型" aria-describedby={id + '-hint'}>
      <legend className={fieldLabelClass}>报告类型</legend>
      <div className="relative isolate mt-2 grid h-[42px] grid-cols-2 rounded-full bg-yx-hover p-1">
        {selectedIndex >= 0 ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-full bg-yx-paper shadow-sm ring-1 ring-black/[0.05] transition-transform duration-200 ease-out motion-reduce:transition-none"
            style={{ transform: selectedIndex === 1 ? 'translateX(100%)' : 'translateX(0)' }}
          />
        ) : null}
        {reportTypeOptions.map(option => (
          <label key={option.value} className="relative z-10 min-w-0">
            <input
              type="radio"
              name={id}
              value={option.value}
              checked={value === option.value}
              disabled={!availableKinds.includes(option.value)}
              onChange={() => onChange(option.value)}
              className="peer sr-only"
            />
            <span className="flex h-full cursor-pointer items-center justify-center rounded-full px-2 text-sm font-medium text-yx-muted transition-colors hover:text-yx-ink peer-checked:font-semibold peer-checked:text-yx-brand-strong peer-checked:hover:text-yx-brand-strong peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-yx-brand peer-disabled:cursor-not-allowed peer-disabled:opacity-40 motion-reduce:transition-none">
              {option.label}
            </span>
          </label>
        ))}
      </div>
      <p id={id + '-hint'} className="mt-2 text-xs leading-5 text-yx-muted" aria-live="polite">{description}</p>
    </fieldset>
  )
}

export function ReportUploadForm({ detail, onSubmit, onResumeSubmit }: ReportUploadFormProps) {
  const stageSelectId = useId()
  const [savedDraft, setDraft] = useState(() => createFirstReportDraft(detail))
  const [error, setError] = useState('')
  const draft = reconcileFirstReportDraft(savedDraft, detail.stages)
  if (draft !== savedDraft) setDraft(draft)

  const { stageId, reportKind, file } = draft
  const group = detail.stages.find(item => item.stage.id === stageId)
  const canWrite = detail.project.canSubmit
  const kinds = group ? allowedReportKinds(group.stage).filter(kind => canWrite && (kind === 'update' ? group.canSubmitUpdate : group.canSubmitCompletion)) : []
  const canSubmit = Boolean(reportKind && kinds.includes(reportKind))
  const canSelectFile = canWrite && Boolean(group && (group.canSubmitUpdate || group.canSubmitCompletion))
  const impact = group && reportKind ? previewSubmissionImpact({ stages: detail.stages.map(item => item.stage), targetStageId: stageId, reportKind }) : undefined
  const stageCompleted = group?.stage.lifecycleStatus === 'completed'
  const kindDescription = stageCompleted
    ? '该阶段已完成，仅支持补交或更新完结报告，不回退课题进度。'
    : reportKind === 'completion'
      ? '作为本阶段完结成果，确认提交后完成该阶段。'
      : reportKind === 'update'
        ? '记录阶段进展，不结束所选阶段。'
        : '请选择本次报告的类型。'

  function chooseStage(nextStageId: string) {
    const nextGroup = detail.stages.find(item => item.stage.id === nextStageId)
    if (!canWrite || !nextGroup || (!nextGroup.canSubmitUpdate && !nextGroup.canSubmitCompletion)) return
    setDraft(current => selectFirstReportStage(current, nextGroup))
    setError('')
  }

  function chooseKind(kind: ReportSubmissionKind) {
    if (!kinds.includes(kind)) return
    setDraft(current => ({ ...current, reportKind: kind, notice: undefined }))
    setError('')
  }

  function chooseFile(nextFile?: File) {
    setDraft(current => ({ ...current, file: nextFile }))
    setError('')
  }

  function submit() {
    if (!file || !reportKind || !canSubmit || onResumeSubmit) return
    onSubmit({ file, stageId, reportKind })
  }

  return (
    <>
      {!canWrite ? (
        <div role="status" className="w-full rounded-lg border border-yx-warning-soft bg-yx-warning-soft p-4 text-left text-xs leading-relaxed text-yx-warning-text">
          <p>您当前以只读权限查看该课题，请联系管理员或课题负责人提交报告。</p>
          {group ? <p className="mt-2">{group.stageLabel} · {group.skippedEmpty ? SKIPPED_EMPTY_COPY : '暂无报告'}</p> : null}
          {onResumeSubmit ? (
            <div className="mt-3 space-y-2">
              <p>另有待处理的提交，可返回原课题核对结果；此处不会新建提交。</p>
              <Button onClick={onResumeSubmit}>继续处理已有提交<ChevronRight className="h-3.5 w-3.5" /></Button>
            </div>
          ) : null}
        </div>
      ) : onResumeSubmit ? (
        <div role="status" className="w-full space-y-3 rounded-lg border border-yx-brand-soft bg-yx-brand-soft p-4 text-left text-xs leading-relaxed text-yx-brand-hover">
          <p>已有正在解析、待确认或结果未确认的提交，请先继续处理，不要重新上传。</p>
          <Button onClick={onResumeSubmit}>继续处理已有提交<ChevronRight className="h-3.5 w-3.5" /></Button>
        </div>
      ) : (
        <form className="@container/upload w-full space-y-6 text-left" aria-label="上传研究报告" onSubmit={event => { event.preventDefault(); submit() }}>
          {draft.notice ? <p role="status" className="rounded-lg bg-yx-warning-soft p-3 text-xs leading-relaxed text-yx-warning-text">{draft.notice}</p> : null}
          <div className="grid grid-cols-1 items-start gap-5 @min-[440px]/upload:grid-cols-2">
            <div className="min-w-0">
              <label htmlFor={stageSelectId} className={'block ' + fieldLabelClass}>所属阶段</label>
              <CustomSelect
                id={stageSelectId}
                ariaLabel="本次交付阶段"
                value={stageId}
                onChange={chooseStage}
                placeholder="请选择交付阶段"
                disabled={!detail.stages.length}
                size="lg"
                className="mt-2"
                options={detail.stages.map(item => ({
                  value: item.stage.id,
                  label: item.stageLabel,
                  description: item.stage.description,
                  disabled: !item.canSubmitUpdate && !item.canSubmitCompletion,
                  badge: item.stage.lifecycleStatus === 'completed' ? '已完成' : item.stage.lifecycleStatus === 'in_progress' ? '进行中' : '未开始',
                  badgeTone: item.stage.lifecycleStatus === 'in_progress' ? 'emerald' : 'gray',
                }))}
              />
              <p className="mt-2 text-xs leading-5 text-yx-muted">报告将归入所选阶段。</p>
            </div>
            <ReportKindSelector value={reportKind} availableKinds={kinds} description={kindDescription} onChange={chooseKind} />
          </div>

          {!detail.stages.length ? <p role="status" className="text-xs leading-5 text-yx-warning-text">请先调整研究计划，配置交付阶段。</p> : null}
          {group && !canSelectFile ? <p role="status" className="text-xs leading-5 text-yx-warning-text">当前阶段暂不支持提交报告，请选择其他阶段或联系课题负责人。</p> : null}
          {group?.skippedEmpty ? <p className="text-xs leading-5 text-yx-muted">{SKIPPED_EMPTY_COPY}，可补交完结报告。</p> : null}

          <div>
            <div className="mb-2 flex min-h-5 items-center justify-between gap-3">
              <h3 className={fieldLabelClass}>报告文件</h3>
              {file ? (
                <button type="button" onClick={() => chooseFile()} className="inline-flex items-center gap-1 rounded-sm text-xs text-yx-muted hover:text-yx-danger-text focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-yx-brand">
                  <X aria-hidden="true" className="h-3.5 w-3.5" />移除文件
                </button>
              ) : null}
            </div>
            <FileDropzone
              file={file}
              disabled={!canSelectFile}
              busy={false}
              onFile={chooseFile}
              onInvalid={setError}
              emptyTitle="点击选择文件，或拖拽到此处"
              className="min-h-44! border! focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-yx-brand motion-reduce:transform-none motion-reduce:transition-none"
            />
            {error ? <FormError className="mt-2">{error}</FormError> : null}
          </div>

          {impact?.autoCompletedStages.length ? (
            <div role="status" className="flex items-start gap-2 rounded-lg border border-yx-warning/20 bg-yx-warning-soft p-3 text-xs leading-5 text-yx-warning-text">
              <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <p>确认提交后，将跳过并完成 {impact.autoCompletedStages.length} 个前置阶段，已有报告仍会保留。具体影响将在提交前供你确认。</p>
            </div>
          ) : null}

          <div className="flex flex-col gap-4 @min-[440px]/upload:flex-row @min-[440px]/upload:items-center @min-[440px]/upload:justify-between">
            <p className="max-w-64 text-xs leading-5 text-yx-muted">上传后先解析文件，确认提交后正式归档。</p>
            <Button type="submit" size="lg" className="h-11! gap-2 rounded-xl px-6 text-sm! font-semibold! focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-yx-brand" disabled={!file || !canSubmit}>
              <Upload aria-hidden="true" className="h-4 w-4" />上传报告
            </Button>
          </div>
        </form>
      )}
    </>
  )
}

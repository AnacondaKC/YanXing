'use client'

import { Check, Milestone } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '@/components/ui/dialog'
import { Field, FormError } from '@/components/ui/field'
import { CustomSelect } from '@/components/ui/select'
import { apiFetch, mutationHeaders } from '@/lib/client-request'
import type { ProjectWithCapabilities } from '@/modules/projects/domain'
import type { ReportVersion } from '@/modules/reports/domain'

export function ReportStageAssignmentDialog({
  project,
  report,
  onClose,
  onSaved,
}: {
  project: ProjectWithCapabilities
  report: ReportVersion
  onClose: () => void
  onSaved: (report: ReportVersion) => void
}) {
  const lastMilestoneId = project.milestones.at(-1)?.id ?? ''
  const [milestoneId, setMilestoneId] = useState(
    report.deliveryType === 'final' ? lastMilestoneId : report.milestoneId ?? '',
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  const options = useMemo(() => project.milestones.map((milestone, index) => ({
    value: milestone.id,
    label: milestone.title,
    textLabel: milestone.title,
    badge: '阶段 ' + String(index + 1).padStart(2, '0'),
    description: milestone.targetDate ? '计划完成：' + milestone.targetDate : undefined,
  })), [project.milestones])

  async function save() {
    if (!milestoneId || saving) {
      if (!milestoneId) setError('请选择报告所属研究阶段。')
      return
    }
    setSaving(true)
    setError('')
    try {
      const response = await apiFetch('/api/reports/' + report.id, {
        method: 'PATCH',
        headers: mutationHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ milestoneId }),
      }).catch(() => null)
      const body = await response?.json().catch(() => null) as { error?: string; report?: ReportVersion } | null
      if (!response?.ok || !body?.report) {
        setError(body?.error ?? '保存报告所属阶段失败。')
        return
      }
      onSaved(body.report)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      onClose={onClose}
      labelledBy="report-stage-dialog-title"
      zIndex={90}
      initialFocusRef={closeButtonRef}
    >
      <DialogHeader
        title="选择报告所属阶段"
        description={report.title}
        titleId="report-stage-dialog-title"
        icon={Milestone}
        iconTone="brand"
        onClose={onClose}
        closeRef={closeButtonRef}
      />
      <DialogBody className="space-y-4">
        <Field label="研究阶段" htmlFor="report-stage-select" required>
          <CustomSelect
            id="report-stage-select"
            value={milestoneId}
            onChange={(value) => { setMilestoneId(value); setError('') }}
            options={options}
            placeholder="请选择研究阶段"
            disabled={saving || report.deliveryType === 'final'}
            ariaLabel="选择报告所属研究阶段"
          />
        </Field>
        {error ? <FormError>{error}</FormError> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={saving}>取消</Button>
        <Button onClick={save} disabled={!milestoneId} loading={saving}>
          {saving ? null : <Check className="h-3.5 w-3.5" />}
          保存并继续分析
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

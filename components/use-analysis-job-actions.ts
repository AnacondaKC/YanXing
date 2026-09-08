'use client'

import { useCallback, useRef, useState } from 'react'
import { cancelAnalysisPath, postAnalysisJob, startAnalysisFailureAction, startAnalysisGate, startAnalysisPath } from '@/lib/analysis-job-actions'
import type { AnalysisJob } from '@/modules/analysis/domain'
import type { AnalysisModuleState } from '@/modules/contracts/analysis'
import type { ReportVersion } from '@/modules/reports/domain'

export function useAnalysisJobActions({ canManage, activeReport, activeJobId, showNotice, onJobAccepted, onNeedStageAssignment, onNeedProjectContext, onCancelled }: { canManage: boolean; activeReport?: ReportVersion; activeJobId?: string; showNotice: (message: string) => void; onJobAccepted: (job: AnalysisJob, moduleStates: AnalysisModuleState[]) => void; onNeedStageAssignment: (report: ReportVersion) => void; onNeedProjectContext: () => void; onCancelled: (job: AnalysisJob) => void }) {
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const activeReportIdRef = useRef(activeReport?.id)
  const activeJobIdRef = useRef(activeJobId)
  activeReportIdRef.current = activeReport?.id
  activeJobIdRef.current = activeJobId

  const startAnalysis = useCallback(async (reportIdToAnalyze?: string, stageConfirmed = false) => {
    const reportId = reportIdToAnalyze || activeReport?.id
    const report = activeReport?.id === reportId ? activeReport : undefined
    const gate = startAnalysisGate({ canManage, reportId, report, activeJobId, starting, stageConfirmed })
    if (gate.type === 'block') return
    if (gate.type === 'assign-stage') { onNeedStageAssignment(gate.report); return }
    setStarting(true)
    try {
      const result = await postAnalysisJob(startAnalysisPath(gate.reportId))
      if (activeReportIdRef.current !== gate.reportId) return
      if (!result.ok || !result.body.job) {
        const action = startAnalysisFailureAction(result.body, report)
        if (action === 'assign-stage' && report) { onNeedStageAssignment(report); return }
        if (action === 'edit-project') onNeedProjectContext()
        showNotice(result.body.error ?? '启动 AI 分析失败。')
        return
      }
      onJobAccepted(result.body.job, result.body.moduleStates ?? [])
      showNotice('AI 深度分析已进入队列。')
    } finally { setStarting(false) }
  }, [activeJobId, activeReport, canManage, onJobAccepted, onNeedProjectContext, onNeedStageAssignment, showNotice, starting])

  const cancelAnalysis = useCallback(async () => {
    const jobId = activeJobId
    if (!canManage || !jobId || cancelling) return
    setCancelling(true)
    try {
      const result = await postAnalysisJob(cancelAnalysisPath(jobId))
      if (activeJobIdRef.current !== jobId) return
      if (!result.ok || !result.body.job) { showNotice(result.body.error ?? '停止分析失败。'); return }
      onCancelled(result.body.job)
      showNotice('分析已停止。')
    } finally { setCancelling(false) }
  }, [activeJobId, canManage, cancelling, onCancelled, showNotice])

  return { cancelling, startAnalysis, cancelAnalysis }
}

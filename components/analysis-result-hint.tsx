'use client'

import { analysisResultHint, type AnalysisResultDisplay } from '@/modules/analysis/progress'

export function AnalysisResultHint({ display }: { display: AnalysisResultDisplay }) {
  const hint = analysisResultHint(display)
  if (!hint) return null
  return (
    <span className={`inline-flex items-center text-[9px] font-medium sm:text-[10px] ${hint.tone === 'brand' ? 'text-yx-brand' : 'text-yx-warning'}`}>
      {hint.label}
      {display === 'updating' ? <span className="yx-progress-ellipsis" /> : null}
    </span>
  )
}

import type { GateError, ReportEvaluationContext, ReportFacts } from '@/modules/contracts/analysis'

export function buildPageAnalysisTaskPrompt(input: {
  instructionPrompt: string
  reportFacts?: Pick<ReportFacts, 'paragraphCount' | 'characterCount'>
  evaluationContext?: ReportEvaluationContext
  previousErrors?: GateError[]
}): string {
  const lines = [
    '模块：page_analysis',
    '任务：' + input.instructionPrompt,
  ]
  if (input.reportFacts) lines.push('报告本地事实：' + JSON.stringify({ paragraphCount: input.reportFacts.paragraphCount, characterCount: input.reportFacts.characterCount }))
  if (input.evaluationContext) lines.push('课题与阶段评价基准：' + JSON.stringify(input.evaluationContext))
  lines.push(
    '必须一次性返回完整分析页 JSON；固定中文键名必须全部填写，不得增删或改名。',
    '报告详情不包含报告主标题；不要使用文件名填充报告详情标题。',
    '综合评分和报告完整度的总分、词云权重、所有前端 ID 由程序生成，不要输出这些字段。',
  )
  if (input.previousErrors?.length) lines.push('修正以下门禁错误：' + JSON.stringify(input.previousErrors))
  return lines.join('\n')
}

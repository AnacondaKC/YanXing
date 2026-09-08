export type InsightEmptyKind = 'missing-report' | 'generating' | 'ready'

export function insightEmptyKind(hasReport: boolean, generating: boolean): InsightEmptyKind {
  if (!hasReport) return 'missing-report'
  if (generating) return 'generating'
  return 'ready'
}

export function insightEmptyCopy(kind: InsightEmptyKind) {
  if (kind === 'missing-report') {
    return {
      kicker: '报告洞察已就绪 · 待归档研究报告',
      lead: '开启决策洞察',
      highlight: '上传研究报告',
      description: '决策洞察依据报告全文生成。请先在课题中上传 DOCX 或 PDF，归档完成后即可启动五分钟决策速读。',
      status: '尚未上传研报版本',
      action: '前往上传报告',
    }
  }
  if (kind === 'generating') {
    return {
      kicker: '报告洞察进行中 · 正在编排决策速读',
      lead: '正在编排洞察',
      highlight: '五分钟决策速读',
      description: '系统正在根据报告正文编排一页决策速读，完成后可在此阅读。',
      status: '洞察生成中',
      action: '正在生成',
    }
  }
  return {
    kicker: '研报已归档 · 待启动五分钟洞察',
    lead: '启动决策洞察',
    highlight: '五分钟报告速读',
    description: '把报告的立论、证据与建议收成一页简报，便于快速判断。',
    status: '待启动洞察',
    action: '生成洞察',
  }
}

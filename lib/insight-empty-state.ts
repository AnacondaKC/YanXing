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
      description: '决策洞察依据报告全文生成。请先在课题中上传 DOCX 或 PDF，归档完成后即可生成报告简页。',
      status: '尚未上传研报版本',
      action: '前往上传报告',
    }
  }
  if (kind === 'generating') {
    return {
      kicker: '报告洞察进行中 · 正在编排报告简页',
      lead: '正在编排洞察',
      highlight: '5-10分钟报告简页',
      description: '系统正在根据报告正文整理报告简页，完成后可在此了解报告的核心主旨。',
      status: '洞察生成中',
      action: '正在生成',
    }
  }
  return {
    kicker: '研报已归档 · 待生成报告简页',
    lead: '生成报告洞察',
    highlight: '5-10分钟报告简页',
    description: '将报告中的论点、论据与建议整理成一页报告简页，约5-10分钟读完，帮助你快速了解报告的核心主旨。',
    status: '待启动洞察',
    action: '生成洞察',
  }
}

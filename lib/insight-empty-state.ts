export function insightEmptyCopy({ report, generating }: { report?: unknown; generating: boolean }) {
  if (!report) {
    return {
      lead: '开启决策洞察',
      description: '决策洞察依据报告全文生成。请先在课题中上传 DOCX 或 PDF，归档完成后即可生成报告简页。',
    }
  }
  if (generating) {
    return {
      lead: '正在编排洞察',
      description: '系统正在根据报告正文整理报告简页，完成后可在此了解报告的核心主旨。',
    }
  }
  return {
    lead: '生成报告洞察',
    description: '将报告中的论点、论据与建议整理成一页报告简页，约5-10分钟读完，帮助你快速了解报告的核心主旨。',
  }
}

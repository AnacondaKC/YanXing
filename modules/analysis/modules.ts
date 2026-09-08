import {
  AnalysisArtifactSchemas,
} from '@/modules/contracts/analysis'
import type { AnalysisModuleAttemptContext, AnalysisModuleDefinition } from '@/modules/analysis/module'

export const pageAnalysisModule: AnalysisModuleDefinition = {
  id: 'page_analysis',
  schemaVersion: 1,
  promptVersion: 'page-analysis-v1',
  maxAttempts: 3,
  schema: AnalysisArtifactSchemas.page_analysis,
  buildPrompt: (context) => buildPrompt(context),
}

function buildPrompt(context: AnalysisModuleAttemptContext) {
  const lines = [
    '模块：page_analysis',
    '任务：' + context.promptConfig.instructionPrompt,
    '报告本地事实：' + JSON.stringify({ paragraphCount: context.reportFacts.paragraphCount, characterCount: context.reportFacts.characterCount }),
    '课题与阶段评价基准：' + JSON.stringify(context.evaluationContext),
    '必须一次性返回完整分析页 JSON；固定中文键名必须全部填写，不得增删或改名。',
    '报告详情不包含报告主标题；不要使用文件名填充报告详情标题。',
    '综合评分和报告完整度的总分、词云权重、所有前端 ID 由程序生成，不要输出这些字段。',
  ]
  if (context.previousErrors.length) lines.push('修正以下门禁错误：' + JSON.stringify(context.previousErrors))
  const prompt = lines.join('\n')
  if (prompt.length > context.maxContextCharacters) throw new Error('模型提示词超过 ' + context.maxContextCharacters + ' 字符限制。')
  return prompt
}

import type { PageAnalysisArtifact } from '../../modules/contracts/analysis'

export function validSubmissionAnalysis(score=80):PageAnalysisArtifact {
  return {
    '综合评分':{'研究价值':score,'方法严谨':score,'证据质量':score,'逻辑一致':score,'结论强度':score,'可执行性':score,'主要影响因素':'证据与研究目标相匹配'},
    '报告详情':{'章节':[{'标题':'正文','摘要':'分析投资方案与现金流安排。'}],'完整度结论':'整体完整度良好'},
    '报告完整度':{'研究目标':80,'方法与数据':75,'证据覆盖':82,'分析结构':78,'结论覆盖':72,'风险与建议':70,'主要缺口':'补充风险验证'},
    '思维导图':{'名称':'投资研究','子节点':[{'名称':'收益','子节点':[]},{'名称':'风险','子节点':[]}]},
    '词云':Array.from({length:50},(_,index)=>'主题'+String.fromCodePoint(0x4e00+index)),
    '热力图':[{'章节':'正文','文献综述':100,'定性分析':55,'定量建模':30,'案例研究':0,'实地调研':0,'对比分析':45}],
    'AI建议':['补充现金流压力测试和风险缓释措施。'],
  }
}
export function submissionProviderResponse(content:string) {
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]}),{status:200,headers:{'Content-Type':'application/json'}})
}

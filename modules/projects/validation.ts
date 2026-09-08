import type { Milestone } from '@/modules/projects/domain'

export const PROJECT_FIELD_LIMITS = {
  title: 160,
  objective: 2_000,
  description: 5_000,
  milestoneTitle: 120,
  milestoneDescription: 300,
  milestoneId: 100,
  reportId: 100,
  milestones: 12,
  milestoneReports: 100,
  collaborators: 3,
} as const

export function validateProjectConfiguration(input: {
  title: string
  objective: string
  description: string
  milestones: Milestone[]
}): string | undefined {
  const title = input.title.trim()
  const objective = input.objective.trim()
  const description = input.description.trim()
  if (!title) return '课题名称不能为空。'
  if (!objective) return '研究目标与核心问题不能为空。'
  if (!description) return '研究背景与说明不能为空。'
  if (title.length > PROJECT_FIELD_LIMITS.title || objective.length > PROJECT_FIELD_LIMITS.objective || description.length > PROJECT_FIELD_LIMITS.description) {
    return '课题字段长度超过限制。'
  }
  if (!input.milestones.length) return '请至少创建一个研究阶段。'
  if (input.milestones.length > PROJECT_FIELD_LIMITS.milestones) return '研究阶段不能超过 ' + PROJECT_FIELD_LIMITS.milestones + ' 个。'

  const milestoneIds = new Set<string>()
  for (const [index, milestone] of input.milestones.entries()) {
    const position = index + 1
    const id = milestone.id.trim()
    const milestoneTitle = milestone.title.trim()
    const targetDate = milestone.targetDate?.trim() ?? ''
    const milestoneDescription = milestone.description?.trim() ?? ''
    if (!id || id.length > PROJECT_FIELD_LIMITS.milestoneId || milestoneIds.has(id)) return '阶段 ' + position + ' 的编号为空、过长或重复。'
    milestoneIds.add(id)
    if (!milestoneTitle) return '请填写阶段 ' + position + ' 的阶段名称。'
    if (milestoneTitle.length > PROJECT_FIELD_LIMITS.milestoneTitle) return '阶段 ' + position + ' 的名称超过字数限制。'
    if ((milestone.reportIds ?? []).some((reportId) => !reportId || reportId.length > PROJECT_FIELD_LIMITS.reportId)) return '阶段 ' + position + ' 包含无效的报告编号。'
    if (!isValidDateInput(targetDate)) return '请为阶段 ' + position + ' 选择有效的计划完成日期。'
    if (!milestoneDescription) return '请填写阶段 ' + position + ' 的工作内容与预期成果。'
    if (milestoneDescription.length > PROJECT_FIELD_LIMITS.milestoneDescription) return '阶段 ' + position + ' 的工作内容与预期成果超过字数限制。'
  }
  return undefined
}

function isValidDateInput(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(value + 'T00:00:00Z')
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

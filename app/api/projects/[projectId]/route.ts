import { NextResponse } from 'next/server'
import { deleteProject, getProject, getProjectForUser, listProjectReportStageRefs, updateProject, projectExistsReadable, userCanDeleteProject, userCanManageProject, ProjectAnalysisBusyError, ProjectCollaboratorLimitError, ProjectUpdateConflictError, ReportAuthorizationChangedError } from '@/lib/db/repository'
import { getActiveUserById, getActiveUsersByIds } from '@/lib/auth/session'
import { getRequestUser } from '@/lib/auth/request'
import { listActiveProjectMemberIds, recordActivity } from '@/lib/notifications'
import { notificationActions } from '@/modules/notifications/domain'
import { readRequiredUpdatedAt } from '@/lib/http/optimistic-lock'
import { jsonBodyFailureResponse } from '@/lib/http/json-body-response'
import { readJsonBodyOrTooLarge } from '@/lib/http/request-body'

import type { Milestone } from '@/modules/projects/domain'
import { PROJECT_FIELD_LIMITS, validateProjectConfiguration } from '@/modules/projects/validation'

export const runtime = 'nodejs'

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params
  const user = getRequestUser(_request)
  if (!user) return NextResponse.json({ error: '未登录。' }, { status: 401 })
  if (!projectExistsReadable(projectId)) return NextResponse.json({ error: '课题不存在。' }, { status: 404 })
  if (!userCanDeleteProject(projectId, user)) {
    return NextResponse.json({ error: '只有课题负责人可以删除课题。' }, { status: 403 })
  }
  const project = getProject(projectId)
  const recipientUserIds = listActiveProjectMemberIds(projectId)
  try {
    if (!await deleteProject(projectId, user)) return NextResponse.json({ error: '课题不存在。' }, { status: 404 })
  } catch (error) {
    if (error instanceof ReportAuthorizationChangedError) return NextResponse.json({ error: error.message }, { status: 403 })
    throw error
  }
  if (project) {
    recordActivity({
      action: notificationActions.projectDeleted,
      actor: user,
      projectId,
      projectTitle: project.title,
      recipientUserIds,
      summary: '删除课题「' + project.title + '」',
      detail: user.displayName + ' 删除课题「' + project.title + '」，该课题下的报告、分析任务与洞察已一并清理。',
    })
  }
  return NextResponse.json({ ok: true })
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params
  const user = getRequestUser(request)
  if (!user) return NextResponse.json({ error: '未登录。' }, { status: 401 })
  if (!projectExistsReadable(projectId)) return NextResponse.json({ error: '课题不存在。' }, { status: 404 })
  if (!userCanManageProject(projectId, user)) {
    return NextResponse.json({ error: '当前账号没有编辑课题的权限。' }, { status: 403 })
  }
  const currentProject = getProjectForUser(user, projectId)
  if (!currentProject) return NextResponse.json({ error: '课题不存在。' }, { status: 404 })

  let body: Partial<{
    title: string
    objective: string
    description: string
    ownerId: string
    collaboratorIds: string[]
    milestones: Milestone[]
    updatedAt: string
  }> | null
  const parsed = await readJsonBodyOrTooLarge<typeof body>(request, 256 * 1024)
  if (!parsed.ok) return jsonBodyFailureResponse(parsed.status)
  body = parsed.body
  const expectedUpdatedAt = readRequiredUpdatedAt(body?.updatedAt)
  if (!expectedUpdatedAt) return NextResponse.json({ error: '缺少有效的更新时间，请刷新后重试。' }, { status: 400 })

  let title: string | undefined = undefined
  if (typeof body?.title === 'string') {
    title = body.title.trim()
    if (!title) return NextResponse.json({ error: '课题标题不能为空。' }, { status: 400 })
    if (title.length > 160) return NextResponse.json({ error: '课题字段长度超过限制。' }, { status: 400 })
  }

  let objective: string | undefined = undefined
  if (typeof body?.objective === 'string') {
    objective = body.objective.trim()
    if (objective.length > PROJECT_FIELD_LIMITS.objective) return NextResponse.json({ error: '课题目标长度超过限制。' }, { status: 400 })
  }

  let description: string | undefined = undefined
  if (typeof body?.description === 'string') {
    description = body.description.trim()
    if (description.length > PROJECT_FIELD_LIMITS.description) return NextResponse.json({ error: '课题说明长度超过限制。' }, { status: 400 })
  }

  let ownerId: string | undefined = undefined
  let ownerName: string | undefined = undefined
  if (typeof body?.ownerId === 'string') {
    const requestedOwnerId = body.ownerId.trim()
    if (requestedOwnerId && requestedOwnerId !== currentProject.ownerId) {
      // 负责人变更仅管理员可执行，避免课题负责人被单方面替换。
      if (user.role !== 'admin') {
        return NextResponse.json({ error: '只有管理员可以变更课题负责人。' }, { status: 403 })
      }
      const owner = getActiveUserById(requestedOwnerId)
      if (!owner) return NextResponse.json({ error: '请选择一名有效的课题负责人。' }, { status: 400 })
      ownerId = requestedOwnerId
      ownerName = owner.displayName
    }
  }

  let collaboratorIds: string[] | undefined = undefined
  if (Array.isArray(body?.collaboratorIds)) {
    // 成员扩权（增删协作者）与负责人变更同样仅限负责人或管理员，editor 只能编辑内容。
    if (!userCanDeleteProject(projectId, user)) {
      return NextResponse.json({ error: '只有课题负责人或管理员可以调整协作者。' }, { status: 403 })
    }
    collaboratorIds = [...new Set(body.collaboratorIds.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean))]
    if (collaboratorIds.length > PROJECT_FIELD_LIMITS.collaborators) {
      return NextResponse.json({ error: `课题协作者不能超过 ${PROJECT_FIELD_LIMITS.collaborators} 人。` }, { status: 400 })
    }
    if (getActiveUsersByIds(collaboratorIds).some((user) => !user)) {
      return NextResponse.json({ error: '存在无效的协作者，请刷新后重试。' }, { status: 400 })
    }
  }

  let milestones: Milestone[] | undefined = undefined
  if (body && (Object.prototype.hasOwnProperty.call(body, 'progress') || Object.prototype.hasOwnProperty.call(body, 'stage'))) {
    return NextResponse.json({ error: '课题阶段和百分比进度由里程碑状态自动生成，请勿单独提交。' }, { status: 400 })
  }
  if (Array.isArray(body?.milestones)) {
    if (body.milestones.some((item) => typeof item !== 'object' || item === null || Array.isArray(item))) {
      return NextResponse.json({ error: '研究阶段格式无效。' }, { status: 400 })
    }
    if (body.milestones.length > PROJECT_FIELD_LIMITS.milestones) {
      return NextResponse.json({ error: '研究阶段数量超过限制。' }, { status: 400 })
    }
    milestones = body.milestones.map((item, index) => ({
      id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `stage-${Date.now()}-${index}`,
      title: typeof item.title === 'string' ? item.title.trim() : '',
      targetDate: typeof item.targetDate === 'string' ? item.targetDate.trim() : undefined,
      description: typeof item.description === 'string' ? item.description.trim() : undefined,
      status: item.status === 'completed' || item.status === 'in_progress' || item.status === 'not_started' || item.status === 'at_risk' ? item.status : 'not_started',
      reportIds: Array.isArray(item.reportIds)
        ? [...new Set(item.reportIds.filter((id: unknown): id is string => typeof id === 'string').map((id) => id.trim()).filter((id) => id.length > 0 && id.length <= PROJECT_FIELD_LIMITS.reportId))]
        : undefined,
    }))
    if (milestones?.some((milestone) => (milestone.reportIds?.length ?? 0) > PROJECT_FIELD_LIMITS.milestoneReports)) {
      return NextResponse.json({ error: '单个研究阶段关联的报告数量超过限制。' }, { status: 400 })
    }
  }

  const milestonesChanged = milestones !== undefined
    && JSON.stringify(milestones) !== JSON.stringify(currentProject.milestones)
  const configurationChanged = (title !== undefined && title !== currentProject.title)
    || (objective !== undefined && objective !== currentProject.objective)
    || (description !== undefined && description !== currentProject.description)
    || milestonesChanged
  const shouldInvalidatePublishedAnalysis = (objective !== undefined && objective !== currentProject.objective)
    || (description !== undefined && description !== currentProject.description)
    || milestonesChanged
  if (configurationChanged) {
    const configurationError = validateProjectConfiguration({
      title: title ?? currentProject.title,
      objective: objective ?? currentProject.objective,
      description: description ?? currentProject.description,
      milestones: milestones ?? currentProject.milestones,
    })
    if (configurationError) return NextResponse.json({ error: configurationError }, { status: 400 })
  }

  const changedFields = [
    ...(title !== undefined && title !== currentProject.title ? ['标题'] : []),
    ...(objective !== undefined && objective !== currentProject.objective ? ['研究目标'] : []),
    ...(description !== undefined && description !== currentProject.description ? ['课题说明'] : []),
    ...(ownerId !== undefined ? ['负责人'] : []),
    ...(collaboratorIds !== undefined ? ['协作者'] : []),
    ...(milestonesChanged ? ['研究阶段'] : []),
  ]

  if (milestones) {
    const projectReports = listProjectReportStageRefs(projectId)
    const projectReportsById = new Map(projectReports.map((report) => [report.id, report]))
    const nextMilestoneIds = new Set(milestones.map((milestone) => milestone.id))
    const finalReports = projectReports.filter((report) => report.deliveryType === 'final')
    const hasFinalReport = finalReports.length > 0
    const finalMilestoneReportIds = new Set(milestones.at(-1)?.reportIds ?? [])
    if (finalReports.some((report) => !finalMilestoneReportIds.has(report.id))) {
      return NextResponse.json({ error: '最终交付报告必须保留在最后一个研究阶段。' }, { status: 400 })
    }
    const linkedReports = projectReports.filter((report) => report.milestoneId)
    const removedLinkedStage = linkedReports.find((report) => !nextMilestoneIds.has(report.milestoneId!))
    if (removedLinkedStage) {
      const linkedStage = currentProject.milestones.find((milestone) => milestone.id === removedLinkedStage.milestoneId)
      return NextResponse.json({ error: `阶段「${linkedStage?.title ?? removedLinkedStage.milestoneId}」已关联报告，不能直接删除。` }, { status: 400 })
    }

    const seenReportIds = new Set<string>()
    for (let i = 0; i < milestones.length; i++) {
      const milestone = milestones[i]
      const isCompleted = milestone.status === 'completed'
      const isStarted = milestone.status === 'in_progress' || milestone.status === 'at_risk' || isCompleted
      if (i > 0 && isStarted) {
        const previous = milestones[i - 1]
        const previousDone = previous.status === 'completed'
        if (!previousDone) {
          return NextResponse.json({ error: `阶段 ${i + 1}「${milestone.title}」必须在上一阶段「${previous.title}」完成后才能开始。` }, { status: 400 })
        }
      }

      for (const reportId of milestone.reportIds ?? []) {
        if (seenReportIds.has(reportId)) {
          return NextResponse.json({ error: `报告不能同时归属于多个研究阶段。` }, { status: 400 })
        }
        seenReportIds.add(reportId)
        const linkedReport = projectReportsById.get(reportId)
        if (!linkedReport) {
          return NextResponse.json({ error: `阶段「${milestone.title}」关联的成果报告不存在或不属于当前课题。` }, { status: 400 })
        }
        if (linkedReport.deliveryType === 'final' && i !== milestones.length - 1) {
          return NextResponse.json({ error: '最终交付报告只能关联到最后一个研究阶段。' }, { status: 400 })
        }
      }
      if (isCompleted && !(milestone.reportIds?.length) && !hasFinalReport) {
        return NextResponse.json({ error: `阶段「${milestone.title}」已完成，必须关联成果报告。` }, { status: 400 })
      }
    }
    const assignmentEntries = (items: Milestone[]) => items
      .flatMap((milestone) => (milestone.reportIds ?? []).map((reportId) => [reportId, milestone.id] as const))
      .sort(([left], [right]) => left.localeCompare(right))
    const currentAssignments = assignmentEntries(currentProject.milestones)
    const nextAssignments = assignmentEntries(milestones)
    if (JSON.stringify(currentAssignments) !== JSON.stringify(nextAssignments)) {
      return NextResponse.json({ error: '报告阶段关联只能通过报告交付或阶段分配操作修改。' }, { status: 400 })
    }
    const currentLinkedStageOrder = currentProject.milestones.filter((milestone) => milestone.reportIds?.length).map((milestone) => milestone.id)
    const nextLinkedStageOrder = milestones.filter((milestone) => milestone.reportIds?.length).map((milestone) => milestone.id)
    if (JSON.stringify(currentLinkedStageOrder) !== JSON.stringify(nextLinkedStageOrder)) {
      return NextResponse.json({ error: '已交付报告所在阶段的顺序不能修改。' }, { status: 400 })
    }
  }

  try {
    if (!updateProject(projectId, {
      ...(title !== undefined ? { title } : {}),
      ...(objective !== undefined ? { objective } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(ownerId !== undefined ? { ownerId, ownerName } : {}),
      ...(collaboratorIds !== undefined ? { collaboratorIds } : {}),
      ...(milestones !== undefined ? { milestones } : {}),
    }, {
      requireNoActiveAnalysis: configurationChanged,
      actor: user,
      requireOwner: ownerId !== undefined || collaboratorIds !== undefined,
      expectedUpdatedAt,
      invalidateAnalysis: shouldInvalidatePublishedAnalysis,
    })) {
      return NextResponse.json({ error: '课题不存在。' }, { status: 404 })
    }
  } catch (error) {
    if (error instanceof ProjectUpdateConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
    if (error instanceof ReportAuthorizationChangedError) {
      return NextResponse.json({ error: error.message }, { status: 403 })
    }
    if (error instanceof ProjectAnalysisBusyError) {
      return NextResponse.json({ error: '课题报告正在分析，请在分析完成后再修改评价基准。' }, { status: 409 })
    }
    if (error instanceof ProjectCollaboratorLimitError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    throw error
  }

  const project = getProjectForUser(user, projectId)
  if (project && changedFields.length) {
    recordActivity({
      action: notificationActions.projectUpdated,
      actor: user,
      projectId,
      projectTitle: project.title,
      summary: '修改课题「' + project.title + '」',
      detail: user.displayName + ' 修改课题「' + project.title + '」，变更内容：' + changedFields.join('、') + '。',
    })
  }
  return project
    ? NextResponse.json({ project })
    : NextResponse.json({ error: '课题不存在。' }, { status: 404 })
}

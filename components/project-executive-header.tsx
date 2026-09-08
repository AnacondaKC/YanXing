'use client'

import {
  Activity,
  Clock3,
  FileText,
  Sparkles,
  TrendingUp,
  UserRound,
  Users,
} from 'lucide-react'
import type { ProjectWithCapabilities } from '@/modules/projects/domain'

export type ProjectTabId = 'dashboard' | 'insight' | 'content' | 'history'

interface ProjectExecutiveHeaderProps {
  project: ProjectWithCapabilities
}

export function ProjectExecutiveHeader({
  project,
}: ProjectExecutiveHeaderProps) {
  const milestones = project.milestones ?? []
  const activeStageIndex = milestones.findIndex((milestone) => milestone.status === 'in_progress' || milestone.status === 'at_risk')
  const nextStageIndex = milestones.findIndex((milestone) => milestone.status !== 'completed')
  const currentStageIndex = activeStageIndex >= 0 ? activeStageIndex : nextStageIndex >= 0 ? nextStageIndex : milestones.length - 1
  const stagePositionLabel = milestones.length ? `阶段 ${Math.max(0, currentStageIndex) + 1}/${milestones.length}` : '暂无阶段'

  return (
    <div className="flex flex-col gap-3 sm:gap-4">
      {/* 课题标题与状态元信息 */}
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="min-w-0 max-w-5xl truncate text-2xl font-extrabold tracking-tight text-yx-ink dark:text-yx-ink sm:text-3xl lg:text-4xl">
            {project.title}
          </h1>
          {project.isExample && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800">
              <Sparkles className="h-3.5 w-3.5 text-amber-600" />
              品牌策划示例课题
            </span>
          )}
        </div>

        {/* 课题状态、负责人、更新时间等元信息 */}
        <div className="flex flex-wrap items-center gap-2.5 text-xs text-yx-muted">
          {/* 当前课题阶段位置 */}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-yx-brand bg-yx-brand px-2.5 py-0.5 text-[11px] font-bold text-white shadow-2xs">
            <TrendingUp className="h-3 w-3 text-white" />
            <span>{stagePositionLabel}</span>
          </span>

          {/* 负责人标签 */}
          <span className="inline-flex items-center gap-1 rounded-md bg-yx-surface px-2 py-0.5 text-[11px] font-medium text-yx-ink-soft border border-yx-line/60">
            <UserRound className="h-3 w-3 text-yx-muted" />
            <span>负责人：{project.ownerName}</span>
          </span>

          {/* 协作者标签 */}
          {project.collaboratorNames && (
            <span className="inline-flex items-center gap-1 rounded-md bg-yx-surface px-2 py-0.5 text-[11px] font-medium text-yx-ink-soft border border-yx-line/60">
              <Users className="h-3 w-3 text-yx-muted" />
              <span>协作者：{project.collaboratorNames}</span>
            </span>
          )}

          {/* 更新时间 */}
          <span className="hidden sm:inline-flex items-center gap-1 text-[11px] text-yx-faint">
            <Clock3 className="h-3 w-3" />
            <span>更新于 {project.updatedAt.slice(0, 10).replace(/-/g, '/')}</span>
          </span>
        </div>
      </div>
    </div>
  )
}

interface ProjectSideNavProps {
  activeTab: ProjectTabId
  onTabChange: (tab: ProjectTabId) => void
  className?: string
}

export function ProjectSideNav({
  activeTab,
  onTabChange,
  className,
}: ProjectSideNavProps) {
  const tabs: {
    id: ProjectTabId
    label: string
    icon: typeof Activity
    desc: string
  }[] = [
    { id: 'dashboard', label: '分析', icon: Activity, desc: 'AI综合研判与图谱' },
    { id: 'insight', label: '洞察', icon: Sparkles, desc: '五分钟决策速读' },
    { id: 'content', label: '原文', icon: FileText, desc: '沉浸式原文查看' },
    { id: 'history', label: '历史', icon: Clock3, desc: '报告版本历史' },
  ]

  return (
    <aside aria-label="课题模块外挂导航" className={`shrink-0 ${className ?? ''}`}>
      <nav className="flex flex-row xl:flex-col gap-1 overflow-x-auto rounded-lg border border-yx-line bg-white/95 p-1 shadow-2xs backdrop-blur-xs">
        {tabs.map((tab) => {
          const active = activeTab === tab.id
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id)}
              aria-current={active ? 'page' : undefined}
              title={tab.desc}
              className={`group flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-all ${
                active
                  ? 'bg-yx-brand text-white shadow-xs'
                  : 'text-yx-ink-soft hover:bg-yx-hover hover:text-yx-ink'
              }`}
            >
              <Icon
                className={`h-3.5 w-3.5 shrink-0 transition-colors ${
                  active ? 'text-white' : 'text-yx-muted group-hover:text-yx-ink'
                }`}
              />
              <span className="truncate font-medium whitespace-nowrap">{tab.label}</span>
            </button>
          )
        })}
      </nav>
    </aside>
  )
}


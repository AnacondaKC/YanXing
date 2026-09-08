'use client'

import { BookOpen, FileText, FolderKanban, Layers3, Pin, Plus, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { WorkspaceBrandHeader } from '@/components/workspace-brand'
import { WorkspaceSidebar } from '@/components/workspace-shell'
import type { ProjectWithCapabilities } from '@/modules/projects/domain'

const PROJECT_ROW_HEIGHT = 34
const PROJECT_LIST_MAX_HEIGHT = 320
const PROJECT_LIST_OVERSCAN = 4

function prioritizeOwnedProjects(projects: ProjectWithCapabilities[], currentUserId?: string) {
  const ownedProjects: ProjectWithCapabilities[] = []
  const otherProjects: ProjectWithCapabilities[] = []
  for (const project of projects) {
    if (currentUserId && project.ownerId === currentUserId) ownedProjects.push(project)
    else otherProjects.push(project)
  }
  return [...ownedProjects, ...otherProjects]
}

function ProjectNavigationList({
  activeNav,
  activeProjectId,
  onSelectProject,
  projects,
  currentUserId,
}: {
  activeNav: 'overview' | 'reports' | 'knowledge' | 'project'
  activeProjectId?: string
  onSelectProject: (project: ProjectWithCapabilities) => void
  projects: ProjectWithCapabilities[]
  currentUserId?: string
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const activeIndex = projects.findIndex((project) => project.id === activeProjectId)

  useEffect(() => {
    if (activeIndex < 0) return
    const element = scrollRef.current
    if (!element) return
    const itemTop = activeIndex * PROJECT_ROW_HEIGHT
    const itemBottom = itemTop + PROJECT_ROW_HEIGHT
    const viewportTop = element.scrollTop
    const viewportBottom = viewportTop + element.clientHeight
    if (itemTop < viewportTop) {
      element.scrollTo({ top: itemTop, behavior: 'auto' })
    } else if (itemBottom > viewportBottom) {
      element.scrollTo({ top: itemBottom - element.clientHeight, behavior: 'auto' })
    }
  }, [activeIndex, activeProjectId, activeNav])

  if (!projects.length) {
    return <div className="mt-1 pl-3 px-2.5 py-2 text-[11px] text-yx-muted">暂无课题</div>
  }

  const firstIndex = Math.max(0, Math.floor(scrollTop / PROJECT_ROW_HEIGHT) - PROJECT_LIST_OVERSCAN)
  const lastIndex = Math.min(
    projects.length,
    Math.ceil((scrollTop + PROJECT_LIST_MAX_HEIGHT) / PROJECT_ROW_HEIGHT) + PROJECT_LIST_OVERSCAN,
  )
  const visibleProjects = projects.slice(firstIndex, lastIndex)
  const listHeight = projects.length * PROJECT_ROW_HEIGHT

  return (
    <div
      ref={scrollRef}
      className="mt-1 max-h-80 overflow-y-auto pl-3 yx-subtle-scrollbar"
      style={{ height: Math.min(PROJECT_LIST_MAX_HEIGHT, listHeight) }}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div className="relative" style={{ height: listHeight, contain: 'strict' }}>
        <div className="absolute inset-x-0" style={{ top: firstIndex * PROJECT_ROW_HEIGHT }}>
          {visibleProjects.map((project, visibleIndex) => {
            const projectIndex = firstIndex + visibleIndex
            const isSelected = activeNav === 'project' && activeProjectId === project.id
            const isPinned = Boolean(currentUserId && project.ownerId === currentUserId)
            return (
              <div key={project.id} style={{ height: PROJECT_ROW_HEIGHT }}>
                <button
                  type="button"
                  onClick={() => onSelectProject(project)}
                  aria-current={isSelected ? 'page' : undefined}
                  aria-posinset={projectIndex + 1}
                  aria-setsize={projects.length}
                  className={'group flex h-8 w-full items-center justify-between gap-1.5 rounded-md px-2.5 text-left text-xs transition-all ' + (isSelected
                    ? 'bg-yx-brand-soft font-semibold text-yx-brand-strong'
                    : 'text-yx-ink hover:bg-yx-hover')}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className={'inline-flex size-4 shrink-0 items-center justify-center rounded-full border text-[8px] font-semibold leading-none tabular-nums transition-colors ' + (isPinned
                        ? 'border-yx-brand bg-yx-brand text-white shadow-2xs'
                        : isSelected
                          ? 'border-yx-brand/40 bg-yx-brand-soft text-yx-brand'
                          : project.isExample
                              ? 'border-amber-200 bg-amber-50 text-amber-600'
                              : 'border-yx-line bg-yx-surface text-yx-muted group-hover:border-yx-brand/40 group-hover:text-yx-brand')}
                    >
                      {String(projectIndex + 1).padStart(2, '0')}
                    </span>
                    <span className="relative -top-px min-w-0 truncate leading-4" title={project.title}>
                      {project.title}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {isPinned && (
                      <span className="inline-flex items-center gap-0.5 rounded-full border border-yx-brand/20 bg-yx-brand-soft px-1.5 py-0.5 text-[9px] font-semibold leading-none text-yx-brand-strong" title="当前负责人">
                        <Pin className="size-2.5" strokeWidth={2.4} aria-hidden="true" />
                        置顶
                      </span>
                    )}
                    {project.isExample && (
                      <span className="shrink-0 rounded border border-amber-200 bg-amber-50 px-1 py-0.5 text-[9px] font-semibold leading-none text-amber-700">
                        示例
                      </span>
                    )}
                  </div>
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function MainNavigationPanel({
  activeNav,
  onNavigate,
  projects,
  currentUserId,
  activeProjectId,
  onSelectProject,
  onOpenProjectGuide,
  reportCount,
  knowledgeCount,
  onSearch,
  mobile = false,
}: {
  activeNav: 'overview' | 'reports' | 'knowledge' | 'project'
  onNavigate: (nav: 'overview' | 'reports' | 'knowledge') => void
  projects: ProjectWithCapabilities[]
  currentUserId?: string
  activeProjectId?: string
  onSelectProject: (project: ProjectWithCapabilities) => void
  onOpenProjectGuide: () => void
  reportCount?: number
  knowledgeCount?: number
  onSearch: () => void
  mobile?: boolean
}) {
  const navigationProjects = useMemo(() => prioritizeOwnedProjects(projects, currentUserId), [currentUserId, projects])
  const [projectsExpanded, setProjectsExpanded] = useState(true)

  function handleProjectsTabClick() {
    if (activeNav !== 'project') {
      setProjectsExpanded(true)
      const ownProjects = navigationProjects.filter((p) => !p.isExample)
      const targetProject = ownProjects.find((p) => p.id === activeProjectId) || ownProjects[0]
      if (targetProject) {
        onSelectProject(targetProject)
      } else {
        onOpenProjectGuide()
      }
    } else {
      setProjectsExpanded((prev) => !prev)
    }
  }
  const panelClassName = mobile
    ? 'flex min-h-0 flex-1 flex-col bg-yx-paper'
    : 'hidden min-h-0 flex-col bg-yx-paper sm:col-start-1 sm:row-start-1 sm:row-span-2 sm:flex sm:border-r sm:border-yx-line'

  return (
    <WorkspaceSidebar aria-label="工作台导航" className={panelClassName}>
      <div className="flex w-full shrink-0 justify-center pt-6 pb-2.5">
        <WorkspaceBrandHeader />
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-3 pt-2 lg:p-4 lg:pt-2">
        <button
          type="button"
          aria-label="搜索课题与报告"
          onClick={onSearch}
          className="flex h-10 w-full items-center gap-2.5 rounded-md border border-yx-line bg-yx-surface px-2.5 text-left text-sm text-yx-ink shadow-2xs transition-colors hover:bg-yx-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yx-brand"
        >
          <Search className="h-4 w-4 shrink-0 text-yx-muted" />
          <span className="min-w-0 flex-1 font-medium">搜索</span>
          <kbd className="rounded border border-yx-line bg-yx-paper px-1 text-[10px] text-yx-muted">⌘K</kbd>
        </button>

        <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-y-auto yx-subtle-scrollbar pr-0.5">
          <div className="space-y-1">
            {/* 1. 总览 */}
            <button
              type="button"
              onClick={() => onNavigate('overview')}
              aria-current={activeNav === 'overview' ? 'page' : undefined}
              className={`flex h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm transition-all ${
                activeNav === 'overview'
                  ? 'bg-yx-brand-strong font-semibold text-white'
                  : 'text-yx-ink hover:bg-yx-hover'
              }`}
            >
              <Layers3 className={`h-[17px] w-[17px] shrink-0 ${activeNav === 'overview' ? 'text-white' : 'text-yx-muted'}`} />
              <span className="flex-1 truncate">总览</span>
            </button>

            {/* 2. 课题 (折叠/展开 + 课题列表) */}
            <div>
              <button
                type="button"
                onClick={handleProjectsTabClick}
                aria-current={activeNav === 'project' ? 'page' : undefined}
                className={`flex h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm transition-all ${
                  activeNav === 'project'
                    ? 'bg-yx-brand-strong font-semibold text-white'
                    : 'text-yx-ink hover:bg-yx-hover'
                }`}
              >
                <FolderKanban className={`h-[17px] w-[17px] shrink-0 ${activeNav === 'project' ? 'text-white' : 'text-yx-muted'}`} />
                <span className="flex-1 truncate">课题</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  activeNav === 'project' ? 'bg-white/20 text-white' : 'bg-yx-line text-yx-muted'
                }`}>
                  {navigationProjects.length}
                </span>
              </button>

              {projectsExpanded && (
                <ProjectNavigationList
                  activeNav={activeNav}
                  activeProjectId={activeProjectId}
                  onSelectProject={onSelectProject}
                  projects={navigationProjects}
                  currentUserId={currentUserId}
                />
              )}
            </div>
            {/* 3. 报告库 */}
            <button
              type="button"
              onClick={() => onNavigate('reports')}
              aria-current={activeNav === 'reports' ? 'page' : undefined}
              className={`flex h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm transition-all ${
                activeNav === 'reports'
                  ? 'bg-yx-brand-strong font-semibold text-white'
                  : 'text-yx-ink hover:bg-yx-hover'
              }`}
            >
              <FileText className={`h-[17px] w-[17px] shrink-0 ${activeNav === 'reports' ? 'text-white' : 'text-yx-muted'}`} />
              <span className="flex-1 truncate">报告库</span>
              {reportCount !== undefined && (
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  activeNav === 'reports' ? 'bg-white/20 text-white' : 'bg-yx-line text-yx-muted'
                }`}>
                  {reportCount}
                </span>
              )}
            </button>

            {/* 4. 知识库 */}
            <button
              type="button"
              onClick={() => onNavigate('knowledge')}
              aria-current={activeNav === 'knowledge' ? 'page' : undefined}
              className={`flex h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm transition-all ${
                activeNav === 'knowledge'
                  ? 'bg-yx-brand-strong font-semibold text-white'
                  : 'text-yx-ink hover:bg-yx-hover'
              }`}
            >
              <BookOpen className={`h-[17px] w-[17px] shrink-0 ${activeNav === 'knowledge' ? 'text-white' : 'text-yx-muted'}`} />
              <span className="flex-1 truncate">知识库</span>
              {knowledgeCount !== undefined && (
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  activeNav === 'knowledge' ? 'bg-white/20 text-white' : 'bg-yx-line text-yx-muted'
                }`}>
                  {knowledgeCount}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* 底部常驻操作：新建课题 */}
        <div className="mt-3 shrink-0 pt-3 border-t border-yx-line/80">
          <button
            type="button"
            onClick={onOpenProjectGuide}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-yx-brand px-3 text-xs font-bold text-white shadow-2xs transition-all hover:bg-yx-brand-hover hover:shadow-xs active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yx-brand"
          >
            <Plus className="h-4 w-4 text-white" strokeWidth={2.4} />
            <span>新建课题</span>
          </button>
        </div>
      </div>
    </WorkspaceSidebar>
  )
}

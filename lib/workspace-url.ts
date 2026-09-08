export type WorkspaceView = 'overview' | 'reports' | 'knowledge' | 'dashboard' | 'history' | 'insight' | 'content' | 'project-guide'
export type WorkspaceUrlState = { view: WorkspaceView; projectId: string; reportId?: string }

const projectWorkspaceViews = new Set<WorkspaceView>(['dashboard', 'history', 'insight', 'content'])
const knownWorkspaceViews = new Set<WorkspaceView>(['overview', 'reports', 'knowledge', ...projectWorkspaceViews, 'project-guide'])

export function parseWorkspaceSearch(search: string): WorkspaceUrlState {
  const params = new URLSearchParams(search)
  const requestedView = params.get('view') as WorkspaceView | null
  const requestedProjectId = params.get('project') ?? ''
  const requestedReportId = params.get('report') || undefined
  const requested = requestedView && knownWorkspaceViews.has(requestedView)
    ? requestedView
    : requestedProjectId
      ? 'dashboard'
      : 'overview'
  const view = projectWorkspaceViews.has(requested) && !requestedProjectId ? 'overview' : requested
  const projectId = projectWorkspaceViews.has(view) ? requestedProjectId : ''
  const reportId = projectWorkspaceViews.has(view) ? requestedReportId : undefined
  return reportId ? { view, projectId, reportId } : { view, projectId }
}

export function buildWorkspaceSearch(state: WorkspaceUrlState): string {
  const params = new URLSearchParams()
  if (state.view !== 'overview') params.set('view', state.view)
  if (projectWorkspaceViews.has(state.view) && state.projectId) params.set('project', state.projectId)
  if (projectWorkspaceViews.has(state.view) && state.reportId) params.set('report', state.reportId)
  const query = params.toString()
  return query ? `?${query}` : ''
}

export function readWorkspaceUrl(): WorkspaceUrlState {
  if (typeof window === 'undefined') return { view: 'overview', projectId: '' }
  return parseWorkspaceSearch(window.location.search)
}

export function buildWorkspaceUrl(state: WorkspaceUrlState): string {
  if (typeof window === 'undefined') return '/'
  return `${window.location.pathname}${buildWorkspaceSearch(state)}${window.location.hash}`
}

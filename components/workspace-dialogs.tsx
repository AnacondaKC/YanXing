'use client'

import { AdminSettingsDialog } from '@/components/admin-settings'
import { DeleteProjectDialog, DeleteReportDialog, EditProjectDialog, ReplaceReportDialog } from '@/components/project-management-dialogs'
import { ProjectProgressDialog } from '@/components/project-progress-dialog'
import { ReportStageAssignmentDialog } from '@/components/report-stage-assignment-dialog'
import { EditProfileDialog, HelpTipsDialog } from '@/components/workspace-user-nav'
import { WorkspaceSearchDialog } from '@/components/workspace-search-dialog'
import type { ProjectWithCapabilities } from '@/modules/projects/domain'
import type { ReportVersion } from '@/modules/reports/domain'
import type { SessionUser } from '@/modules/users/domain'

type WorkspaceDialogsProps = {
  currentUser?: SessionUser
  users: SessionUser[]
  projects: ProjectWithCapabilities[]
  hiddenProjectIds: string[]
  settingsOpen: boolean
  editTarget?: ProjectWithCapabilities
  deleteTarget?: ProjectWithCapabilities
  deleteReportTarget?: ReportVersion
  replaceReportTarget?: ReportVersion
  reportStageAssignmentTarget?: ReportVersion
  activeProject?: ProjectWithCapabilities
  editProfileOpen: boolean
  helpOpen: boolean
  searchOpen: boolean
  progressDialogOpen: boolean
  progressDialogMilestoneId?: string
  onToggleHideProject: (projectId: string) => void
  onCloseSettings: () => void
  onEditProject: (project: ProjectWithCapabilities) => void
  onDeleteProject: (project: ProjectWithCapabilities) => void
  onProjectsChanged: () => void
  onCloseEditProject: () => void
  onProjectUpdated: (project: ProjectWithCapabilities) => void
  onCloseDeleteProject: () => void
  onProjectDeleted: (projectId: string) => void
  onCloseDeleteReport: () => void
  onReportDeleted: (report: ReportVersion) => void
  onCloseReplaceReport: () => void
  onReportReplaced: (report: ReportVersion) => void
  onCloseStageAssignment: () => void
  onStageAssigned: (report: ReportVersion) => void
  onCloseProfile: () => void
  onProfileUpdated: (user: SessionUser) => void
  onCloseHelp: () => void
  onCloseSearch: () => void
  onSearchSelect: (project: ProjectWithCapabilities) => void
  onCloseProgress: () => void
  onProgressSaved: (project: ProjectWithCapabilities) => void
  onReportAssigned: (report: ReportVersion) => void
  onReportUploaded: (report: ReportVersion, submitted: { projectId: string; viewGeneration: number }) => void
  viewGeneration: number
}

export function WorkspaceDialogs(props: WorkspaceDialogsProps) {
  const {
    currentUser, users, projects, hiddenProjectIds, settingsOpen, editTarget, deleteTarget,
    deleteReportTarget, replaceReportTarget, reportStageAssignmentTarget, activeProject, editProfileOpen,
    helpOpen, searchOpen, progressDialogOpen, progressDialogMilestoneId,
  } = props

  return (
    <>
      {settingsOpen && (
        <AdminSettingsDialog
          currentUser={currentUser}
          projects={projects}
          hiddenProjectIds={hiddenProjectIds}
          onToggleHideProject={props.onToggleHideProject}
          onClose={props.onCloseSettings}
          onEditProject={props.onEditProject}
          onDeleteProject={props.onDeleteProject}
          onProjectsChanged={props.onProjectsChanged}
        />
      )}
      {editTarget && <EditProjectDialog project={editTarget} users={users} currentUser={currentUser} onClose={props.onCloseEditProject} onUpdated={props.onProjectUpdated} />}
      {deleteTarget && <DeleteProjectDialog project={deleteTarget} onClose={props.onCloseDeleteProject} onDeleted={props.onProjectDeleted} />}
      {deleteReportTarget && <DeleteReportDialog report={deleteReportTarget} onClose={props.onCloseDeleteReport} onDeleted={props.onReportDeleted} />}
      {replaceReportTarget && <ReplaceReportDialog report={replaceReportTarget} onClose={props.onCloseReplaceReport} onReplaced={props.onReportReplaced} />}
      {reportStageAssignmentTarget && activeProject && (
        <ReportStageAssignmentDialog
          project={activeProject}
          report={reportStageAssignmentTarget}
          onClose={props.onCloseStageAssignment}
          onSaved={props.onStageAssigned}
        />
      )}
      {editProfileOpen && currentUser && <EditProfileDialog user={currentUser} onClose={props.onCloseProfile} onUpdated={props.onProfileUpdated} />}
      {helpOpen && <HelpTipsDialog onClose={props.onCloseHelp} />}
      {searchOpen && (
        <WorkspaceSearchDialog
          projects={projects}
          onClose={props.onCloseSearch}
          onSelect={props.onSearchSelect}
        />
      )}
      {progressDialogOpen && activeProject && (
        <ProjectProgressDialog
          project={activeProject}
          defaultMilestoneId={progressDialogMilestoneId}
          onClose={props.onCloseProgress}
          onSaved={props.onProgressSaved}
          onReportAssigned={props.onReportAssigned}
          onReportUploaded={props.onReportUploaded}
          viewGeneration={props.viewGeneration}
        />
      )}
    </>
  )
}

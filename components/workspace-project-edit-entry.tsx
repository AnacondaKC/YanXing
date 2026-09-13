'use client'

import { useEffect, useState } from 'react'
import { WorkspaceProjectEditDialog } from '@/components/workspace-project-edit-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '@/components/ui/dialog'
import { FormError } from '@/components/ui/field'
import { fetchWorkspaceProject } from '@/lib/workspace-submission-client'
import type { WorkspaceProjectDetail } from '@/lib/workspace-submission'
import type { SessionUser } from '@/modules/users/domain'

type ProjectEditLoad =
  | { status: 'loading' }
  | { status: 'ready'; detail: WorkspaceProjectDetail }
  | { status: 'error'; message: string }

export function WorkspaceProjectEditEntry({ projectId, currentUser, onClose, onSaved }: {
  projectId: string
  currentUser?: SessionUser
  onClose: () => void
  onSaved: (detail: WorkspaceProjectDetail) => void
}) {
  const [load, setLoad] = useState<ProjectEditLoad>({ status: 'loading' })
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoad({ status: 'loading' })
    void fetchWorkspaceProject(projectId, controller.signal)
      .then((detail) => {
        if (controller.signal.aborted) return
        if (detail.project.id !== projectId) throw new Error('课题响应不匹配，请重新载入。')
        if (!detail.project.canManage) throw new Error('当前没有修改此课题配置的权限。')
        setLoad({ status: 'ready', detail })
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setLoad({ status: 'error', message: cause instanceof Error ? cause.message : '课题配置读取失败，请重试。' })
      })
    return () => controller.abort()
  }, [projectId, retry])

  if (load.status === 'ready' && load.detail.project.id === projectId && currentUser) {
    return <WorkspaceProjectEditDialog key={projectId} detail={load.detail} currentUser={currentUser} onClose={onClose} onSaved={onSaved} />
  }

  return (
    <Dialog onClose={onClose} labelledBy="project-edit-loading-title" size="4xl" zIndex={70}>
      <DialogHeader titleId="project-edit-loading-title" title="修改课题配置" onClose={onClose} />
      <DialogBody>
        {load.status === 'error' ? <FormError>{load.message}</FormError> : <p role="status" className="py-8 text-center text-xs text-yx-muted">正在读取课题配置…</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>取消</Button>
        {load.status === 'error' ? <Button onClick={() => setRetry((value) => value + 1)}>重新载入</Button> : null}
      </DialogFooter>
    </Dialog>
  )
}

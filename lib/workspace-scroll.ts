type OverflowTarget = { style: { overflow: string } }

const SCROLL_MEASUREMENT_TOLERANCE = 2

export function shouldLockOverviewScroll(scrollHeight: number, clientHeight: number) {
  return scrollHeight <= clientHeight + SCROLL_MEASUREMENT_TOLERANCE
}

export function applyFullscreenScrollLock(workspace: OverflowTarget | null, documentElement: OverflowTarget, body: OverflowTarget) {
  const previousWorkspaceOverflow = workspace?.style.overflow
  const previousDocumentOverflow = documentElement.style.overflow
  const previousBodyOverflow = body.style.overflow

  if (workspace) workspace.style.overflow = 'hidden'
  documentElement.style.overflow = 'hidden'
  body.style.overflow = 'hidden'

  return () => {
    if (workspace) workspace.style.overflow = previousWorkspaceOverflow ?? ''
    documentElement.style.overflow = previousDocumentOverflow
    body.style.overflow = previousBodyOverflow
  }
}

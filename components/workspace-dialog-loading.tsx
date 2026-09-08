'use client'

import { Dialog, DialogCloseButton } from '@/components/ui/dialog'

export function WorkspaceDialogLoading({ onClose }: { onClose?: () => void }) {
  if (!onClose) {
    return <div role="status" className="fixed bottom-6 right-6 z-50 rounded-lg border border-yx-line bg-yx-paper px-4 py-3 text-xs text-yx-muted shadow-lg">正在载入…</div>
  }

  return (
    <Dialog onClose={onClose} label="主要设置" size="5xl" className="p-3 sm:p-6" panelClassName="flex h-[min(50rem,calc(100vh-1.5rem))] flex-col sm:h-[min(50rem,calc(100vh-3rem))] md:flex-row">
      <DialogCloseButton onClose={onClose} label="关闭设置" className="absolute right-3.5 top-3.5 z-20 sm:right-4 sm:top-4" />
      <aside className="w-full shrink-0 border-b border-yx-line bg-yx-surface p-4 md:w-56 md:border-b-0 md:border-r">
        <p className="text-xs font-semibold text-yx-ink">主要设置</p>
      </aside>
      <div role="status" className="flex flex-1 items-center justify-center p-8 text-xs text-yx-muted">正在载入设置…</div>
    </Dialog>
  )
}

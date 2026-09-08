import type { HTMLAttributes, ReactNode } from 'react'

export function WorkspaceTopbar({ brand, tools, className = '' }: { brand?: ReactNode; tools?: ReactNode; className?: string }) {
  return (
    <header className={`yx-topbar sticky top-0 z-20 flex h-[3.25rem] items-center justify-between border-b border-yx-line bg-yx-paper px-4 sm:col-start-2 sm:row-start-1 sm:px-6 lg:px-8 ${className}`}>
      {brand}
      <div className="flex items-center gap-1.5">{tools}</div>
    </header>
  )
}

export function WorkspaceSidebar({ className = '', children, ...props }: HTMLAttributes<HTMLElement>) {
  return <aside {...props} className={className}>{children}</aside>
}

export function WorkspacePageHeader({ children }: { children: ReactNode }) {
  return <header className="yx-page-header min-w-0">{children}</header>
}

'use client'

import { FolderKanban, Search, X } from 'lucide-react'
import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Dialog } from '@/components/ui/dialog'
import type { ProjectWithCapabilities } from '@/modules/projects/domain'

export function WorkspaceSearchDialog({
  projects,
  onClose,
  onSelect,
}: {
  projects: ProjectWithCapabilities[]
  onClose: () => void
  onSelect: (project: ProjectWithCapabilities) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')

  const results = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    const matched = keyword
      ? projects.filter((project) => {
          const haystack = [project.title, project.ownerName, project.objective].join(' ').toLowerCase()
          return haystack.includes(keyword)
        })
      : projects
    return matched.slice(0, 20)
  }, [projects, query])

  function submit(event: FormEvent) {
    event.preventDefault()
    if (results[0]) onSelect(results[0])
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && results[0]) {
      event.preventDefault()
      onSelect(results[0])
    }
  }

  return (
    <Dialog
      onClose={onClose}
      labelledBy="workspace-search-title"
      size="lg"
      zIndex={80}
      align="top"
      initialFocusRef={inputRef}
      panelClassName="overflow-hidden"
    >
      <form onSubmit={submit} className="flex items-center gap-2 border-b border-yx-hover px-3 py-2.5">
        <Search className="h-4 w-4 shrink-0 text-yx-faint" />
        <h2 id="workspace-search-title" className="sr-only">搜索课题</h2>
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="搜索课题名称、负责人或研究目标"
          className="min-w-0 flex-1 bg-transparent text-sm text-yx-ink outline-none placeholder:text-yx-faint"
          autoComplete="off"
        />
        <kbd className="hidden rounded border border-yx-line bg-yx-surface px-1.5 py-0.5 text-[10px] text-yx-muted sm:inline">Esc</kbd>
        <button type="button" onClick={onClose} aria-label="关闭搜索" className="flex h-7 w-7 items-center justify-center rounded-md text-yx-muted hover:bg-yx-hover hover:text-yx-ink">
          <X className="h-4 w-4" />
        </button>
      </form>
      <div className="max-h-[min(24rem,50vh)] overflow-y-auto p-2">
        {results.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-yx-muted">没有匹配的课题</p>
        ) : (
          <ul className="space-y-0.5">
            {results.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  onClick={() => onSelect(project)}
                  className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-yx-surface"
                >
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-yx-brand text-white">
                    <FolderKanban className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-yx-ink">{project.title}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-yx-muted">
                      {project.ownerName}{project.stage ? ' · ' + project.stage : ''}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  )
}

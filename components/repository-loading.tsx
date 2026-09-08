export type RepositoryDataState = 'loading' | 'ready' | 'error'

export function RepositoryLoading({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label + '正在加载'} className="space-y-3">
      <p className="text-[11px] text-yx-muted">正在加载{label}…</p>
      {[0, 1].map((row) => (
        <div key={row} aria-hidden="true" className="flex items-center gap-3 rounded-lg border border-yx-line bg-yx-paper px-4 py-3">
          <span className="yx-repository-skeleton h-4 w-4 shrink-0 !rounded-full" />
          <span className="yx-repository-skeleton h-4 w-36 max-w-[45%]" />
          <span className="yx-repository-skeleton ml-auto h-4 w-24 sm:w-48" />
        </div>
      ))}
    </div>
  )
}

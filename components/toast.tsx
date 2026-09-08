import { Check } from 'lucide-react'

export function Toast({ message }: { message: string }) {
  return (
    <div className="fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full bg-yx-ink px-4 py-2.5 text-[10px] font-medium text-white shadow-lg sm:text-xs">
      <Check className="h-3.5 w-3.5 text-yx-brand-bright" />
      {message}
    </div>
  )
}

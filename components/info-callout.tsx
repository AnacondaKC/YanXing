import type { CSSProperties } from 'react'
import type { LucideIcon } from 'lucide-react'

type InfoCalloutTone = 'brand' | 'muted'

const TYPE_WORD_EMS = [2.6, 1.15, 3.2, 1.7, 2.3, 1.4] as const

export function InfoCallout({ icon: Icon, label, text, tone = 'brand', scanning, scanDelay = '0ms' }: { icon: LucideIcon; label: string; text?: string; tone?: InfoCalloutTone; scanning?: boolean; scanDelay?: string }) {
  const toneClass = tone === 'brand' ? 'bg-yx-brand-soft text-yx-brand-hover' : 'bg-yx-surface text-yx-ink'
  const labelClass = tone === 'muted' ? 'text-yx-ink' : ''
  const iconClass = tone === 'brand' ? 'text-yx-brand-hover' : 'text-yx-faint'
  const normalizedText = (text ?? '').replace(/\s+/g, ' ').trim()
  return (
    <div className={`yx-info-callout flex h-[30px] w-full min-w-0 max-w-full items-center gap-1.5 overflow-hidden rounded-md px-2.5 text-[10px] leading-relaxed ${toneClass}`}>
      <Icon className={`h-3 w-3 shrink-0 ${iconClass}`} />
      <span className={`shrink-0 whitespace-nowrap font-semibold ${labelClass}`}>{label}：</span>
      {scanning ? (
        <span className="yx-callout-type" style={{ '--yx-bar-delay': scanDelay } as CSSProperties} aria-hidden="true">
          <span className="yx-callout-type__reveal">
            <span className="yx-callout-type__words">
              {TYPE_WORD_EMS.map((widthEm, index) => (
                <span key={index} className="yx-callout-type__word" style={{ width: `${widthEm}em` }} />
              ))}
            </span>
          </span>
          <span className="yx-callout-type__caret" />
        </span>
      ) : (
        <span className="yx-info-callout__text flex-1" title={text}>{normalizedText}</span>
      )}
    </div>
  )
}

import * as React from 'react'

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  textareaSize?: 'sm' | 'md' | 'lg'
}

/**
 * 研行通用多行文本域组件（以标准搜索框样式为基准规范）
 *
 * 规范：浅灰纸质底色 (bg-yx-surface) + 细灰边框 (border-yx-line) + 聚焦变白并亮起翡翠绿微光 (focus:border-yx-brand focus:bg-yx-paper focus:ring-2 focus:ring-yx-brand/15)
 */
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className = '', textareaSize = 'md', ...props }, ref) => {
    const sizeClass = {
      sm: 'p-2 text-xs',
      md: 'p-3 text-xs leading-relaxed',
      lg: 'p-3.5 text-sm leading-relaxed',
    }[textareaSize]

    return (
      <textarea
        ref={ref}
        className={`w-full resize-none rounded-lg border border-yx-line bg-yx-surface text-yx-ink placeholder:font-normal placeholder:text-yx-faint shadow-2xs transition-all focus:border-yx-brand focus:bg-yx-paper focus:outline-none focus:ring-2 focus:ring-yx-brand/15 disabled:cursor-not-allowed disabled:opacity-50 ${sizeClass} ${className}`}
        {...props}
      />
    )
  }
)
Textarea.displayName = 'Textarea'

import * as React from 'react'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  inputSize?: 'sm' | 'md' | 'lg'
}

/**
 * 研行通用输入框组件（以标准搜索框样式为基准规范）
 *
 * 规范：浅灰纸质底色 (bg-yx-surface) + 细灰边框 (border-yx-line) + 聚焦变白并亮起翡翠绿微光 (focus:border-yx-brand focus:bg-yx-paper focus:ring-2 focus:ring-yx-brand/15)
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className = '', inputSize = 'md', type = 'text', ...props }, ref) => {
    const sizeClass = {
      sm: 'h-8 px-2.5 text-xs',
      md: 'h-9 px-3 text-xs sm:text-sm',
      lg: 'h-11 px-3.5 text-sm sm:text-base font-semibold',
    }[inputSize]

    return (
      <input
        type={type}
        ref={ref}
        className={`w-full rounded-lg border border-yx-line bg-yx-surface text-yx-ink placeholder:font-normal placeholder:text-yx-faint shadow-2xs transition-all focus:border-yx-brand focus:bg-yx-paper focus:outline-none focus:ring-2 focus:ring-yx-brand/15 disabled:cursor-not-allowed disabled:opacity-50 ${sizeClass} ${className}`}
        {...props}
      />
    )
  }
)
Input.displayName = 'Input'

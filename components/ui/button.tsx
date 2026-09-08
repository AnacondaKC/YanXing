'use client'

import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { cx } from '@/lib/cn'

export type ButtonVariant = 'primary' | 'danger' | 'ghost' | 'outline' | 'icon'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
}

const variantClass: Record<ButtonVariant, string> = {
  primary: 'bg-yx-brand text-white shadow-xs hover:bg-yx-brand-hover',
  danger: 'bg-yx-danger text-white shadow-xs hover:bg-red-600',
  ghost: 'text-yx-muted hover:bg-yx-hover hover:text-yx-ink',
  outline: 'border border-yx-line bg-yx-paper text-yx-ink-soft shadow-2xs hover:bg-yx-hover',
  icon: 'text-yx-muted hover:bg-yx-hover hover:text-yx-ink',
}

const sizeClass: Record<ButtonSize, string> = {
  sm: 'h-7 px-3 text-xs',
  md: 'h-8 px-4 text-xs',
  lg: 'h-9 px-5 text-xs font-bold',
}

const iconSizeClass: Record<ButtonSize, string> = {
  sm: 'h-7 w-7',
  md: 'h-8 w-8',
  lg: 'h-9 w-9',
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', loading = false, className = '', type = 'button', disabled, children, ...props }, ref) => {
    const isIcon = variant === 'icon'
    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled || loading}
        className={cx(
          'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          variantClass[variant],
          isIcon ? iconSizeClass[size] : sizeClass[size],
          className,
        )}
        {...props}
      >
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {children}
      </button>
    )
  },
)
Button.displayName = 'Button'

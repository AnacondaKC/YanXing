import type { LucideIcon } from 'lucide-react'

export interface IconBadgeProps {
  icon: LucideIcon
  variant?: 'emerald'
  size?: 'md' | 'lg'
  rounded?: 'md' | 'lg' | 'xl' | 'full'
  className?: string
}

const VARIANT_MAP = {
  emerald: 'bg-yx-brand text-white shadow-2xs',
} as const

const SIZE_MAP = {
  md: { container: 'h-7 w-7', icon: 'h-4 w-4' },
  lg: { container: 'h-8 w-8', icon: 'h-4.5 w-4.5' },
} as const

const ROUNDED_MAP = {
  md: 'rounded-md',
  lg: 'rounded-lg',
  xl: 'rounded-xl',
  full: 'rounded-full',
} as const

/**
 * 通用图标徽章模版：默认即为「翠绿强调色底色 + 白色图标」
 *
 * @example
 * ```tsx
 * <IconBadge icon={FolderKanban} />
 * <IconBadge icon={Rocket} size="lg" rounded="xl" />
 * <IconBadge icon={Sparkles} />
 * ```
 */
export function IconBadge({
  icon: Icon,
  variant = 'emerald',
  size = 'md',
  rounded = 'lg',
  className = '',
}: IconBadgeProps) {
  const variantClass = VARIANT_MAP[variant] ?? VARIANT_MAP.emerald
  const sizeConfig = SIZE_MAP[size] ?? SIZE_MAP.md
  const roundedClass = ROUNDED_MAP[rounded] ?? ROUNDED_MAP.lg

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center ${roundedClass} ${sizeConfig.container} ${variantClass} ${className}`}
    >
      <Icon className={`${sizeConfig.icon} text-white shrink-0`} />
    </span>
  )
}

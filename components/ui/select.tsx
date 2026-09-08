'use client'

import {
  Check,
  ChevronDown,
  Search,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

export function renderSelectIcon(icon: LucideIcon | ReactNode, className = 'h-3.5 w-3.5'): ReactNode {
  if (!icon) return null
  if (isValidElement(icon)) return icon
  if (typeof icon === 'function' || (typeof icon === 'object' && icon !== null)) {
    const IconComponent = icon as ComponentType<{ className?: string }>
    return <IconComponent className={className} />
  }
  return null
}

type DropdownPosition = {
  left: number
  top?: number
  bottom?: number
  width: number
  optionsMaxHeight: number
}

export type SelectOption = {
  value: string
  label: ReactNode
  textLabel?: string
  description?: string
  badge?: string
  badgeTone?: 'emerald' | 'amber' | 'sky' | 'gray' | 'red' | 'orange'
  disabled?: boolean
  icon?: LucideIcon | ReactNode
}

export type SelectGroup = {
  group: string
  options: SelectOption[]
}

export type SelectItem = SelectOption | SelectGroup

export function isSelectGroup(item: SelectItem): item is SelectGroup {
  return 'group' in item && Array.isArray(item.options)
}

export const selectBadgeToneStyles = {
  emerald: 'bg-yx-brand-soft text-yx-brand-hover border border-yx-brand-soft',
  amber: 'bg-yx-warning-soft text-yx-warning-text border border-yx-warning-soft',
  orange: 'bg-yx-warning-soft text-yx-warning-text border border-yx-warning-soft',
  sky: 'bg-yx-brand-soft text-yx-brand-hover border border-yx-brand-soft',
  gray: 'bg-yx-surface text-yx-muted border border-yx-line',
  red: 'bg-yx-danger-soft text-yx-danger-text border border-yx-danger-soft',
} as const

function sameDropdownPosition(current: DropdownPosition | undefined, next: DropdownPosition) {
  return Boolean(
    current
    && current.left === next.left
    && current.width === next.width
    && current.top === next.top
    && current.bottom === next.bottom
    && current.optionsMaxHeight === next.optionsMaxHeight
  )
}

export interface CustomSelectProps {
  id?: string
  name?: string
  value?: string
  defaultValue?: string
  onChange?: (value: string) => void
  options: SelectItem[]
  placeholder?: string
  disabled?: boolean
  className?: string
  menuClassName?: string
  size?: 'sm' | 'md' | 'lg'
  variant?: 'white' | 'notion'
  searchable?: boolean
  searchPlaceholder?: string
  ariaLabel?: string
  emptyText?: string
}

export function CustomSelect({
  id: explicitId,
  name,
  value: controlledValue,
  defaultValue = '',
  onChange,
  options,
  placeholder = '请选择…',
  disabled = false,
  className = '',
  menuClassName = '',
  size = 'md',
  variant = 'notion',
  searchable = false,
  searchPlaceholder = '搜索选项…',
  ariaLabel,
  emptyText = '无匹配选项',
}: CustomSelectProps) {
  const generatedId = useId()
  const id = explicitId ?? generatedId
  const [internalValue, setInternalValue] = useState(defaultValue)
  const isControlled = controlledValue !== undefined
  const currentValue = isControlled ? controlledValue : internalValue

  const [isOpen, setIsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const [dropUp, setDropUp] = useState(false)
  const [dropdownPosition, setDropdownPosition] = useState<DropdownPosition>()

  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Flatten options for easy index navigation and lookup
  const flatOptions = useMemo(() => {
    const list: (SelectOption & { groupTitle?: string })[] = []
    for (const item of options) {
      if (isSelectGroup(item)) {
        for (const opt of item.options) {
          list.push({ ...opt, groupTitle: item.group })
        }
      } else {
        list.push(item)
      }
    }
    return list
  }, [options])

  const selectedOption = useMemo(() => {
    return flatOptions.find((opt) => opt.value === currentValue)
  }, [flatOptions, currentValue])

  // Filter options if search query is present
  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return options
    const query = searchQuery.toLowerCase().trim()

    const filterOption = (opt: SelectOption) => {
      const text = typeof opt.label === 'string' ? opt.label : opt.textLabel ?? ''
      return (
        text.toLowerCase().includes(query) ||
        opt.value.toLowerCase().includes(query) ||
        Boolean(opt.description?.toLowerCase().includes(query)) ||
        Boolean(opt.badge?.toLowerCase().includes(query))
      )
    }

    const result: SelectItem[] = []
    for (const item of options) {
      if (isSelectGroup(item)) {
        const filteredGroupOptions = item.options.filter(filterOption)
        if (filteredGroupOptions.length > 0) {
          result.push({ group: item.group, options: filteredGroupOptions })
        }
      } else if (filterOption(item)) {
        result.push(item)
      }
    }
    return result
  }, [options, searchQuery])

  const flatFilteredOptions = useMemo(() => {
    const list: (SelectOption & { groupTitle?: string })[] = []
    for (const item of filteredItems) {
      if (isSelectGroup(item)) {
        for (const opt of item.options) {
          list.push({ ...opt, groupTitle: item.group })
        }
      } else {
        list.push(item)
      }
    }
    return list
  }, [filteredItems])

  useEffect(() => {
    if (!isOpen) return
    const selectedIndex = flatFilteredOptions.findIndex((option) => option.value === currentValue && !option.disabled)
    setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : flatFilteredOptions.findIndex((option) => !option.disabled))
  }, [currentValue, flatFilteredOptions, isOpen])

  // Handle outside clicks
  useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (!containerRef.current?.contains(target) && !listboxRef.current?.contains(target)) {
        setIsOpen(false)
        setSearchQuery('')
        setDropdownPosition(undefined)
      }
    }
    document.addEventListener('mousedown', handleClickOutside, true)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true)
    }
  }, [isOpen])

  // Render in a portal so the menu is not clipped by cards or scroll containers.
  const updateDropdownPlacement = useCallback(() => {
    if (!triggerRef.current) return

    const viewportPadding = 8
    const gap = 6
    const rect = triggerRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom - viewportPadding - gap
    const spaceAbove = rect.top - viewportPadding - gap
    const estimatedHeight = Math.min(flatFilteredOptions.length * 38 + (searchable ? 48 : 12), 260)
    const shouldDropUp = spaceBelow < estimatedHeight && spaceAbove > spaceBelow
    const availableSpace = Math.max(0, shouldDropUp ? spaceAbove : spaceBelow)
    const width = Math.min(Math.max(rect.width, 200), window.innerWidth - viewportPadding * 2)
    const left = Math.min(
      Math.max(viewportPadding, rect.left),
      window.innerWidth - width - viewportPadding,
    )

    setDropUp(shouldDropUp)
    const nextPosition = {
      left,
      width,
      ...(shouldDropUp
        ? { bottom: window.innerHeight - rect.top + gap }
        : { top: rect.bottom + gap }),
      optionsMaxHeight: Math.max(40, Math.min(240, availableSpace - (searchable ? 48 : 12))),
    }
    setDropdownPosition((current) => sameDropdownPosition(current, nextPosition) ? current : nextPosition)
  }, [flatFilteredOptions.length, searchable])

  useEffect(() => {
    if (!isOpen) return
    const handleViewportChange = () => updateDropdownPlacement()
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    return () => {
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [isOpen, updateDropdownPlacement])

  const openMenu = useCallback(() => {
    if (disabled) return
    updateDropdownPlacement()
    setIsOpen(true)
    setSearchQuery('')
    const currentIndex = flatFilteredOptions.findIndex((opt) => opt.value === currentValue)
    setHighlightedIndex(currentIndex >= 0 ? currentIndex : 0)
    // Focus search input on open if searchable
    setTimeout(() => {
      if (searchable && searchInputRef.current) {
        searchInputRef.current.focus()
      }
    }, 20)
  }, [disabled, updateDropdownPlacement, flatFilteredOptions, currentValue, searchable])

  const closeMenu = useCallback(() => {
    setIsOpen(false)
    setSearchQuery('')
    setDropdownPosition(undefined)
    triggerRef.current?.focus()
  }, [])

  const handleSelect = useCallback(
    (value: string, isOptionDisabled?: boolean) => {
      if (isOptionDisabled || disabled) return
      if (!isControlled) {
        setInternalValue(value)
      }
      onChange?.(value)
      closeMenu()
    },
    [disabled, isControlled, onChange, closeMenu],
  )

  // Scroll active option into view
  useEffect(() => {
    if (!isOpen || highlightedIndex < 0 || !listboxRef.current) return
    const items = listboxRef.current.querySelectorAll('[data-select-option]')
    const target = items[highlightedIndex] as HTMLElement | undefined
    if (target) {
      target.scrollIntoView({ block: 'nearest' })
    }
  }, [highlightedIndex, isOpen])

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement | HTMLInputElement>) => {
    if (disabled) return

    if (!isOpen) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault()
        openMenu()
      }
      return
    }

    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault()
        let next = highlightedIndex + 1
        while (next < flatFilteredOptions.length && flatFilteredOptions[next]?.disabled) {
          next++
        }
        if (next < flatFilteredOptions.length) {
          setHighlightedIndex(next)
        }
        break
      }
      case 'ArrowUp': {
        event.preventDefault()
        let prev = highlightedIndex - 1
        while (prev >= 0 && flatFilteredOptions[prev]?.disabled) {
          prev--
        }
        if (prev >= 0) {
          setHighlightedIndex(prev)
        }
        break
      }
      case 'Enter': {
        event.preventDefault()
        if (highlightedIndex >= 0 && highlightedIndex < flatFilteredOptions.length) {
          const opt = flatFilteredOptions[highlightedIndex]
          if (opt && !opt.disabled) {
            handleSelect(opt.value)
          }
        }
        break
      }
      case 'Escape': {
        event.preventDefault()
        event.stopPropagation()
        closeMenu()
        break
      }
      case 'Tab': {
        setIsOpen(false)
        setSearchQuery('')
        setDropdownPosition(undefined)
        break
      }
    }
  }

  // Size styling variants
  const sizeClasses = {
    sm: 'min-h-8 px-2.5 py-1 text-xs',
    md: 'min-h-[36px] px-3 py-1.5 text-xs',
    lg: 'min-h-[42px] px-3.5 py-2 text-sm',
  }[size]

  // Variant styling
  const variantClasses = {
    notion: 'bg-yx-paper border border-yx-line text-yx-ink hover:bg-yx-hover hover:border-yx-brand shadow-2xs focus-visible:ring-2 focus-visible:ring-yx-brand/20 focus-visible:border-yx-brand',
    white: 'bg-yx-paper border border-yx-line text-yx-ink hover:bg-yx-hover hover:border-yx-brand shadow-2xs focus-visible:ring-2 focus-visible:ring-yx-brand/20 focus-visible:border-yx-brand',
  }[variant]

  let cumulativeIndex = 0

  return (
    <div ref={containerRef} className={`relative inline-block w-full text-left ${className}`}>
      {/* Hidden input for standard form compliance */}
      {name && <input type="hidden" name={name} value={currentValue} />}

      {/* Trigger Button */}
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        aria-controls={`${id}-listbox`}
        disabled={disabled}
        onClick={() => (isOpen ? closeMenu() : openMenu())}
        onKeyDown={handleKeyDown}
        className={`group flex w-full items-center justify-between gap-2 rounded-md text-left font-medium outline-none transition-all duration-150 ${sizeClasses} ${variantClasses} ${
          isOpen ? '!border-yx-brand ring-2 ring-yx-brand/15 bg-yx-paper shadow-xs' : ''
        } ${
          disabled ? 'cursor-not-allowed opacity-50 bg-gray-100/60' : 'cursor-pointer'
        }`}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {selectedOption?.icon && (
            <span className="shrink-0 text-yx-muted">
              {renderSelectIcon(selectedOption.icon, 'h-3.5 w-3.5')}
            </span>
          )}
          {selectedOption ? (
            <span className="truncate text-yx-ink font-medium">{selectedOption.label}</span>
          ) : (
            <span className="truncate text-yx-faint font-normal">{placeholder}</span>
          )}
        </span>

        {selectedOption?.badge && (
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none ${
              selectBadgeToneStyles[selectedOption.badgeTone ?? 'gray']
            }`}
          >
            {selectedOption.badge}
          </span>
        )}

        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-yx-muted transition-transform duration-200 ease-out group-hover:text-yx-brand ${
            isOpen ? 'rotate-180 text-yx-brand' : ''
          }`}
        />
      </button>

      {/* Popover Floating Listbox */}
      {isOpen && dropdownPosition && typeof document !== 'undefined' && createPortal(
        <div
          ref={listboxRef}
          id={`${id}-listbox`}
          role="listbox"
          tabIndex={-1}
          style={dropUp
            ? { left: dropdownPosition.left, bottom: dropdownPosition.bottom, width: dropdownPosition.width }
            : { left: dropdownPosition.left, top: dropdownPosition.top, width: dropdownPosition.width }}
          className={`fixed z-[999] overflow-hidden rounded-lg border border-yx-line bg-yx-paper p-1.5 shadow-lg ring-1 ring-black/5 transition-all duration-150 ${
            dropUp ? 'origin-bottom' : 'origin-top'
          } ${menuClassName}`}
        >
          {/* Optional Search Bar */}
          {searchable && (
            <div className="relative mb-1 px-1 pt-0.5">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={searchPlaceholder}
                className="h-8 w-full rounded-md border border-yx-line bg-yx-paper pl-8 pr-7 text-xs text-yx-ink placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-yx-brand focus:border-transparent transition-all"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 hover:text-gray-700"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          )}

          {/* Options Container */}
          <div className="yx-subtle-scrollbar max-h-60 overflow-y-auto space-y-0.5 overscroll-contain pr-0.5" style={{ maxHeight: dropdownPosition.optionsMaxHeight }}>
            {filteredItems.length === 0 ? (
              <div className="py-4 text-center text-xs text-gray-400 select-none">
                {emptyText}
              </div>
            ) : (
              filteredItems.map((item, itemIdx) => {
                if (isSelectGroup(item)) {
                  return (
                    <div key={`group-${item.group}-${itemIdx}`} className="py-1 first:pt-0">
                      <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-400 select-none">
                        {item.group}
                      </div>
                      <div className="space-y-0.5">
                        {item.options.map((option) => {
                          const optionIndex = cumulativeIndex++
                          const isSelected = option.value === currentValue
                          const isHighlighted = optionIndex === highlightedIndex

                          return (
                            <OptionRow
                              key={option.value}
                              option={option}
                              isSelected={isSelected}
                              isHighlighted={isHighlighted}
                              onSelect={() => handleSelect(option.value, option.disabled)}
                              onMouseEnter={() => setHighlightedIndex(optionIndex)}
                            />
                          )
                        })}
                      </div>
                    </div>
                  )
                }

                const optionIndex = cumulativeIndex++
                const isSelected = item.value === currentValue
                const isHighlighted = optionIndex === highlightedIndex

                return (
                  <OptionRow
                    key={item.value}
                    option={item}
                    isSelected={isSelected}
                    isHighlighted={isHighlighted}
                    onSelect={() => handleSelect(item.value, item.disabled)}
                    onMouseEnter={() => setHighlightedIndex(optionIndex)}
                  />
                )
              })
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

function OptionRow({
  option,
  isSelected,
  isHighlighted,
  onSelect,
  onMouseEnter,
}: {
  option: SelectOption
  isSelected: boolean
  isHighlighted: boolean
  onSelect: () => void
  onMouseEnter: () => void
}) {
  return (
    <div
      data-select-option
      role="option"
      aria-selected={isSelected}
      aria-disabled={option.disabled}
      onClick={onSelect}
      onMouseEnter={onMouseEnter}
      className={`group flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium select-none transition-colors duration-100 ${
        option.disabled
          ? 'cursor-not-allowed opacity-40 text-yx-faint'
          : 'cursor-pointer'
      } ${
        isSelected
          ? 'bg-yx-surface font-semibold text-yx-brand'
          : isHighlighted
          ? 'bg-yx-hover text-yx-ink'
          : 'text-yx-ink hover:bg-yx-hover hover:text-yx-brand'
      }`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {option.icon && (
          <span className="shrink-0 text-yx-muted group-hover:text-yx-brand">
            {renderSelectIcon(option.icon, 'h-3.5 w-3.5')}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate">{option.label}</div>
          {option.description && (
            <div className="mt-0.5 truncate text-[10px] text-yx-muted font-normal">
              {option.description}
            </div>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {option.badge && (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none ${
              selectBadgeToneStyles[option.badgeTone ?? 'gray']
            }`}
          >
            {option.badge}
          </span>
        )}
        {isSelected && (
          <Check className="h-3.5 w-3.5 shrink-0 text-yx-brand" />
        )}
      </div>
    </div>
  )
}

'use client'

import { Check, ChevronDown, Search, X } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { isSelectGroup, renderSelectIcon, selectBadgeToneStyles, type SelectItem, type SelectOption } from '@/components/ui/select'

type DropdownPosition = {
  left: number
  top?: number
  bottom?: number
  width: number
  optionsMaxHeight: number
}

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

export interface MultiSelectProps {
  id?: string
  name?: string
  value?: string[]
  defaultValue?: string[]
  onChange?: (value: string[]) => void
  options: SelectItem[]
  placeholder?: string
  disabled?: boolean
  className?: string
  menuClassName?: string
  searchable?: boolean
  searchPlaceholder?: string
  ariaLabel?: string
  emptyText?: string
  multipleLabel?: (count: number) => ReactNode
}

export function MultiSelect({
  id: explicitId,
  name,
  value: controlledValue,
  defaultValue = [],
  onChange,
  options,
  placeholder = '请选择…',
  disabled = false,
  className = '',
  menuClassName = '',
  searchable = false,
  searchPlaceholder = '搜索选项…',
  ariaLabel,
  emptyText = '无匹配选项',
  multipleLabel,
}: MultiSelectProps) {
  const generatedId = useId()
  const id = explicitId ?? generatedId
  const [internalValue, setInternalValue] = useState(defaultValue)
  const isControlled = controlledValue !== undefined
  const currentValue = isControlled ? controlledValue : internalValue
  const selectedValues = useMemo(() => new Set(currentValue), [currentValue])
  const [isOpen, setIsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const [dropUp, setDropUp] = useState(false)
  const [dropdownPosition, setDropdownPosition] = useState<DropdownPosition>()
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const flatOptions = useMemo(() => {
    const list: SelectOption[] = []
    for (const item of options) {
      if (isSelectGroup(item)) list.push(...item.options)
      else list.push(item)
    }
    return list
  }, [options])

  const selectedOptions = useMemo(
    () => flatOptions.filter((option) => selectedValues.has(option.value)),
    [flatOptions, selectedValues],
  )

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return options
    const query = searchQuery.toLowerCase().trim()
    const matches = (option: SelectOption) => {
      const label = typeof option.label === 'string' ? option.label : option.textLabel ?? ''
      return (
        label.toLowerCase().includes(query) ||
        option.value.toLowerCase().includes(query) ||
        Boolean(option.description?.toLowerCase().includes(query)) ||
        Boolean(option.badge?.toLowerCase().includes(query))
      )
    }
    const result: SelectItem[] = []
    for (const item of options) {
      if (isSelectGroup(item)) {
        const groupOptions = item.options.filter(matches)
        if (groupOptions.length) result.push({ group: item.group, options: groupOptions })
      } else if (matches(item)) {
        result.push(item)
      }
    }
    return result
  }, [options, searchQuery])

  const flatFilteredOptions = useMemo(() => {
    const list: SelectOption[] = []
    for (const item of filteredItems) {
      if (isSelectGroup(item)) list.push(...item.options)
      else list.push(item)
    }
    return list
  }, [filteredItems])

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
    const width = Math.min(Math.max(rect.width, 220), window.innerWidth - viewportPadding * 2)
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
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (!containerRef.current?.contains(target) && !listboxRef.current?.contains(target)) {
        setIsOpen(false)
        setSearchQuery('')
        setDropdownPosition(undefined)
      }
    }
    document.addEventListener('mousedown', handleClickOutside, true)
    return () => document.removeEventListener('mousedown', handleClickOutside, true)
  }, [isOpen])

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

  const closeMenu = useCallback(() => {
    setIsOpen(false)
    setSearchQuery('')
    setDropdownPosition(undefined)
    triggerRef.current?.focus()
  }, [])

  const openMenu = useCallback(() => {
    if (disabled) return
    updateDropdownPlacement()
    setIsOpen(true)
    setSearchQuery('')
    const currentIndex = flatFilteredOptions.findIndex((option) => selectedValues.has(option.value))
    setHighlightedIndex(currentIndex >= 0 ? currentIndex : 0)
    setTimeout(() => {
      if (searchable) searchInputRef.current?.focus()
    }, 20)
  }, [disabled, flatFilteredOptions, searchable, selectedValues, updateDropdownPlacement])

  const handleSelect = useCallback((value: string, isOptionDisabled?: boolean) => {
    if (isOptionDisabled || disabled) return
    const nextValue = selectedValues.has(value)
      ? currentValue.filter((item) => item !== value)
      : [...currentValue, value]
    if (!isControlled) setInternalValue(nextValue)
    onChange?.(nextValue)
  }, [currentValue, disabled, isControlled, onChange, selectedValues])

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
        while (next < flatFilteredOptions.length && flatFilteredOptions[next]?.disabled) next++
        if (next < flatFilteredOptions.length) setHighlightedIndex(next)
        break
      }
      case 'ArrowUp': {
        event.preventDefault()
        let previous = highlightedIndex - 1
        while (previous >= 0 && flatFilteredOptions[previous]?.disabled) previous--
        if (previous >= 0) setHighlightedIndex(previous)
        break
      }
      case 'Enter': {
        event.preventDefault()
        const option = flatFilteredOptions[highlightedIndex]
        if (option && !option.disabled) handleSelect(option.value)
        break
      }
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        closeMenu()
        break
      case 'Tab':
        setIsOpen(false)
        setSearchQuery('')
        setDropdownPosition(undefined)
        break
    }
  }

  let cumulativeIndex = 0
  const triggerLabel = selectedOptions.length === 0
    ? placeholder
    : selectedOptions.length === 1
      ? selectedOptions[0]?.label
      : multipleLabel?.(selectedOptions.length) ?? `已选择 ${selectedOptions.length} 项`

  return (
    <div ref={containerRef} className={`relative inline-block w-full text-left ${className}`}>
      {name && currentValue.map((item) => <input key={item} type="hidden" name={name} value={item} />)}
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
        className={`group flex w-full items-center justify-between gap-2 rounded-md text-left font-medium outline-none transition-all duration-150 min-h-[36px] px-3 py-1.5 text-xs bg-yx-paper border border-yx-line text-yx-ink hover:bg-yx-hover hover:border-yx-brand shadow-2xs focus-visible:ring-2 focus-visible:ring-yx-brand/20 focus-visible:border-yx-brand ${
          isOpen ? '!border-yx-brand ring-2 ring-yx-brand/15 bg-yx-paper shadow-xs' : ''
        } ${disabled ? 'cursor-not-allowed opacity-50 bg-gray-100/60' : 'cursor-pointer'}`}
      >
        <span className={`min-w-0 flex-1 truncate ${selectedOptions.length ? 'text-yx-ink font-medium' : 'text-yx-faint font-normal'}`}>
          {triggerLabel}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-yx-muted transition-transform duration-200 ease-out group-hover:text-yx-brand ${isOpen ? 'rotate-180 text-yx-brand' : ''}`} />
      </button>

      {isOpen && dropdownPosition && typeof document !== 'undefined' && createPortal(
        <div
          ref={listboxRef}
          id={`${id}-listbox`}
          role="listbox"
          aria-multiselectable="true"
          tabIndex={-1}
          style={dropUp
            ? { left: dropdownPosition.left, bottom: dropdownPosition.bottom, width: dropdownPosition.width }
            : { left: dropdownPosition.left, top: dropdownPosition.top, width: dropdownPosition.width }}
          className={`fixed z-[999] overflow-hidden rounded-lg border border-yx-line bg-yx-paper p-1.5 shadow-lg ring-1 ring-black/5 transition-all duration-150 ${dropUp ? 'origin-bottom' : 'origin-top'} ${menuClassName}`}
        >
          {searchable && (
            <div className="relative mb-1 px-1 pt-0.5">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={searchPlaceholder}
                className="h-8 w-full px-3 py-1.5 pl-8 bg-yx-paper border border-yx-line rounded-md text-xs text-yx-ink placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-yx-brand focus:border-transparent transition-all"
              />
              {searchQuery && (
                <button type="button" onClick={() => setSearchQuery('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 hover:text-gray-700">
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          )}
          <div className="yx-subtle-scrollbar max-h-60 overflow-y-auto space-y-0.5 overscroll-contain pr-0.5" style={{ maxHeight: dropdownPosition.optionsMaxHeight }}>
            {filteredItems.length === 0 ? (
              <div className="py-4 text-center text-xs text-gray-400 select-none">{emptyText}</div>
            ) : filteredItems.map((item, itemIndex) => {
              if (isSelectGroup(item)) {
                return (
                  <div key={`group-${item.group}-${itemIndex}`} className="py-1 first:pt-0">
                    <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-400 select-none">{item.group}</div>
                    <div className="space-y-0.5">
                      {item.options.map((option) => {
                        const optionIndex = cumulativeIndex++
                        return (
                          <MultiSelectOptionRow
                            key={option.value}
                            option={option}
                            isSelected={selectedValues.has(option.value)}
                            isHighlighted={optionIndex === highlightedIndex}
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
              return (
                <MultiSelectOptionRow
                  key={item.value}
                  option={item}
                  isSelected={selectedValues.has(item.value)}
                  isHighlighted={optionIndex === highlightedIndex}
                  onSelect={() => handleSelect(item.value, item.disabled)}
                  onMouseEnter={() => setHighlightedIndex(optionIndex)}
                />
              )
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

function MultiSelectOptionRow({
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
        option.disabled ? 'cursor-not-allowed opacity-40 text-yx-faint' : 'cursor-pointer'
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
          {option.description && <div className="mt-0.5 truncate text-[10px] text-gray-400 font-normal">{option.description}</div>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {option.badge && <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none ${selectBadgeToneStyles[option.badgeTone ?? 'gray']}`}>{option.badge}</span>}
        {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-yx-brand" />}
      </div>
    </div>
  )
}

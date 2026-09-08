'use client'

import { FileText, Loader2, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { cx } from '@/lib/cn'
import { formatBytes } from '@/lib/format'
import { reportMaxUploadBytes } from '@/lib/upload-limits'

export const REPORT_FILE_ACCEPT = '.docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export function isAllowedReportFile(name: string) {
  return /\.(docx|pdf)$/i.test(name)
}

export function reportFileContentType(name: string) {
  return /\.pdf$/i.test(name)
    ? 'application/pdf'
    : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
}

export function FileDropzone({
  file,
  disabled = false,
  onFile,
  onInvalid,
  maxBytes = reportMaxUploadBytes,
  emptyTitle = '点击选择文件 或 将研究报告拖拽至此处',
  className = '',
}: {
  file?: File | null
  disabled?: boolean
  onFile: (file: File) => void
  onInvalid?: (message: string) => void
  maxBytes?: number
  emptyTitle?: string
  className?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  function takeFile(next?: File) {
    if (!next) return
    if (!isAllowedReportFile(next.name)) {
      onInvalid?.('仅支持 DOCX 或 PDF 文件。')
      return
    }
    if (next.size > maxBytes) {
      onInvalid?.(`文件大小不能超过 ${formatBytes(maxBytes)}。`)
      return
    }
    onFile(next)
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={REPORT_FILE_ACCEPT}
        className="hidden"
        disabled={disabled}
        onChange={(event) => {
          takeFile(event.target.files?.[0])
          event.currentTarget.value = ''
        }}
      />
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onKeyDown={(event) => {
          if ((event.key === 'Enter' || event.key === ' ') && !disabled) {
            event.preventDefault()
            inputRef.current?.click()
          }
        }}
        onDrop={(event) => {
          event.preventDefault()
          setDragOver(false)
          if (!disabled) takeFile(event.dataTransfer.files?.[0])
        }}
        onDragOver={(event) => {
          event.preventDefault()
          if (!disabled) setDragOver(true)
        }}
        onDragLeave={(event) => {
          event.preventDefault()
          setDragOver(false)
        }}
        onClick={() => {
          if (!disabled) inputRef.current?.click()
        }}
        className={cx(
          'group relative flex min-h-[10rem] flex-col items-center justify-center rounded-lg border-2 border-dashed p-4 text-center transition-all',
          disabled
            ? 'cursor-wait border-yx-brand/40 bg-yx-surface'
            : dragOver
              ? 'scale-[1.005] cursor-pointer border-yx-brand bg-yx-brand/10'
              : file
                ? 'cursor-pointer border-yx-brand bg-yx-paper shadow-2xs'
                : 'cursor-pointer border-yx-line bg-yx-surface hover:border-yx-brand hover:bg-yx-paper hover:shadow-xs',
          className,
        )}
      >
        <div className="mb-2.5 flex h-11 w-11 items-center justify-center rounded-xl bg-yx-brand text-white shadow-2xs">
          {disabled ? <Loader2 className="h-5 w-5 animate-spin text-white" /> : <Upload className="h-5 w-5 text-white" />}
        </div>
        {file ? (
          <div className="space-y-1">
            <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-yx-brand-tint bg-yx-brand-soft px-3 py-1 text-xs font-bold text-yx-brand-strong">
              <FileText className="h-3.5 w-3.5 shrink-0" />
              <span className="max-w-[18rem] truncate">已选定：{file.name}</span>
            </span>
            <p className="text-[11px] text-yx-muted">文件大小: {formatBytes(file.size)} · 点击可重新选择</p>
          </div>
        ) : (
          <div>
            <span className="text-sm font-bold text-yx-ink">{emptyTitle}</span>
            <p className="mt-1 text-xs text-yx-faint">{`支持 .docx（Word 文档）与 .pdf 格式，单文件上限 ${formatBytes(maxBytes)}`}</p>
          </div>
        )}
      </div>
    </>
  )
}

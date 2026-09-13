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

type FileDropzoneProps = {
  disabled?: boolean
  busy?: boolean
  onInvalid?: (message: string) => void
  maxBytes?: number
  emptyTitle?: string
  className?: string
} & (
  | { multiple?: false; file?: File | null; onFile: (file: File) => void }
  | { multiple: true; files: File[]; onFiles: (files: File[]) => void }
)

export function FileDropzone(props: FileDropzoneProps) {
  const {
    disabled = false,
    busy = disabled,
    onInvalid,
    maxBytes = reportMaxUploadBytes,
    emptyTitle = '点击选择文件 或 将研究报告拖拽至此处',
    className = '',
  } = props
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const selected = props.multiple ? props.files : props.file ? [props.file] : []
  const totalBytes = selected.reduce((sum, item) => sum + item.size, 0)
  const many = selected.length > 1
  const summary = many ? `已选定 ${selected.length} 个文件` : selected.length ? `已选定：${selected[0].name}` : emptyTitle

  function takeFiles(list: File[]) {
    const accepted: File[] = []
    const rejected: string[] = []
    for (const next of list) {
      if (!isAllowedReportFile(next.name)) rejected.push(next.name + ' 仅支持 DOCX 或 PDF 文件。')
      else if (next.size > maxBytes) rejected.push(next.name + ' 超过 ' + formatBytes(maxBytes) + '。')
      else accepted.push(next)
    }
    if (rejected.length) onInvalid?.(rejected.join(' '))
    if (!accepted.length) return
    if (props.multiple) props.onFiles(accepted)
    else props.onFile(accepted[0])
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={REPORT_FILE_ACCEPT}
        multiple={props.multiple}
        className="hidden"
        disabled={disabled}
        onChange={(event) => {
          takeFiles([...(event.target.files ?? [])])
          event.currentTarget.value = ''
        }}
      />
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-label={selected.length ? (props.multiple ? summary + '，点击可重新选择' : '更换报告文件：' + selected[0].name) : '选择报告文件'}
        onKeyDown={(event) => {
          if ((event.key === 'Enter' || event.key === ' ') && !disabled) {
            event.preventDefault()
            inputRef.current?.click()
          }
        }}
        onDrop={(event) => {
          event.preventDefault()
          setDragOver(false)
          if (!disabled) takeFiles([...(event.dataTransfer.files ?? [])])
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
            ? (busy ? 'cursor-wait border-yx-brand/40 bg-yx-surface' : 'cursor-not-allowed border-yx-line bg-yx-surface opacity-50')
            : dragOver
              ? 'scale-[1.005] cursor-pointer border-yx-brand bg-yx-brand/10'
              : selected.length
                ? 'cursor-pointer border-yx-brand bg-yx-paper shadow-2xs'
                : 'cursor-pointer border-yx-line bg-yx-surface hover:border-yx-brand hover:bg-yx-paper hover:shadow-xs',
          className,
        )}
      >
        <div className="mb-2.5 flex h-11 w-11 items-center justify-center rounded-xl bg-yx-brand text-white shadow-2xs">
          {busy ? <Loader2 className="h-5 w-5 animate-spin text-white" /> : <Upload className="h-5 w-5 text-white" />}
        </div>
        {selected.length ? (
          <div className="w-full min-w-0 space-y-1">
            <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-yx-brand-tint bg-yx-brand-soft px-3 py-1 text-xs font-bold text-yx-brand-strong">
              <FileText className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 max-w-[18rem] truncate" title={many ? summary : selected[0].name}>{summary}</span>
            </span>
            <p className="text-[11px] text-yx-muted">
              {many ? `共 ${formatBytes(totalBytes)}` : `文件大小: ${formatBytes(totalBytes)}`} · 点击可重新选择
            </p>
            {many ? (
              <div className="flex max-h-24 flex-wrap justify-center gap-1.5 overflow-y-auto pt-1">
                {selected.map((item) => (
                  <span
                    key={item.name + item.size}
                    className="max-w-[14rem] truncate rounded-md border border-yx-line bg-yx-paper px-2 py-0.5 text-[11px] text-yx-ink-soft"
                    title={item.name}
                  >
                    {item.name}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div>
            <span className="text-sm font-bold text-yx-ink">{emptyTitle}</span>
            <p className="mt-1 text-xs text-yx-faint">{'支持 .docx（Word 文档）与 .pdf 格式，单文件上限 ' + formatBytes(maxBytes)}{props.multiple ? '，可一次选择多份' : ''}</p>
          </div>
        )}
      </div>
    </>
  )
}

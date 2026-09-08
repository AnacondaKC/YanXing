'use client'

import { AlertCircle, Download, ExternalLink, FileText, Loader2, Maximize2, Minimize2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useWorkspaceEntrance } from '@/components/use-workspace-entrance'
import { isDarkTheme, YX_THEME_CHANGE_EVENT } from '@/components/theme-toggle'
import { apiFetch } from '@/lib/client-request'
import type { ReportVersion } from '@/modules/reports/domain'

const DOCX_DARK_BACKGROUND = '#24231f'
const DOCX_LIGHT_BACKGROUND = 'var(--yx-hover)'

function buildDocxFrameDocument(background: string) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; font-src data: blob:; style-src 'unsafe-inline' data:;">
<style>
:root { color-scheme: light; font-family: "PingFang SC", "Microsoft YaHei", Arial, sans-serif; }
* { box-sizing: border-box; }
html, body { min-height: 100%; margin: 0; background: ${background}; }
body { overflow: auto; scrollbar-width: thin; scrollbar-color: rgba(15, 23, 42, 0.18) transparent; }
#document-root { min-height: 100%; }
.docx-wrapper { min-height: 100%; padding: 20px !important; background: ${background} !important; }
.docx-wrapper > section.docx { margin: 0 auto 20px !important; border: 1px solid color-mix(in srgb, var(--yx-ink) 9%, transparent) !important; box-shadow: none !important; }
@media (max-width: 720px) {
  .docx-wrapper { padding: 8px !important; }
  .docx-wrapper > section.docx { margin-bottom: 8px !important; }
}
@supports selector(::-webkit-scrollbar) {
  body { scrollbar-width: auto; scrollbar-color: auto; }
  body::-webkit-scrollbar { width: 6px; height: 6px; }
  body::-webkit-scrollbar-track { background: transparent; }
  body::-webkit-scrollbar-thumb { background: rgba(15, 23, 42, 0.16); border-radius: 3px; }
  body::-webkit-scrollbar-thumb:hover { background: rgba(15, 23, 42, 0.28); }
  body::-webkit-scrollbar-corner { background: transparent; }
}
</style>
</head>
<body><main id="document-root"></main></body>
</html>`
}

export function ReportDocumentViewer({ report }: { report?: ReportVersion }) {
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(Boolean(report))
  const { entranceProps } = useWorkspaceEntrance(loading)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [pdfAvailable, setPdfAvailable] = useState(false)
  const [docxFrameReady, setDocxFrameReady] = useState(false)
  const workspaceRef = useRef<HTMLElement>(null)
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null)
  const docxFrameRef = useRef<HTMLIFrameElement>(null)
  const docxRenderGenerationRef = useRef(0)
  const reportId = report?.id
  const isPdf = Boolean(report?.fileName.toLowerCase().endsWith('.pdf'))
  const fileUrl = reportId ? `/api/reports/${reportId}/file` : ''

  // srcDoc 只在挂载时按当前主题生成一次;主题切换后通过 applyDocxFrameTheme 增量更新,避免重载 iframe
  const [docxFrameSrcDoc] = useState(() => buildDocxFrameDocument(isDarkTheme() ? DOCX_DARK_BACKGROUND : DOCX_LIGHT_BACKGROUND))

  const closeExpanded = useCallback(() => setExpanded(false), [])

  const applyDocxFrameTheme = useCallback(() => {
    const frameDocument = docxFrameRef.current?.contentDocument
    if (!frameDocument) return
    const dark = isDarkTheme()
    frameDocument.documentElement.style.colorScheme = dark ? 'dark' : 'light'
    const existing = frameDocument.getElementById('yx-docx-theme')
    existing?.remove()
    const background = dark ? DOCX_DARK_BACKGROUND : DOCX_LIGHT_BACKGROUND
    const style = frameDocument.createElement('style')
    style.id = 'yx-docx-theme'
    style.textContent = `html, body, .docx-wrapper { background: ${background} !important; }`
    frameDocument.head.appendChild(style)
  }, [])

  useEffect(() => {
    const apply = () => applyDocxFrameTheme()
    window.addEventListener(YX_THEME_CHANGE_EVENT, apply)
    return () => window.removeEventListener(YX_THEME_CHANGE_EVENT, apply)
  }, [applyDocxFrameTheme])

  useEffect(() => {
    if (!expanded) return
    const workspace = workspaceRef.current
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const previousDocumentOverflow = document.documentElement.style.overflow
    const previousBodyOverflow = document.body.style.overflow
    const focusableSelector = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    document.documentElement.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
    fullscreenButtonRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeExpanded()
        return
      }
      if (event.key !== 'Tab' || !workspace) return
      const focusable = Array.from(workspace.querySelectorAll<HTMLElement>(focusableSelector))
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.documentElement.style.overflow = previousDocumentOverflow
      document.body.style.overflow = previousBodyOverflow
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [closeExpanded, expanded])

  useEffect(() => {
    setError('')
    setPdfAvailable(false)
    setDocxFrameReady(false)
    if (!reportId) {
      setLoading(false)
      return
    }
    setLoading(true)
    if (!isPdf) return

    const controller = new AbortController()
    apiFetch(fileUrl, { method: 'HEAD', cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readFileResponseError(response))
        if (controller.signal.aborted) return
        setPdfAvailable(true)
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : 'PDF 文件读取失败。')
          setLoading(false)
        }
      })
    return () => controller.abort()
  }, [fileUrl, isPdf, reloadKey, report?.fileHash, reportId])

  useEffect(() => {
    if (!reportId || isPdf || !docxFrameReady) return
    const controller = new AbortController()
    const generation = ++docxRenderGenerationRef.current
    const isCurrentRender = () => !controller.signal.aborted && generation === docxRenderGenerationRef.current
    const frameDocument = docxFrameRef.current?.contentDocument
    const target = frameDocument?.getElementById('document-root')
    if (!frameDocument || !target) return

    let resizeObserver: ResizeObserver | undefined
    let resizeFrame: number | undefined
    setLoading(true)
    setError('')
    target.replaceChildren()
    Promise.all([
      apiFetch(fileUrl, { cache: 'no-store', signal: controller.signal }),
      import('docx-preview'),
    ])
      .then(async ([response, docx]) => {
        if (!response.ok) throw new Error(await readFileResponseError(response))
        const documentData = await response.arrayBuffer()
        if (!isCurrentRender()) return
        await docx.renderAsync(documentData, target, frameDocument.head, {
          breakPages: true,
          experimental: true,
          ignoreFonts: false,
          ignoreHeight: false,
          ignoreLastRenderedPageBreak: false,
          ignoreWidth: false,
          inWrapper: true,
          renderAltChunks: false,
          renderEndnotes: true,
          renderFooters: true,
          renderFootnotes: true,
          renderHeaders: true,
          // Blob URL 避免把图片再编码成 Base64 字符串；iframe 销毁时由浏览器回收其资源。
          useBase64URL: false,
        })
        if (!isCurrentRender()) return
        const frame = docxFrameRef.current
        if (frame) {
          const scheduleFitPages = () => {
            if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame)
            resizeFrame = window.requestAnimationFrame(() => {
              resizeFrame = undefined
              if (isCurrentRender()) fitDocxPages(frameDocument, frame.clientWidth)
            })
          }
          scheduleFitPages()
          if (typeof ResizeObserver !== 'undefined') {
            resizeObserver = new ResizeObserver(scheduleFitPages)
            resizeObserver.observe(frame)
          }
        }
        if (!isCurrentRender()) return
        applyDocxFrameTheme()
        setLoading(false)
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : 'Word 文件渲染失败。')
          setLoading(false)
        }
      })
    return () => {
      docxRenderGenerationRef.current += 1
      controller.abort()
      if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame)
      resizeObserver?.disconnect()
    }
  }, [docxFrameReady, fileUrl, isPdf, reloadKey, report?.fileHash, reportId])

  if (!report) {
    return <div {...entranceProps} className="yx-detail flex min-h-0 min-w-0 flex-1 flex-col"><DocumentViewerEmptyState /></div>
  }

  const formatLabel = isPdf ? 'PDF' : 'DOCX'
  const sourceUrl = `${fileUrl}?v=${encodeURIComponent(report.fileHash.slice(0, 12))}&r=${reloadKey}`

  return (
    <section
      {...entranceProps}
      ref={workspaceRef}
      role={expanded ? 'dialog' : undefined}
      aria-modal={expanded ? true : undefined}
      aria-label="报告原文阅读器"
      tabIndex={expanded ? -1 : undefined}
      className={`yx-detail flex min-w-0 flex-col overflow-hidden bg-[var(--yx-canvas-inner)] ${expanded ? 'fixed inset-0 z-50 h-[100dvh] w-screen border border-[var(--yx-line)] p-2 sm:p-4' : 'relative h-[calc(100dvh-8.5rem)] min-h-[650px] rounded-lg border border-black/[0.04] shadow-2xs lg:h-auto lg:min-h-0 lg:flex-1'}`}
    >
      <div className={`yx-detail-intro flex h-11 shrink-0 items-center justify-between border-b border-black/[0.04] bg-yx-paper px-3 ${expanded ? 'rounded-t-[4px] sm:px-5' : 'rounded-t-lg sm:px-4'}`}>
        <div className="flex min-w-0 items-center gap-2.5">
          <FileText className="h-4 w-4 shrink-0 text-[var(--yx-brand)]" />
          <div className="min-w-0">
            <div className="truncate text-[11px] font-semibold text-yx-ink" title={report.fileName}>{report.fileName}</div>
            <div className="mt-0.5 flex items-center gap-2 text-[9px] text-gray-400">
              <span>{formatLabel}</span>
              <span>第 {report.version} 版</span>
              <span>{new Date(report.createdAt).toLocaleDateString('zh-CN')}</span>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {isPdf && (
            <a href={fileUrl} target="_blank" rel="noreferrer" aria-label="在新窗口打开" title="在新窗口打开" className="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-yx-ink">
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
          <a href={`${fileUrl}?download=1`} download={report.fileName} aria-label="下载原文件" title="下载原文件" className="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-yx-ink">
            <Download className="h-4 w-4" />
          </a>
          <button ref={fullscreenButtonRef} type="button" onClick={() => setExpanded((value) => !value)} aria-label={expanded ? '退出全屏阅读' : '全屏阅读'} title={expanded ? '退出全屏阅读' : '全屏阅读'} className="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-yx-ink">
            {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {isPdf && pdfAvailable && (
        <iframe
          key={sourceUrl}
          title={`${report.title} - PDF 原文`}
          src={sourceUrl}
          referrerPolicy="no-referrer"
          onLoad={() => setLoading(false)}
          className={`min-h-0 w-full flex-1 border-0 bg-yx-paper ${!loading && !error ? 'yx-detail-reader' : ''}`}
        />
      )}
      {!isPdf && (
        <iframe
          key={`${report.id}-${report.fileHash}-${reloadKey}`}
          ref={docxFrameRef}
          title={`${report.title} - Word 原文`}
          sandbox="allow-same-origin"
          referrerPolicy="no-referrer"
          srcDoc={docxFrameSrcDoc}
          onLoad={() => setDocxFrameReady(true)}
          className={`min-h-0 w-full flex-1 border-0 bg-[var(--yx-canvas-inner)] ${!loading && !error ? 'yx-detail-reader' : ''}`}
        />
      )}

      {loading && !error && (
        <div role="status" className="absolute inset-0 flex items-center justify-center bg-white/90">
          <div className="text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-[var(--yx-brand)]" /><p className="mt-3 text-[10px] text-gray-500">正在载入{formatLabel}原文</p></div>
        </div>
      )}
      {error && (
        <div role="alert" className="absolute inset-0 flex items-center justify-center bg-yx-paper p-6">
          <div className="max-w-md text-center">
            <AlertCircle className="mx-auto h-7 w-7 text-[var(--yx-warning)]" />
            <h2 className="mt-4 text-base font-semibold text-yx-ink">原文加载失败</h2>
            <p className="mt-2 text-[11px] leading-relaxed text-gray-500">{error}</p>
            <button type="button" onClick={() => setReloadKey((key) => key + 1)} className="mx-auto mt-5 flex h-9 items-center justify-center gap-2 rounded-md bg-black px-4 text-xs font-semibold text-white hover:bg-gray-800">
              <RefreshCw className="h-3.5 w-3.5" />重新加载
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

function DocumentViewerEmptyState() {
  return (
    <div className="yx-detail-content flex min-h-[560px] flex-1 items-center justify-center rounded-md bg-yx-paper p-6">
      <div className="max-w-md text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-md bg-gray-100 text-gray-500"><FileText className="h-5 w-5" /></span>
        <h2 className="mt-4 text-base font-semibold text-yx-ink">尚未上传报告</h2>
        <p className="mt-2 text-[11px] leading-relaxed text-gray-500">上传 PDF 或 DOCX 报告后，可在这里查看原始文档。</p>
      </div>
    </div>
  )
}

async function readFileResponseError(response: Response) {
  const body = await response.json().catch(() => undefined) as { error?: unknown } | undefined
  return typeof body?.error === 'string' ? body.error : `报告文件读取失败（HTTP ${response.status}）。`
}

function fitDocxPages(frameDocument: Document, frameWidth: number) {
  const availableWidth = Math.max(1, frameWidth - 16)
  const pages = Array.from(frameDocument.querySelectorAll<HTMLElement>('.docx-wrapper > section.docx'))

  // 先统一清除旧缩放，再批量读取布局，最后批量写入，避免读写交错触发逐页 reflow。
  pages.forEach((page) => page.style.setProperty('zoom', '1'))
  const pageWidths = pages.map((page) => page.getBoundingClientRect().width)
  pages.forEach((page, index) => {
    const pageWidth = pageWidths[index] ?? 0
    if (pageWidth > availableWidth) {
      page.style.setProperty('zoom', String(availableWidth / pageWidth))
    }
  })
}

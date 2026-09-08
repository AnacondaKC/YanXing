'use client'

import { AlertCircle, ImagePlus, Loader2, RotateCw, Save, Undo2 } from 'lucide-react'
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { useBranding, parseBrandSettingsResponse } from '@/components/branding-provider'
import {
  DEFAULT_HEADER_LOGO_URL,
  DEFAULT_LOGIN_WATERMARK_URL,
  MAX_BRAND_ASSET_BYTES,
  MAX_BRAND_DISPLAY_TEXT_LENGTH,
  normalizeBrandDisplayText,
  type BrandImageInput,
  type BrandImageMimeType,
  type PublicBrandSettings,
} from '@/lib/branding'
import { apiFetch, mutationHeaders } from '@/lib/client-request'

const BRANDING_ENDPOINT = '/api/admin/branding'
const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

type AssetDraft = { file?: File; reset: boolean }
type AssetField = 'headerLogo' | 'loginWatermark'
type BrandDraft = { displayText: string; headerLogo: AssetDraft; loginWatermark: AssetDraft }

function emptyAssetDraft(): AssetDraft {
  return { reset: false }
}

function createDraft(settings: PublicBrandSettings): BrandDraft {
  return { displayText: settings.displayText, headerLogo: emptyAssetDraft(), loginWatermark: emptyAssetDraft() }
}

export function BrandingSettingsPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const { applySettings } = useBranding()
  const [saved, setSaved] = useState<PublicBrandSettings>()
  const [draft, setDraft] = useState<BrandDraft>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [conflict, setConflict] = useState(false)
  const [loadSequence, setLoadSequence] = useState(0)
  const saveRequest = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void apiFetch(BRANDING_ENDPOINT, { cache: 'no-store', signal: controller.signal })
      .then(readBrandSettingsResponse)
      .then((settings) => {
        if (controller.signal.aborted) return
        setSaved(settings)
        setDraft(createDraft(settings))
        setError('')
        setConflict(false)
        if (loadSequence > 0) setSuccess('已重新加载最新品牌设置。')
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '品牌设置加载失败，请重试。')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [loadSequence])

  useEffect(() => () => saveRequest.current?.abort(), [])

  const normalizedText = normalizeBrandDisplayText(draft?.displayText)
  const dirty = Boolean(saved && draft && (normalizedText !== saved.displayText
    || draft.headerLogo.file || draft.headerLogo.reset
    || draft.loginWatermark.file || draft.loginWatermark.reset))

  function reload() {
    if (loading || saving) return
    setError('')
    setSuccess('')
    setLoadSequence((sequence) => sequence + 1)
  }

  function selectAsset(field: AssetField, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type as BrandImageMimeType) || file.size > MAX_BRAND_ASSET_BYTES || file.size === 0) {
      setError('图片须为不超过 2 MB 的 PNG、JPG 或 WebP 文件。')
      return
    }
    setDraft((current) => current ? { ...current, [field]: { file, reset: false } } : current)
    setError('')
    setSuccess('')
    setConflict(false)
  }

  function changeAsset(field: AssetField, change: AssetDraft) {
    setDraft((current) => current ? { ...current, [field]: change } : current)
    setError('')
    setSuccess('')
    setConflict(false)
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!saved || !draft || !dirty || !normalizedText || saving || conflict) return
    const controller = new AbortController()
    saveRequest.current = controller
    setSaving(true)
    setError('')
    setSuccess('')
    try {
      const [headerLogo, loginWatermark] = await Promise.all([
        serializeAssetDraft(draft.headerLogo),
        serializeAssetDraft(draft.loginWatermark),
      ])
      const response = await apiFetch(BRANDING_ENDPOINT, {
        method: 'PUT',
        headers: mutationHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          revision: saved.revision,
          settings: { displayText: normalizedText, headerLogo, loginWatermark },
        }),
        signal: controller.signal,
      })
      if (response.status === 409 || response.status === 412) {
        setConflict(true)
        return
      }
      const settings = await readBrandSettingsResponse(response)
      if (controller.signal.aborted) return
      setSaved(settings)
      setDraft(createDraft(settings))
      applySettings(settings)
      setSuccess('品牌已保存，当前页面已同步更新。')
      onNotice('界面与品牌已保存')
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '品牌设置保存失败，请重试。')
    } finally {
      saveRequest.current = null
      if (!controller.signal.aborted) setSaving(false)
    }
  }

  if (!saved || !draft) {
    return (
      <div className="flex min-h-40 items-center justify-center">
        {loading ? <LoadingBranding /> : <button type="button" onClick={reload} className={secondaryButtonClass}>重新加载</button>}
      </div>
    )
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl">
      <header className="mb-5">
        <h1 className="text-xl font-bold tracking-tight text-yx-ink">界面与品牌</h1>
        <p className="mt-1.5 text-xs leading-relaxed text-yx-muted">统一设置工作台及登录页顶部标识、标识右侧文字和登录页左下角图案。</p>
      </header>

      {error && <StatusMessage tone="error">{error}</StatusMessage>}
      {conflict && <StatusMessage tone="warning">品牌设置已被其他管理员修改。请重新加载后核对并再次保存。</StatusMessage>}

      <form onSubmit={save} noValidate aria-busy={loading || saving}>
        <section className="rounded-lg border border-yx-line bg-yx-surface p-4 sm:p-5" aria-labelledby="brand-copy-heading">
          <h2 id="brand-copy-heading" className="text-sm font-semibold text-yx-ink">品牌文字</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-yx-muted">显示在顶部标识右侧；允许一行或两行。</p>
          <label htmlFor="brand-display-text" className="mt-4 block text-xs font-medium text-yx-ink">标识右侧文字</label>
          <textarea
            id="brand-display-text"
            rows={2}
            maxLength={MAX_BRAND_DISPLAY_TEXT_LENGTH}
            value={draft.displayText}
            onChange={(event) => {
              setDraft({ ...draft, displayText: event.target.value })
              setError('')
              setSuccess('')
              setConflict(false)
            }}
            aria-invalid={!normalizedText}
            aria-describedby="brand-display-text-help"
            className="mt-1.5 w-full resize-none rounded-md border border-yx-line bg-yx-paper px-3 py-2 text-sm leading-relaxed text-yx-ink outline-none focus:border-yx-brand focus:ring-2 focus:ring-yx-brand/15 aria-invalid:border-yx-danger"
          />
          <p id="brand-display-text-help" className="mt-1.5 text-[11px] text-yx-muted">最多 60 个字符、两行；空行会自动移除。</p>
        </section>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <BrandAssetEditor
            field="headerLogo"
            title="顶部标识"
            description="用于工作台和登录页顶部，建议使用横向透明底图片。"
            currentUrl={saved.headerLogoUrl}
            defaultUrl={DEFAULT_HEADER_LOGO_URL}
            draft={draft.headerLogo}
            onSelect={selectAsset}
            onChange={changeAsset}
          />
          <BrandAssetEditor
            field="loginWatermark"
            title="登录页左下角图案"
            description="用于登录页背景角标，建议使用透明底方形或纵向图片。"
            currentUrl={saved.loginWatermarkUrl}
            defaultUrl={DEFAULT_LOGIN_WATERMARK_URL}
            draft={draft.loginWatermark}
            onSelect={selectAsset}
            onChange={changeAsset}
          />
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-yx-line pt-4">
          <div className="text-xs text-yx-muted">
            <p role="status">{saving ? '正在保存…' : dirty ? '有未保存的更改' : '当前没有未保存的更改'}</p>
            {saved.updatedBy && <p className="mt-1 text-[10px]">上次更新：{saved.updatedBy}</p>}
          </div>
          <div className="flex gap-2">
            <button type="button" disabled={loading || saving} onClick={reload} className={secondaryButtonClass}>
              <RotateCw aria-hidden="true" className={loading ? 'h-3.5 w-3.5 animate-spin motion-reduce:animate-none' : 'h-3.5 w-3.5'} />
              重新加载
            </button>
            <button type="submit" disabled={!dirty || !normalizedText || loading || saving || conflict} className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md bg-yx-brand px-4 text-xs font-semibold text-white hover:bg-yx-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yx-brand disabled:cursor-not-allowed disabled:opacity-50">
              {saving ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <Save aria-hidden="true" className="h-3.5 w-3.5" />}
              {saving ? '正在保存…' : '保存品牌'}
            </button>
          </div>
        </div>
        {success && <p role="status" className="mt-3 text-xs leading-relaxed text-yx-brand">{success}</p>}
      </form>
    </div>
  )
}

function BrandAssetEditor({ field, title, description, currentUrl, defaultUrl, draft, onSelect, onChange }: {
  field: AssetField
  title: string
  description: string
  currentUrl: string
  defaultUrl: string
  draft: AssetDraft
  onSelect: (field: AssetField, event: ChangeEvent<HTMLInputElement>) => void
  onChange: (field: AssetField, change: AssetDraft) => void
}) {
  const objectUrl = useObjectUrl(draft.file)
  const previewUrl = objectUrl ?? (draft.reset ? defaultUrl : currentUrl)
  const changed = Boolean(draft.file || draft.reset)
  return (
    <section className="min-w-0 rounded-lg border border-yx-line bg-yx-paper p-4" aria-labelledby={field + '-heading'}>
      <h2 id={field + '-heading'} className="text-sm font-semibold text-yx-ink">{title}</h2>
      <p className="mt-1 min-h-8 text-[11px] leading-relaxed text-yx-muted">{description}</p>
      <div className="mt-3 flex h-28 items-center justify-center overflow-hidden rounded-md border border-dashed border-yx-line bg-yx-surface p-3">
        <img src={previewUrl} alt={title + '预览'} className="max-h-full max-w-full object-contain" />
      </div>
      <p className="mt-2 truncate text-[10px] text-yx-muted">{draft.file ? draft.file.name : draft.reset ? '保存后恢复系统默认图片' : '当前已保存图片'}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <label className={secondaryButtonClass + ' cursor-pointer'}>
          <ImagePlus aria-hidden="true" className="h-3.5 w-3.5" />
          选择图片
          <input type="file" accept={ACCEPTED_IMAGE_TYPES.join(',')} className="sr-only" onChange={(event) => onSelect(field, event)} />
        </label>
        {changed ? (
          <button type="button" onClick={() => onChange(field, emptyAssetDraft())} className={secondaryButtonClass}>
            <Undo2 aria-hidden="true" className="h-3.5 w-3.5" />取消更改
          </button>
        ) : currentUrl !== defaultUrl ? (
          <button type="button" onClick={() => onChange(field, { reset: true })} className={secondaryButtonClass}>恢复默认
          </button>
        ) : null}
      </div>
    </section>
  )
}

function useObjectUrl(file?: File) {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    if (!file) {
      setUrl(undefined)
      return
    }
    const nextUrl = URL.createObjectURL(file)
    setUrl(nextUrl)
    return () => URL.revokeObjectURL(nextUrl)
  }, [file])
  return url
}

async function serializeAssetDraft(draft: AssetDraft): Promise<BrandImageInput | null | undefined> {
  if (draft.reset) return null
  if (!draft.file) return undefined
  return { mimeType: draft.file.type as BrandImageMimeType, dataBase64: await fileToBase64(draft.file) }
}

async function fileToBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunkSize = 32_768
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return window.btoa(binary)
}

async function readBrandSettingsResponse(response: Response) {
  const body = await response.json().catch(() => null) as unknown
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : '品牌设置请求失败，请重试。'
    throw new Error(message)
  }
  const settings = parseBrandSettingsResponse(body)
  if (!settings) throw new Error('品牌设置响应不完整，请重新加载。')
  return settings
}

function LoadingBranding() {
  return <p role="status" className="flex items-center gap-2 text-xs text-yx-muted"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin text-yx-brand motion-reduce:animate-none" />正在加载品牌设置…</p>
}

function StatusMessage({ tone, children }: { tone: 'error' | 'warning'; children: string }) {
  const className = tone === 'error'
    ? 'border-yx-danger/25 bg-yx-danger-soft text-yx-danger-text'
    : 'border-yx-warning/30 bg-yx-warning-soft text-yx-warning-text'
  return (
    <div role="alert" className={'mb-4 flex items-start gap-2 rounded-lg border p-3 text-xs leading-relaxed ' + className}>
      <AlertCircle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  )
}

const secondaryButtonClass = 'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border border-yx-line bg-yx-paper px-3 text-xs font-medium text-yx-ink-soft hover:bg-yx-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yx-brand disabled:cursor-not-allowed disabled:opacity-50'

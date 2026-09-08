'use client'

import { AlertCircle, BookOpen, Check, CheckCircle2, ChevronDown, CircleDashed, KeyRound, Layers3, Loader2, Network, Pencil, Plus, Save, Server, Sparkles, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Field } from '@/components/ui/field'
import { IconBadge } from '@/components/ui/icon-badge'
import { CustomSelect } from '@/components/ui/select'
import { apiFetch, mutationHeaders } from '@/lib/client-request'
import { MAX_MAX_CONTEXT_CHARACTERS, MAX_MAX_OUTPUT_TOKENS, MIN_MAX_CONTEXT_CHARACTERS, MIN_MAX_OUTPUT_TOKENS } from '@/lib/ai/runtime-options'
import type { AiReasoningEffort } from '@/lib/ai/runtime-options'
import {
  assignmentsToDraft,
  channelToDraft,
  createChannelDraft,
  createModelDraft,
  modelSelectionTargetDetails,
  modelSelectionTargets,
  normalizeBaseUrlForComparison,
  type AiModelChannelDraft,
  type AiModelProfileDraft,
  type AiModelSelectionTarget,
  type AiModelSettings,
  nextExpandedIndexAfterDelete,
} from '@/components/admin/ai-settings-types'

export function AdminModelSettings({
  page,
  onNotice,
  onChannelsCountChange,
}: {
  page: 'channels' | 'selections'
  onNotice: (message: string) => void
  onChannelsCountChange?: (count: number) => void
}) {
  const [settings, setSettings] = useState<AiModelSettings>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadSequenceRef = useRef(0)
  const loadControllerRef = useRef<AbortController | undefined>(undefined)
  const onChannelsCountChangeRef = useRef(onChannelsCountChange)
  onChannelsCountChangeRef.current = onChannelsCountChange

  const reload = useCallback(async () => {
    const requestSequence = ++loadSequenceRef.current
    loadControllerRef.current?.abort()
    const controller = new AbortController()
    loadControllerRef.current = controller
    setLoading(true)
    try {
      const response = await apiFetch('/api/admin/ai-settings', { cache: 'no-store', signal: controller.signal }).catch(() => null)
      const body = (await response?.json().catch(() => null)) as { settings?: AiModelSettings; error?: string } | null
      if (controller.signal.aborted || requestSequence !== loadSequenceRef.current) return
      if (!response?.ok || !body?.settings) throw new Error(body?.error ?? '设置读取失败。')
      setSettings(body.settings)
      onChannelsCountChangeRef.current?.(body.settings.channels.length)
      setError('')
    } catch (reason) {
      if (controller.signal.aborted || requestSequence !== loadSequenceRef.current) return
      setError(reason instanceof Error ? reason.message : '设置读取失败。')
    } finally {
      if (loadControllerRef.current === controller) loadControllerRef.current = undefined
      if (!controller.signal.aborted && requestSequence === loadSequenceRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
    return () => {
      loadSequenceRef.current += 1
      loadControllerRef.current?.abort()
    }
  }, [reload])

  if (loading)
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-yx-brand" />
      </div>
    )
  if (!settings) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-xl font-bold tracking-tight text-yx-ink">{page === 'channels' ? '渠道模型' : '模型选择'}</h1>
        <div role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error || '设置读取失败。'}</span>
        </div>
      </div>
    )
  }

  function applySavedSettings(newSettings: AiModelSettings) {
    loadSequenceRef.current += 1
    loadControllerRef.current?.abort()
    setSettings(newSettings)
    onChannelsCountChangeRef.current?.(newSettings.channels.length)
  }

  return page === 'channels' ? (
    <ModelChannelsSettings
      settings={settings}
      error={error}
      onSettingsChange={applySavedSettings}
      onNotice={onNotice}
    />
  ) : (
    <ModelSelectionSettings
      settings={settings}
      error={error}
      onSettingsChange={applySavedSettings}
      onNotice={onNotice}
    />
  )
}

export function ModelChannelsSettings({
  settings,
  error: loadError,
  onSettingsChange,
  onNotice,
}: {
  settings: AiModelSettings
  error: string
  onSettingsChange: (settings: AiModelSettings) => void
  onNotice: (message: string) => void
}) {
  const [drafts, setDrafts] = useState<AiModelChannelDraft[]>(() => settings.channels.map((channel) => channelToDraft(channel)))
  const [expandedKeys, setExpandedKeys] = useState<string[]>([])
  const [savingKey, setSavingKey] = useState('')
  const [deletingKey, setDeletingKey] = useState('')
  const [error, setError] = useState('')
  const nextNewKeyRef = useRef(0)
  const totalModels = drafts.reduce((sum, draft) => sum + draft.models.length, 0)

  function patchDraft(key: string, patch: Partial<AiModelChannelDraft>) {
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, ...patch, dirty: true } : draft)))
  }

  function toggleExpanded(key: string) {
    setExpandedKeys((keys) => (keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key]))
  }

  function addChannel() {
    const key = `new-${nextNewKeyRef.current++}`
    setDrafts((current) => [...current, createChannelDraft(key)])
    setExpandedKeys((keys) => [...keys, key])
    setError('')
  }

  async function saveChannel(draft: AiModelChannelDraft) {
    setSavingKey(draft.key)
    setError('')
    const response = await apiFetch('/api/admin/ai-settings', {
      method: 'PUT',
      headers: mutationHeaders({ 'Content-Type': 'application/json', 'If-Match': `"models-${settings.revision}"` }),
      body: JSON.stringify({
        action: 'save_channel',
        revision: settings.revision,
        channel: {
          id: draft.id,
          name: draft.name,
          baseUrl: draft.baseUrl,
          apiKey: draft.apiKey,
          clearApiKey: draft.clearApiKey,
          models: draft.models,
        },
      }),
    }).catch(() => null)
    const body = (await response?.json().catch(() => null)) as { settings?: AiModelSettings; error?: string } | null
    if (!response?.ok || !body?.settings) {
      setError(body?.error ?? '渠道保存失败。')
      setSavingKey('')
      return
    }
    const existingIds = new Set(settings.channels.map((channel) => channel.id))
    const savedChannel = draft.id
      ? body.settings.channels.find((channel) => channel.id === draft.id)
      : body.settings.channels.find((channel) => !existingIds.has(channel.id))
    if (savedChannel) {
      const savedKey = `channel-${savedChannel.id}`
      setDrafts((current) => current.map((item) => (item.key === draft.key ? channelToDraft(savedChannel, savedKey) : item)))
      setExpandedKeys((keys) => keys.map((key) => (key === draft.key ? savedKey : key)))
    }
    setSavingKey('')
    onSettingsChange(body.settings)
    onNotice('渠道与模型配置已保存。')
  }

  async function deleteChannel(draft: AiModelChannelDraft) {
    if (!draft.id) {
      setDrafts((current) => current.filter((item) => item.key !== draft.key))
      setExpandedKeys((keys) => keys.filter((key) => key !== draft.key))
      setError('')
      return
    }
    const channel = settings.channels.find((item) => item.id === draft.id)
    if (!channel) return
    if (!window.confirm(`删除“${channel.name}”及其 ${channel.models.length} 个模型？相关执行目标会自动回退到其他已配置模型；没有可用模型时会变为未选择。`)) return
    setDeletingKey(draft.key)
    setError('')
    const response = await apiFetch('/api/admin/ai-settings', {
      method: 'PUT',
      headers: mutationHeaders({ 'Content-Type': 'application/json', 'If-Match': `"models-${settings.revision}"` }),
      body: JSON.stringify({ action: 'delete_channel', channelId: channel.id, revision: settings.revision }),
    }).catch(() => null)
    const body = (await response?.json().catch(() => null)) as { settings?: AiModelSettings; error?: string } | null
    if (!response?.ok || !body?.settings) {
      setError(body?.error ?? '渠道删除失败。')
      setDeletingKey('')
      return
    }
    setDrafts((current) => current.filter((item) => item.key !== draft.key))
    setExpandedKeys((keys) => keys.filter((key) => key !== draft.key))
    setDeletingKey('')
    onSettingsChange(body.settings)
    onNotice(`已删除渠道“${channel.name}”。`)
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col pb-2">
      {/* Header */}
      <header className="shrink-0 border-b border-yx-line pb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <IconBadge icon={Network} size="lg" />
            <div>
              <div className="flex items-center gap-2">
                <h1 id="admin-settings-title" className="text-xl font-bold tracking-tight text-yx-ink">
                  渠道模型
                </h1>
                <span className="rounded-md border border-yx-line bg-yx-surface px-2 py-0.5 font-mono text-xs font-medium text-yx-muted">
                  {drafts.length} 个渠道 · 模型池 {totalModels} 个模型
                </span>
              </div>
              <p className="mt-0.5 text-xs text-yx-muted">
                维护大模型 API 接入渠道、凭据安全存储与模型运行参数。
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={addChannel}
            className="flex h-8 items-center gap-1.5 rounded-md bg-yx-brand px-3.5 text-xs font-medium text-white shadow-xs transition-colors duration-150 hover:bg-yx-brand-hover"
          >
            <Plus className="h-3.5 w-3.5 text-white" />
            <span>添加渠道</span>
          </button>
        </div>
      </header>

      {(loadError || error) && (
        <div role="alert" className="mt-4 flex shrink-0 items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error || loadError}</span>
        </div>
      )}

      {/* Channel Cards in Accordion Style */}
      {drafts.length > 0 ? (
        <div className="yx-subtle-scrollbar mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1">
          {drafts.map((draft, index) => {
            const expanded = expandedKeys.includes(draft.key)
            return (
              <section
                key={draft.key}
                className="overflow-hidden rounded-lg border border-yx-line bg-yx-surface shadow-2xs transition-all duration-150 hover:border-yx-brand"
              >
                <button
                  type="button"
                  onClick={() => toggleExpanded(draft.key)}
                  aria-expanded={expanded}
                  className="flex w-full items-center gap-3 bg-yx-surface px-4 py-3.5 text-left transition-colors duration-150 hover:bg-yx-hover"
                >
                  <ChannelCardHeader draft={draft} index={index} saving={savingKey === draft.key} deleting={deletingKey === draft.key} />
                  <ChevronDown className={`h-4 w-4 shrink-0 text-yx-muted transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`} />
                </button>
                {expanded && (
                  <div className="border-t border-yx-line bg-yx-paper px-4 pb-4 pt-4 sm:px-5">
                    <ChannelCardForm
                      draft={draft}
                      saving={savingKey === draft.key}
                      deleting={deletingKey === draft.key}
                      onPatch={(patch) => patchDraft(draft.key, patch)}
                      onSave={() => void saveChannel(draft)}
                      onDelete={() => void deleteChannel(draft)}
                    />
                  </div>
                )}
              </section>
            )
          })}
        </div>
      ) : (
        <div className="mt-4 flex min-h-0 flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-yx-line bg-yx-surface px-4 py-12 text-center">
          <Network className="mx-auto h-7 w-7 text-yx-brand" />
          <p className="mt-2 text-xs font-medium text-yx-ink">还没有模型渠道</p>
          <p className="mt-0.5 text-[10px] text-yx-muted">
            添加一个 OpenAI 兼容 Chat Completions 渠道，配置密钥并添加模型后，各分析环节即可使用。
          </p>
        </div>
      )}
    </div>
  )
}

function ChannelStatusBadge({ draft, saving, deleting }: { draft: AiModelChannelDraft; saving: boolean; deleting: boolean }) {
  const baseClass = 'inline-flex items-center gap-1 rounded px-1.5 py-0.2 font-mono text-[10px] font-medium border'
  if (deleting) {
    return (
      <span className={`${baseClass} border-yx-line bg-yx-paper text-yx-muted`}>
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        删除中
      </span>
    )
  }
  if (saving) {
    return (
      <span className={`${baseClass} border-yx-brand/30 bg-yx-brand/10 text-yx-brand-hover`}>
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        保存中
      </span>
    )
  }
  if (!draft.id) {
    return (
      <span className={`${baseClass} border-rose-200 bg-rose-50 text-rose-700`}>
        <CircleDashed className="h-2.5 w-2.5" />
        未保存
      </span>
    )
  }
  if (draft.dirty) {
    return (
      <span className={`${baseClass} border-amber-200 bg-amber-50 text-amber-700`}>
        <Pencil className="h-2.5 w-2.5" />
        未保存更改
      </span>
    )
  }
  return (
    <span className={`${baseClass} border-yx-line bg-yx-paper text-yx-ink`}>
      <Check className="h-2.5 w-2.5 text-yx-brand" />
      已保存
    </span>
  )
}

function ChannelCardHeader({ draft, index, saving, deleting }: { draft: AiModelChannelDraft; index: number; saving: boolean; deleting: boolean }) {
  const channelLabel = 'Chat Completions'
  return (
    <span className="flex min-w-0 flex-1 items-center gap-3">
      {/* Drag handle */}
      <span className="select-none text-xs leading-none text-yx-faint">⋮⋮</span>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-yx-brand text-white shadow-2xs">
        <Network className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate text-xs font-semibold text-yx-ink" title={draft.name.trim() || `渠道 ${index + 1}`}>
            {draft.name.trim() || `渠道 ${index + 1}`}
          </span>
          <ChannelStatusBadge draft={draft} saving={saving} deleting={deleting} />
        </span>
        <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-yx-muted">
          <span className="truncate">{channelLabel}</span>
          <span className="text-yx-faint">·</span>
          {draft.models.length > 0 ? <span>{draft.models.length} 个模型</span> : <span className="text-rose-600">尚未添加模型</span>}
          <span className="text-yx-faint">·</span>
          <span className={`inline-flex items-center gap-1 font-mono ${draft.hasApiKey && draft.apiKeyUnavailable ? 'font-semibold text-rose-600' : ''}`}>
            <KeyRound className={`h-2.5 w-2.5 ${draft.hasApiKey && draft.apiKeyUnavailable ? 'text-rose-500' : 'text-yx-muted'}`} />
            {draft.hasApiKey
              ? draft.apiKeyUnavailable
                ? '密钥无法解密，请重新输入'
                : draft.apiKeyLastFour
                  ? `密钥尾号 ${draft.apiKeyLastFour}`
                  : '密钥已配置'
              : '未配置密钥'}
          </span>
        </span>
      </span>
    </span>
  )
}

function ChannelCardForm({
  draft,
  saving,
  deleting,
  onPatch,
  onSave,
  onDelete,
}: {
  draft: AiModelChannelDraft
  saving: boolean
  deleting: boolean
  onPatch: (patch: Partial<AiModelChannelDraft>) => void
  onSave: () => void
  onDelete: () => void
}) {
  const normalizedBaseUrl = normalizeBaseUrlForComparison(draft.baseUrl)
  const savedBaseUrl = normalizeBaseUrlForComparison(draft.originalBaseUrl ?? '')
  const hasSavedKeyForScope = draft.hasApiKey && normalizedBaseUrl === savedBaseUrl
  const canSave =
    draft.name.trim().length > 0 &&
    draft.models.length > 0 &&
    draft.models.every((model) => model.modelName.trim().length > 0) &&
    draft.baseUrl.trim().length > 0
  const fieldIdPrefix = draft.key
  const [expandedModelIndex, setExpandedModelIndex] = useState<number | null>(draft.id ? null : 0)

  function updateModel(modelIndex: number, update: Partial<AiModelProfileDraft>) {
    onPatch({ models: draft.models.map((model, currentIndex) => (currentIndex === modelIndex ? { ...model, ...update } : model)) })
  }

  function addModel() {
    const nextModels = [...draft.models, createModelDraft()]
    onPatch({ models: nextModels })
    setExpandedModelIndex(nextModels.length - 1)
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onSave()
      }}
      className="flex flex-col gap-5"
    >
      <fieldset disabled={saving || deleting} className="contents">
      {/* Connection Section */}
      <section aria-labelledby={`${fieldIdPrefix}-channel-connection-heading`}>
        <div className="flex items-center gap-2 text-xs font-semibold text-yx-ink">
          <Server className="h-3.5 w-3.5 text-yx-muted" />
          <h2 id={`${fieldIdPrefix}-channel-connection-heading`}>连接配置</h2>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <Field label="渠道名称" htmlFor={`${fieldIdPrefix}-channel-name`}>
            <input
              id={`${fieldIdPrefix}-channel-name`}
              required
              maxLength={80}
              value={draft.name}
              onChange={(event) => onPatch({ name: event.target.value })}
              placeholder="例如：团队 OpenAI"
              className="w-full px-3 py-2 bg-yx-paper border border-gray-200 rounded-md text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-yx-brand focus:border-transparent transition-all"
            />
          </Field>
          <Field label="API 地址" htmlFor={`${fieldIdPrefix}-channel-base-url`}>
            <input
              id={`${fieldIdPrefix}-channel-base-url`}
              required
              value={draft.baseUrl}
              onChange={(event) => onPatch({ baseUrl: event.target.value, clearApiKey: false })}
              placeholder="https://api.openai.com/v1"
              autoComplete="url"
              className="w-full px-3 py-2 bg-yx-paper border border-gray-200 rounded-md text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-yx-brand focus:border-transparent transition-all"
            />
          </Field>
          <Field
            label="API 密钥"
            htmlFor={`${fieldIdPrefix}-channel-api-key`}
            helper={
              draft.hasApiKey && draft.apiKeyUnavailable
                ? '已保存的密钥无法解密（服务器加密密钥可能已更换或丢失），请重新输入并保存'
                : hasSavedKeyForScope
                ? draft.apiKeyLastFour
                  ? `已保存 · 尾号 ${draft.apiKeyLastFour}`
                  : '已保存'
                : draft.hasApiKey
                ? '地址变更后需要重新输入'
                : '需要输入'
            }
          >
            <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-yx-paper px-3 transition-all focus-within:outline-none focus-within:ring-2 focus-within:ring-yx-brand focus-within:border-transparent">
              <KeyRound className="h-3.5 w-3.5 shrink-0 text-gray-400" />
              <input
                id={`${fieldIdPrefix}-channel-api-key`}
                type="password"
                value={draft.apiKey}
                onChange={(event) => onPatch({ apiKey: event.target.value, clearApiKey: false })}
                autoComplete="new-password"
                placeholder="输入 API 密钥"
                className="min-w-0 flex-1 bg-transparent py-2 text-xs text-gray-900 placeholder-gray-400 focus:outline-none"
              />
            </div>
          </Field>
        </div>
      </section>

      {/* Model Profiles Section */}
      <section className="border-t border-yx-line pt-4" aria-labelledby={`${fieldIdPrefix}-channel-models-heading`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-yx-ink">
            <Network className="h-3.5 w-3.5 text-yx-muted" />
            <h2 id={`${fieldIdPrefix}-channel-models-heading`}>模型配置</h2>
            <span className="font-normal text-[10px] text-yx-muted">展开模型可自动拉取模型列表</span>
          </div>
          <button
            type="button"
            onClick={addModel}
            className="flex h-7 items-center gap-1.5 rounded-md border border-yx-line bg-yx-paper px-2.5 text-xs font-medium text-yx-ink shadow-2xs transition-colors duration-150 hover:bg-yx-hover hover:text-yx-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus className="h-3 w-3" />
            <span>添加模型</span>
          </button>
        </div>
        <div className="mt-3 space-y-2">
          {draft.models.map((model, modelIndex) => (
            <ModelConfigCard
              key={model.id ?? `new-${modelIndex}`}
              draft={draft}
              model={model}
              modelIndex={modelIndex}
              expanded={expandedModelIndex === modelIndex}
              canDelete={draft.models.length > 1}
              fieldIdPrefix={fieldIdPrefix}
              onToggle={() => setExpandedModelIndex(expandedModelIndex === modelIndex ? null : modelIndex)}
              onUpdate={(update) => updateModel(modelIndex, update)}
              onRemove={() => {
                onPatch({ models: draft.models.filter((_, currentIndex) => currentIndex !== modelIndex) })
                setExpandedModelIndex((current) => nextExpandedIndexAfterDelete(current, modelIndex))
              }}
            />
          ))}
        </div>
      </section>

      {/* Footer Actions */}
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-yx-line pt-4">
        <button
          type="button"
          disabled={deleting}
          onClick={onDelete}
          className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-yx-muted transition-colors duration-150 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
        >
          {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          <span>删除渠道</span>
        </button>
        <button
          type="submit"
          disabled={saving || !canSave}
          className="flex h-8 items-center gap-1.5 rounded-md bg-yx-brand px-4 text-xs font-medium text-white shadow-xs transition-colors duration-150 hover:bg-yx-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin text-white" /> : <Save className="h-3.5 w-3.5 text-white" />}
          <span>保存渠道</span>
        </button>
      </footer>
      </fieldset>
    </form>
  )
}

function reasoningEffortLabel(effort: AiReasoningEffort) {
  if (effort === 'auto') return '自动（auto）'
  if (effort === 'low') return '低（low）'
  if (effort === 'medium') return '中（medium）'
  if (effort === 'high') return '高（high）'
  if (effort === 'xhigh') return '较高（xhigh）'
  return '最大（max）'
}

function ModelConfigCard({
  draft,
  model,
  modelIndex,
  expanded,
  canDelete,
  fieldIdPrefix,
  onToggle,
  onUpdate,
  onRemove,
}: {
  draft: AiModelChannelDraft
  model: AiModelProfileDraft
  modelIndex: number
  expanded: boolean
  canDelete: boolean
  fieldIdPrefix: string
  onToggle: () => void
  onUpdate: (update: Partial<AiModelProfileDraft>) => void
  onRemove: () => void
}) {
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState('')
  const [customMode, setCustomMode] = useState(false)
  const fetchSeqRef = useRef(0)
  const fetchControllerRef = useRef<AbortController | undefined>(undefined)

  const fetchUpstreamModels = useCallback(() => {
    const seq = ++fetchSeqRef.current
    fetchControllerRef.current?.abort()
    const controller = new AbortController()
    fetchControllerRef.current = controller
    setFetching(true)
    setFetchError('')
    apiFetch('/api/admin/ai-settings', {
      method: 'POST',
      headers: mutationHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        action: 'fetch_models',
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey,
        channelId: draft.id,
      }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as { models?: string[]; error?: string } | null
        if (seq !== fetchSeqRef.current) return
        if (!response.ok || !body?.models) {
          setFetchError(body?.error ?? '模型列表获取失败。')
          return
        }
        setModelOptions(body.models)
      })
      .catch(() => {
        if (seq === fetchSeqRef.current) setFetchError('无法连接上游模型服务。')
      })
      .finally(() => {
        if (seq !== fetchSeqRef.current) return
        fetchControllerRef.current = undefined
        setFetching(false)
      })
  }, [draft.baseUrl, draft.apiKey, draft.id])

  // 自动拉取上游模型列表需防抖：effect 依赖 apiKey，逐键输入会向管理端点
  // 发起请求风暴；400ms 内的连续输入只触发最后一次。
  useEffect(() => {
    if (!expanded) return
    const timer = window.setTimeout(() => {
      void fetchUpstreamModels()
    }, 400)
    return () => {
      window.clearTimeout(timer)
      fetchSeqRef.current += 1
      fetchControllerRef.current?.abort()
      fetchControllerRef.current = undefined
    }
  }, [expanded, draft.baseUrl, fetchUpstreamModels])

  const options = modelOptions
  const showInput = customMode || (options.length === 0 && !fetching)
  const selectedName = model.modelName

  return (
    <section className="overflow-hidden rounded-lg border border-yx-line bg-yx-surface shadow-2xs transition-all duration-150 hover:border-yx-brand">
      <div className="flex w-full items-center gap-2 bg-yx-surface px-3 py-2.5 transition-colors duration-150 hover:bg-yx-hover">
        <button type="button" onClick={onToggle} aria-expanded={expanded} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span className="select-none text-xs leading-none text-yx-faint">⋮⋮</span>
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-yx-brand text-white shadow-2xs">
            <Network className="h-3 w-3" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold text-yx-ink" title={selectedName}>
              {selectedName || `模型 ${modelIndex + 1}`}
            </span>
            <span className="mt-0.5 block truncate font-mono text-[10px] text-yx-muted">
              思考强度：{reasoningEffortLabel(model.reasoningEffort)} · 上下文：{model.maxContextCharacters.toLocaleString()} 字符 · 输出：{model.maxOutputTokens.toLocaleString()} tokens
            </span>
          </span>
        </button>
        {!expanded && canDelete && (
          <button
            type="button"
            aria-label={`删除模型 ${modelIndex + 1}`}
            title="删除模型"
            onClick={onRemove}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-yx-faint transition-colors hover:bg-rose-50 hover:text-rose-600"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          aria-label={expanded ? '收起模型配置' : '展开模型配置'}
          onClick={onToggle}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-yx-muted transition-colors hover:text-yx-ink"
        >
          <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {expanded && (
        <div className="border-t border-yx-line bg-yx-paper p-3.5">
          <div className="grid gap-3 md:grid-cols-2">
            <Field
              label="模型名称"
              htmlFor={`${fieldIdPrefix}-model-name-${modelIndex}`}
              helper={
                fetching
                  ? '正在拉取上游模型…'
                  : fetchError
                  ? '拉取失败，可手动输入'
                  : modelOptions.length
                  ? `${modelOptions.length} 个可用模型`
                  : '填写 API 密钥后自动拉取'
              }
            >
              {showInput ? (
                <input
                  id={`${fieldIdPrefix}-model-name-${modelIndex}`}
                  required
                  maxLength={160}
                  value={selectedName}
                  onChange={(event) => onUpdate({ modelName: event.target.value })}
                  placeholder="例如：gpt-4.1-mini"
                  className="w-full px-3 py-2 bg-yx-paper border border-gray-200 rounded-md text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-yx-brand focus:border-transparent transition-all"
                />
              ) : (
                <CustomSelect
                  id={`${fieldIdPrefix}-model-name-${modelIndex}`}
                  value={options.includes(selectedName) ? selectedName : '__custom__'}
                  searchable={options.length > 5}
                  searchPlaceholder="搜索模型…"
                  onChange={(value) => {
                    if (value === '__custom__') {
                      setCustomMode(true)
                      return
                    }
                    setCustomMode(false)
                    onUpdate({ modelName: value })
                  }}
                  options={[
                    ...options.map((name) => ({ value: name, label: name })),
                    ...(selectedName && !options.includes(selectedName)
                      ? [{ value: selectedName, label: `${selectedName}（当前）`, badge: '当前', badgeTone: 'amber' as const }]
                      : []),
                    { value: '__custom__', label: '手动输入模型名称…', description: '自定义模型标识符' },
                  ]}
                />
              )}
            </Field>
            <Field label="思考强度" htmlFor={`${fieldIdPrefix}-reasoning-effort-${modelIndex}`} helper="从低到最大；auto 不写入请求">
              <CustomSelect
                id={`${fieldIdPrefix}-reasoning-effort-${modelIndex}`}
                value={model.reasoningEffort}
                onChange={(value) => onUpdate({ reasoningEffort: value as AiReasoningEffort })}
                options={[
                  { value: 'auto', label: '自动（auto）', description: '由模型自适应' },
                  { value: 'low', label: '低（low）', description: '极速输出，精简推理' },
                  { value: 'medium', label: '中（medium）', description: '平衡模式，标准深度' },
                  { value: 'high', label: '高（high）', description: '深度思考，严谨推导' },
                  { value: 'xhigh', label: '较高（xhigh）', description: '增强思考链路' },
                  { value: 'max', label: '最大（max）', description: '极限制胜，最长推理' },
                ]}
              />
            </Field>
            <Field label="最大上下文（字符）" htmlFor={`${fieldIdPrefix}-model-context-${modelIndex}`}>
              <input
                id={`${fieldIdPrefix}-model-context-${modelIndex}`}
                type="number"
                min={MIN_MAX_CONTEXT_CHARACTERS}
                max={MAX_MAX_CONTEXT_CHARACTERS}
                step={1000}
                required
                value={model.maxContextCharacters}
                onChange={(event) => onUpdate({ maxContextCharacters: Number(event.target.value) })}
                className="w-full px-3 py-2 bg-yx-paper border border-gray-200 rounded-md font-mono text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-yx-brand focus:border-transparent transition-all"
              />
            </Field>
            <Field label="最大输出（tokens）" htmlFor={`${fieldIdPrefix}-model-output-${modelIndex}`}>
              <input
                id={`${fieldIdPrefix}-model-output-${modelIndex}`}
                type="number"
                min={MIN_MAX_OUTPUT_TOKENS}
                max={MAX_MAX_OUTPUT_TOKENS}
                step={256}
                required
                value={model.maxOutputTokens}
                onChange={(event) => onUpdate({ maxOutputTokens: Number(event.target.value) })}
                className="w-full px-3 py-2 bg-yx-paper border border-gray-200 rounded-md font-mono text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-yx-brand focus:border-transparent transition-all"
              />
            </Field>
          </div>

          {fetchError && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{fetchError}</span>
              <button
                type="button"
                onClick={() => void fetchUpstreamModels()}
                className="shrink-0 font-medium underline underline-offset-2 hover:opacity-80"
              >
                重新拉取
              </button>
            </div>
          )}
          {customMode && (
            <div className="mt-3 flex items-center gap-2 text-xs text-yx-muted">
              <span>已切换为手动输入模式。</span>
              <button
                type="button"
                onClick={() => setCustomMode(false)}
                className="font-medium text-yx-ink underline underline-offset-2 hover:opacity-80"
              >
                恢复下拉选择
              </button>
            </div>
          )}

          {canDelete && (
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={onRemove}
                className="flex items-center gap-1 text-xs text-yx-muted transition-colors duration-150 hover:text-rose-600"
              >
                <Trash2 className="h-3 w-3" />
                <span>移除该模型</span>
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

const modelSelectionTargetIcons: Record<AiModelSelectionTarget, typeof CheckCircle2> = {
  page_analysis: Sparkles,
  report_insight: BookOpen,
}

function ModelSelectionSettings({
  settings,
  error: loadError,
  onSettingsChange,
  onNotice,
}: {
  settings: AiModelSettings
  error: string
  onSettingsChange: (settings: AiModelSettings) => void
  onNotice: (message: string) => void
}) {
  const [selection, setSelection] = useState(() => assignmentsToDraft(settings.assignments))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [bulkModelId, setBulkModelId] = useState('')

  useEffect(() => {
    setSelection(assignmentsToDraft(settings.assignments))
  }, [settings])

  const configuredModelIds = new Set(
    settings.channels.filter((channel) => channel.hasApiKey && !channel.apiKeyUnavailable).flatMap((channel) => channel.models.map((model) => model.id))
  )
  const configuredModelCount = configuredModelIds.size
  const selectedCount = modelSelectionTargets.filter((target) => Boolean(selection[target])).length
  const readySelectionCount = modelSelectionTargets.filter((target) => configuredModelIds.has(selection[target])).length
  const unreadySelectionCount = selectedCount - readySelectionCount
  const hasChanges = modelSelectionTargets.some(
    (target) => selection[target] !== (settings.assignments.find((assignment) => assignment.target === target)?.modelId ?? '')
  )

  const bulkModelOptions = settings.channels.flatMap((channel) =>
    channel.hasApiKey && !channel.apiKeyUnavailable
      ? channel.models.map((model) => ({ id: model.id, label: `${model.modelName} · ${channel.name}` }))
      : []
  )

  function applyBulkSelection() {
    if (!bulkModelId) return
    setSelection((current) => {
      const next: Record<AiModelSelectionTarget, string> = { ...current }
      for (const target of modelSelectionTargets) next[target] = bulkModelId
      return next
    })
  }

  async function save() {
    setSaving(true)
    setError('')
    const response = await apiFetch('/api/admin/ai-settings', {
      method: 'PUT',
      headers: mutationHeaders({ 'Content-Type': 'application/json', 'If-Match': `"models-${settings.revision}"` }),
      body: JSON.stringify({
        action: 'save_assignments',
        revision: settings.revision,
        assignments: modelSelectionTargets.map((target) => ({ target, modelId: selection[target] || undefined })),
      }),
    }).catch(() => null)
    const body = (await response?.json().catch(() => null)) as { settings?: AiModelSettings; error?: string } | null
    if (!response?.ok || !body?.settings) {
      setError(body?.error ?? '模型选择保存失败。')
      setSaving(false)
      return
    }
    onSettingsChange(body.settings)
    setSaving(false)
    onNotice('模型选择已保存，将用于后续分析任务。')
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col pb-2">
      <div className="shrink-0">
        {/* Header */}
        <header className="border-b border-yx-line pb-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <IconBadge icon={Layers3} size="lg" />
              <div>
                <div className="flex items-center gap-2">
                  <h1 id="admin-settings-title" className="text-xl font-bold tracking-tight text-yx-ink">
                    模型选择
                  </h1>
                  <span className="rounded-md border border-yx-line bg-yx-surface px-2 py-0.5 font-mono text-xs font-medium text-yx-muted">
                    {readySelectionCount}/{modelSelectionTargets.length} 可运行
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-yx-muted">
                  为每个分析环节、视觉图表和研报洞察指定最佳适配的 AI 执行模型。
                </p>
              </div>
            </div>
          </div>
        </header>

        {(loadError || error) && (
          <div role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error || loadError}</span>
          </div>
        )}

        {!configuredModelCount && (
          <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50/80 p-3 text-xs text-amber-800">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <span className="leading-relaxed">
              请先在「渠道模型」中为至少一个渠道配置并保存有效 API 密钥，才能在各环节指派模型。
            </span>
          </div>
        )}

        {configuredModelCount > 0 && unreadySelectionCount > 0 && (
          <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50/80 p-3 text-xs text-amber-800">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <span>有 {unreadySelectionCount} 个执行目标尚未选择可运行模型，请指定对应模型。</span>
          </div>
        )}

        {/* Refined Bulk Apply Toolbar */}
        {configuredModelCount > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2.5 rounded-lg border border-yx-line bg-yx-surface p-3">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Sparkles className="h-4 w-4 shrink-0 text-yx-ink" />
              <span className="shrink-0 text-xs font-semibold text-yx-ink">一键应用全部</span>
              <CustomSelect
                ariaLabel="一键选择模型"
                variant="white"
                disabled={saving}
                value={bulkModelId}
                onChange={setBulkModelId}
                placeholder="选择一个模型应用到全部环节…"
                options={bulkModelOptions.map((option) => ({
                  value: option.id,
                  label: option.label,
                }))}
                className="min-w-0 flex-1"
              />
            </div>
            <button
              type="button"
              disabled={saving || !bulkModelId}
              onClick={applyBulkSelection}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-yx-brand px-3.5 text-xs font-medium text-white shadow-xs transition-colors duration-150 hover:bg-yx-brand-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Check className="h-3.5 w-3.5 text-white" />
              <span>一键应用</span>
            </button>
          </div>
        )}
      </div>

      {/* Target Assignments List - Clean Lucide Outline Icons */}
      <div aria-label="模型配置列表" className="yx-subtle-scrollbar mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
        <div className="space-y-2">
          {modelSelectionTargets.map((target) => {
            const detail = modelSelectionTargetDetails[target]
            const TargetIcon = modelSelectionTargetIcons[target] || Layers3

            return (
              <section
                key={target}
                className="group relative grid gap-3 rounded-lg border border-yx-line bg-yx-surface p-3.5 transition-all duration-150 hover:border-yx-brand hover:bg-yx-hover sm:grid-cols-[minmax(0,1fr)_16rem] sm:items-center"
              >
                <div className="flex items-start gap-2.5 min-w-0">
                  {/* Drag handle */}
                  <span className="select-none text-xs leading-none text-yx-faint pt-1">⋮⋮</span>
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-yx-brand text-white shadow-2xs">
                    <TargetIcon className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="text-xs font-semibold text-yx-ink">{detail.label}</h2>
                    </div>
                    <p className="mt-0.5 text-[10px] leading-relaxed text-yx-muted">{detail.detail}</p>
                  </div>
                </div>

                <CustomSelect
                  ariaLabel={`${detail.label} 使用的模型`}
                  disabled={saving || !configuredModelCount}
                  value={selection[target] || ''}
                  onChange={(value) => setSelection((current) => ({ ...current, [target]: value }))}
                  placeholder="未选择模型"
                  options={[
                    { value: '', label: '未选择模型' },
                    ...settings.channels.map((channel) => ({
                      group: `${channel.name}${channel.hasApiKey ? (channel.apiKeyUnavailable ? '（密钥无法解密）' : '') : '（未配置密钥）'}`,
                      options: channel.models.map((model) => ({
                        value: model.id,
                        label: `${model.modelName} · ${channel.name}`,
                        disabled: !channel.hasApiKey || channel.apiKeyUnavailable,
                        badge: channel.hasApiKey ? (channel.apiKeyUnavailable ? '密钥无法解密' : undefined) : '未配置密钥',
                        badgeTone: 'amber' as const,
                      })),
                    })),
                  ]}
                />
              </section>
            )
          })}
        </div>
      </div>

      {/* Sticky Save Bar */}
      <footer className="mt-4 flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-yx-line pt-4">
        <div className="flex items-center gap-1.5 text-yx-muted">
          <Sparkles className="h-3 w-3 text-yx-brand shrink-0" />
          <span className="text-[10px]">配置变更即时生效，不会中断当前正在运行中的任务。</span>
        </div>
        <button
          type="button"
          disabled={saving || !hasChanges}
          onClick={() => void save()}
          className="flex h-8 items-center gap-1.5 rounded-md bg-yx-brand px-4 text-xs font-medium text-white shadow-xs transition-colors duration-150 hover:bg-yx-brand-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin text-white" /> : <Save className="h-3.5 w-3.5 text-white" />}
          <span>保存选择</span>
        </button>
      </footer>
    </div>
  )
}

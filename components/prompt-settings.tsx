'use client'

import { AlertCircle, FileCode2, Loader2, RotateCcw, Save } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconBadge } from '@/components/ui/icon-badge'
import { apiFetch, mutationHeaders } from '@/lib/client-request'
import type { AnalysisGlobalSystemPrompt, AnalysisPromptConfig } from '@/modules/contracts/analysis'
import { AI_PROMPT_TARGETS, AI_PROMPT_TARGET_LABELS } from '@/lib/ai/prompt-defaults'

type PromptSetting = AnalysisPromptConfig
type PromptResponse = { revision?: number; systemPrompt?: AnalysisGlobalSystemPrompt; prompts?: PromptSetting[]; settings?: PromptResponse; error?: string }

const promptDetails: Record<(typeof AI_PROMPT_TARGETS)[number], string> = {
  page_analysis: '一次生成综合评分、报告详情、完整度、思维导图、词云、热力图和 AI 建议。',
  report_insight: '把报告编排为图文混排、便于快速阅读的洞察页面。',
}

type RestoreScope = { scope: 'all' } | { scope: 'system' } | { scope: 'target'; target: PromptSetting['target'] }
export type PromptDraftScope = 'all' | 'system' | PromptSetting['target']

export function nextPromptDrafts(input: {
  scope: PromptDraftScope
  currentSystem: string
  currentPrompts: PromptSetting[]
  savedSystemPrompt: string
  savedPrompts: PromptSetting[]
  submittedSystem: string
  submittedPrompts: PromptSetting[]
}) {
  const keepSystem = input.currentSystem !== input.submittedSystem
  const draftSystem = input.scope === 'all' || input.scope === 'system'
    ? (keepSystem ? input.currentSystem : input.savedSystemPrompt)
    : input.currentSystem
  const currentPrompts = input.currentPrompts.length ? input.currentPrompts : input.savedPrompts
  const draftPrompts = currentPrompts.map((draft) => {
    const inScope = input.scope === 'all' || draft.target === input.scope
    if (!inScope) return draft
    const submitted = input.submittedPrompts.find((item) => item.target === draft.target)
    if (submitted && draft.instructionPrompt !== submitted.instructionPrompt) return draft
    const saved = input.savedPrompts.find((item) => item.target === draft.target)
    return saved ? { ...saved } : draft
  })
  return { draftSystem, draftPrompts }
}

export function PromptSettings({ onNotice }: { onNotice: (message: string) => void }) {
  const [savedSystem, setSavedSystem] = useState<AnalysisGlobalSystemPrompt>()
  const [draftSystem, setDraftSystem] = useState('')
  const [savedPrompts, setSavedPrompts] = useState<PromptSetting[]>([])
  const [revision, setRevision] = useState(0)
  const [draftPrompts, setDraftPrompts] = useState<PromptSetting[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const draftSystemRef = useRef(draftSystem)
  const draftPromptsRef = useRef(draftPrompts)
  draftSystemRef.current = draftSystem
  draftPromptsRef.current = draftPrompts
  const loadSequenceRef = useRef(0)
  const loadControllerRef = useRef<AbortController | undefined>(undefined)

  const load = async () => {
    const requestSequence = ++loadSequenceRef.current
    loadControllerRef.current?.abort()
    const controller = new AbortController()
    loadControllerRef.current = controller
    setLoading(true)
    setError('')
    try {
      const response = await apiFetch('/api/admin/prompt-settings', { cache: 'no-store', signal: controller.signal })
      const body = await response.json().catch(() => null) as PromptResponse | null
      if (controller.signal.aborted || requestSequence !== loadSequenceRef.current) return
      if (!response.ok || !body?.prompts || !body.systemPrompt) throw new Error(body?.error ?? '提示词读取失败。')
      applyResponse(body.systemPrompt, body.prompts, body.revision)
    } catch (cause) {
      if (controller.signal.aborted || requestSequence !== loadSequenceRef.current) return
      setError(cause instanceof Error ? cause.message : '提示词读取失败。')
    } finally {
      if (loadControllerRef.current === controller) loadControllerRef.current = undefined
      if (!controller.signal.aborted && requestSequence === loadSequenceRef.current) setLoading(false)
    }
  }

  function applyResponse(
    system: AnalysisGlobalSystemPrompt,
    prompts: PromptSetting[],
    nextRevision?: number,
    options?: {
      scope?: PromptDraftScope
      submittedSystem?: string
      submittedPrompts?: PromptSetting[]
    },
  ) {
    if (Number.isSafeInteger(nextRevision) && Number(nextRevision) > 0) setRevision(Number(nextRevision))
    setSavedSystem(system)
    setSavedPrompts(prompts)
    if (!options) {
      setDraftSystem(system.systemPrompt)
      setDraftPrompts(prompts.map((prompt) => ({ ...prompt })))
      return
    }
    const next = nextPromptDrafts({
      scope: options.scope ?? 'all',
      currentSystem: draftSystemRef.current,
      currentPrompts: draftPromptsRef.current,
      savedSystemPrompt: system.systemPrompt,
      savedPrompts: prompts,
      submittedSystem: options.submittedSystem ?? draftSystemRef.current,
      submittedPrompts: options.submittedPrompts ?? draftPromptsRef.current,
    })
    setDraftSystem(next.draftSystem)
    setDraftPrompts(next.draftPrompts)
  }

  useEffect(() => {
    void load()
    return () => {
      loadSequenceRef.current += 1
      loadControllerRef.current?.abort()
    }
  }, [])

  const hasChanges = useMemo(() => {
    if (!savedSystem) return false
    return draftSystem !== savedSystem.systemPrompt || draftPrompts.some((draft) => {
      const saved = savedPrompts.find((prompt) => prompt.target === draft.target)
      return !saved || saved.instructionPrompt !== draft.instructionPrompt
    })
  }, [draftPrompts, draftSystem, savedPrompts, savedSystem])

  function updateInstruction(target: PromptSetting['target'], value: string) {
    setDraftPrompts((current) => current.map((prompt) => prompt.target === target ? { ...prompt, instructionPrompt: value } : prompt))
  }

  async function save() {
    const submittedSystem = draftSystem
    const submittedPrompts = draftPrompts.map((prompt) => ({ ...prompt }))
    setSaving(true)
    setError('')
    try {
      const response = await apiFetch('/api/admin/prompt-settings', {
        method: 'PUT',
        headers: mutationHeaders({ 'Content-Type': 'application/json', 'If-Match': `"prompts-${revision}"` }),
        body: JSON.stringify({
          action: 'save',
          revision,
          systemPrompt: submittedSystem,
          prompts: submittedPrompts.map(({ target, instructionPrompt }) => ({ target, instructionPrompt })),
        }),
      })
      const body = await response.json().catch(() => null) as { settings?: PromptResponse; error?: string } | null
      if (!response.ok || !body?.settings?.prompts || !body.settings.systemPrompt) throw new Error(body?.error ?? '提示词保存失败。')
      applyResponse(body.settings.systemPrompt, body.settings.prompts, body.settings.revision, {
        scope: 'all',
        submittedSystem,
        submittedPrompts,
      })
      loadSequenceRef.current += 1
      loadControllerRef.current?.abort()
      onNotice('提示词已保存，将用于后续新建的分析任务。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '提示词保存失败。')
    } finally {
      setSaving(false)
    }
  }

  async function restore(scope: RestoreScope) {
    const message = scope.scope === 'target'
      ? `确定恢复“${AI_PROMPT_TARGET_LABELS[scope.target]}”的默认任务提示词吗？`
      : scope.scope === 'system'
        ? '确定恢复默认系统提示词吗？该提示词对所有分析环节统一生效。'
        : '确定恢复全部默认提示词吗？未保存的修改也会被覆盖。'
    if (typeof window !== 'undefined' && !window.confirm(message)) return
    const submittedSystem = draftSystem
    const submittedPrompts = draftPrompts.map((prompt) => ({ ...prompt }))
    setSaving(true)
    setError('')
    try {
      const requestBody = scope.scope === 'target'
        ? { action: 'restore_defaults', targets: [scope.target], revision }
        : scope.scope === 'system'
          ? { action: 'restore_defaults', includeSystemPrompt: true, targets: [], revision }
          : { action: 'restore_defaults', includeSystemPrompt: true, revision }
      const response = await apiFetch('/api/admin/prompt-settings', {
        method: 'PUT',
        headers: mutationHeaders({ 'Content-Type': 'application/json', 'If-Match': `"prompts-${revision}"` }),
        body: JSON.stringify(requestBody),
      })
      const body = await response.json().catch(() => null) as { settings?: PromptResponse; error?: string } | null
      if (!response.ok || !body?.settings?.prompts || !body.settings.systemPrompt) throw new Error(body?.error ?? '默认提示词恢复失败。')
      applyResponse(body.settings.systemPrompt, body.settings.prompts, body.settings.revision, {
        scope: scope.scope === 'target' ? scope.target : scope.scope,
        submittedSystem,
        submittedPrompts,
      })
      loadSequenceRef.current += 1
      loadControllerRef.current?.abort()
      onNotice(scope.scope === 'target' ? '该环节已恢复默认任务提示词。' : scope.scope === 'system' ? '系统提示词已恢复默认。' : '全部提示词已恢复默认。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '默认提示词恢复失败。')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-64 items-center justify-center text-sm text-yx-muted">
        <Loader2 className="mr-2 h-4 w-4 animate-spin text-yx-brand" />
        正在读取提示词配置…
      </div>
    )
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col pb-2">
      <header className="shrink-0 border-b border-yx-line pb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <IconBadge icon={FileCode2} size="lg" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 id="admin-settings-title" className="text-xl font-bold tracking-tight text-yx-ink">提示词设置</h1>
                <span className="rounded-md border border-yx-line bg-yx-surface px-2 py-0.5 font-mono text-xs font-medium text-yx-muted">
                  {AI_PROMPT_TARGETS.length} 个环节
                </span>
                {hasChanges && (
                  <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                    未保存
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs leading-5 text-yx-muted">
                统一管理系统提示词与各分析环节的任务提示词，保存后仅作用于新建的分析任务。
              </p>
            </div>
          </div>
        </div>
      </header>

      {error && (
        <div role="alert" className="mt-4 flex shrink-0 items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div aria-label="提示词配置列表" className="yx-subtle-scrollbar mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1">
        <section aria-labelledby="global-system-prompt-heading" className="rounded-lg border border-yx-line bg-yx-surface p-4 shadow-2xs sm:p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id="global-system-prompt-heading" className="text-sm font-semibold text-yx-ink">系统提示词</h2>
              <p className="mt-1 text-xs text-yx-muted">定义所有分析环节共享的角色、安全与行为约束。</p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void restore({ scope: 'system' })}
              disabled={saving}
              className="h-7 shrink-0 px-2 text-[11px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yx-brand"
            >
              <RotateCcw className="h-3 w-3" />
              <span>恢复默认</span>
            </Button>
          </div>
          <label htmlFor="global-system-prompt" className="block">
            <span className="mb-1.5 block text-xs font-semibold text-yx-ink">系统提示词</span>
            <textarea
              id="global-system-prompt"
              disabled={saving}
              value={draftSystem}
              onChange={(event) => setDraftSystem(event.target.value)}
              rows={8}
              spellCheck={false}
              className="min-h-[180px] w-full resize-y rounded-md border border-yx-line bg-yx-paper px-3 py-2.5 font-mono text-xs leading-5 text-yx-ink outline-none transition focus:border-yx-brand focus:ring-2 focus:ring-yx-brand-soft disabled:cursor-not-allowed disabled:opacity-70"
            />
          </label>
        </section>

        {AI_PROMPT_TARGETS.map((target) => {
          const prompt = draftPrompts.find((item) => item.target === target)
          if (!prompt) return null
          const headingId = `${target}-prompt-heading`
          const inputId = `${target}-instruction-prompt`
          return (
            <section key={target} aria-labelledby={headingId} className="rounded-lg border border-yx-line bg-yx-surface p-4 shadow-2xs sm:p-5">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 id={headingId} className="text-sm font-semibold text-yx-ink">{AI_PROMPT_TARGET_LABELS[target]}</h2>
                  <p className="mt-1 text-xs text-yx-muted">{promptDetails[target]}</p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void restore({ scope: 'target', target })}
                  disabled={saving}
                  className="h-7 shrink-0 px-2 text-[11px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yx-brand"
                >
                  <RotateCcw className="h-3 w-3" />
                  <span>恢复本项</span>
                </Button>
              </div>
              <label htmlFor={inputId} className="block">
                <span className="mb-1.5 block text-xs font-semibold text-yx-ink">任务提示词</span>
                <textarea
                  id={inputId}
                  disabled={saving}
                  value={prompt.instructionPrompt}
                  onChange={(event) => updateInstruction(target, event.target.value)}
                  rows={8}
                  spellCheck={false}
                  className="min-h-[180px] w-full resize-y rounded-md border border-yx-line bg-yx-paper px-3 py-2.5 font-mono text-xs leading-5 text-yx-ink outline-none transition focus:border-yx-brand focus:ring-2 focus:ring-yx-brand-soft disabled:cursor-not-allowed disabled:opacity-70"
                />
              </label>
            </section>
          )
        })}
      </div>

      <footer className="mt-4 flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-yx-line pt-4">
        <div className="flex min-w-0 items-center gap-1.5 text-yx-muted">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${hasChanges ? 'bg-amber-500' : 'bg-yx-brand'}`} aria-hidden="true" />
          <span className="truncate text-[10px]">{hasChanges ? '有未保存更改，保存后用于新建的分析任务。' : '提示词变更仅作用于新建的分析任务。'}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="md"
            onClick={() => void restore({ scope: 'all' })}
            disabled={saving}
            className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yx-brand"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>恢复默认</span>
          </Button>
          <Button
            type="button"
            variant="primary"
            size="md"
            loading={saving}
            disabled={!hasChanges}
            onClick={() => void save()}
            className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yx-brand"
          >
            {!saving && <Save className="h-3.5 w-3.5" />}
            <span>保存提示词</span>
          </Button>
        </div>
      </footer>
    </div>
  )
}

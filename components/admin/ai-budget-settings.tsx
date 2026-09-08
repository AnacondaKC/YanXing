'use client'

import { AlertCircle, Info, Loader2, RotateCw, Save } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { AiBudgetLimits, AiBudgetSettingsResponse } from '@/lib/ai/budget-settings'
import { apiFetch, mutationHeaders } from '@/lib/client-request'
import {
  budgetSettingsToDraft,
  validateBudgetDraft,
  type AiBudgetDraft,
} from '@/components/admin/ai-budget-settings-form'

const BUDGET_ENDPOINT = '/api/admin/ai-budget-settings'
const SECONDARY_BUTTON = 'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border border-yx-line bg-yx-paper px-3 text-xs font-medium text-yx-ink-soft hover:bg-yx-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yx-brand disabled:cursor-not-allowed disabled:opacity-50'
const BUDGET_ROWS = [
  { label: '单用户每日 Token 上限', tokens: 'dailyTokens' },
  { label: '单用户最近 7 天 Token 上限', tokens: 'sevenDayTokens' },
] as const

async function readBudgetResponse(response: Response): Promise<AiBudgetSettingsResponse> {
  const body = await response.json().catch(() => null) as (AiBudgetSettingsResponse & { error?: string }) | null
  if (!response.ok) throw new Error(body?.error || '预算设置请求失败，请重试。')
  if (!body?.settings || !body.usage || !body.reservation || !body.periodKey || !body.sevenDayStartKey) {
    throw new Error('预算设置响应不完整，请重新加载。')
  }
  return body
}

function useBudgetSettings(onNotice: (message: string) => void) {
  const [data, setData] = useState<AiBudgetSettingsResponse>()
  const [draft, setDraft] = useState<AiBudgetDraft>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [conflict, setConflict] = useState(false)
  const [loadSequence, setLoadSequence] = useState(0)
  const saveRequest = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const response = await apiFetch(BUDGET_ENDPOINT, { cache: 'no-store', signal: controller.signal })
        const next = await readBudgetResponse(response)
        if (controller.signal.aborted) return
        setData(next)
        setDraft((current) => current ?? budgetSettingsToDraft(next.settings))
        setError('')
        setConflict(false)
        if (loadSequence > 0) setSuccess('已重新加载最新上限与占用；你的草稿已保留，请核对后保存。')
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '预算设置加载失败，请重试。')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [loadSequence])

  useEffect(() => () => saveRequest.current?.abort(), [])

  const validation = draft ? validateBudgetDraft(draft) : null
  const dirty = Boolean(data && draft && (Object.keys(draft) as (keyof AiBudgetLimits)[]).some((key) => (
    validation?.limits ? validation.limits[key] !== data.settings[key] : draft[key] !== budgetSettingsToDraft(data.settings)[key]
  )))

  function reload() {
    if (loading || saveRequest.current) return
    setLoading(true)
    setError('')
    setSuccess('')
    setLoadSequence((sequence) => sequence + 1)
  }

  function changeField(key: keyof AiBudgetLimits, value: string) {
    setDraft((current) => current ? { ...current, [key]: value } : current)
    setSuccess('')
    setError('')
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!data || !validation?.limits || !dirty || loading || conflict || saveRequest.current) return
    const controller = new AbortController()
    saveRequest.current = controller
    setSaving(true)
    setError('')
    setSuccess('')
    try {
      const response = await apiFetch(BUDGET_ENDPOINT, {
        method: 'PUT',
        headers: mutationHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ revision: data.settings.revision, limits: validation.limits }),
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      if (response.status === 409 || response.status === 412) {
        setConflict(true)
        return
      }
      const next = await readBudgetResponse(response)
      if (controller.signal.aborted) return
      setData(next)
      setDraft(budgetSettingsToDraft(next.settings))
      setSuccess('预算已保存，下一次任务立即生效，无需重启。')
      onNotice('AI 使用预算已保存')
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '预算保存失败，草稿已保留，请重试。')
    } finally {
      saveRequest.current = null
      if (!controller.signal.aborted) setSaving(false)
    }
  }

  return { data, draft, loading, saving, error, success, conflict, dirty, validation, reload, changeField, save }
}

export function AiBudgetSettingsPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const budget = useBudgetSettings(onNotice)
  const { data, draft, loading, saving, error, success, conflict, dirty, validation } = budget

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl">
      <header className="mb-5">
        <h1 className="text-xl font-bold tracking-tight text-yx-ink">AI 使用预算</h1>
        <p className="mt-1.5 text-xs leading-relaxed text-yx-muted">管理员统一设置两项 Token 上限，每个用户独立计量。</p>
      </header>

      {error && (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-yx-danger/25 bg-yx-danger-soft p-3 text-xs text-yx-danger-text">
          <AlertCircle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {!data || !draft ? (
        <div className="flex min-h-40 items-center justify-center">
          {loading ? <LoadingBudget /> : <button type="button" onClick={budget.reload} className={SECONDARY_BUTTON}>重新加载</button>}
        </div>
      ) : (
        <form onSubmit={budget.save} noValidate aria-busy={loading || saving}>
          <BudgetRules />
          <div className="mb-3 mt-5 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-yx-ink">使用上限</h2>
              <p className="mt-1 text-[11px] text-yx-muted">下方仅展示当前登录管理员自己的用量，已占用含已有消耗与未结算预留。</p>
            </div>
            <button type="button" disabled={loading || saving} onClick={budget.reload} className={SECONDARY_BUTTON}>
              <RotateCw aria-hidden="true" className={loading ? 'h-3.5 w-3.5 animate-spin motion-reduce:animate-none' : 'h-3.5 w-3.5'} />
              {loading ? '正在加载…' : '重新加载（保留草稿）'}
            </button>
          </div>
          <div className="mb-3 space-y-1 border-l-2 border-yx-brand pl-3 text-[11px] leading-relaxed text-yx-muted" aria-label="当前用户统计日期窗口">
            <p>今日（UTC）：<time className="font-mono" dateTime={data.periodKey}>{data.periodKey}</time></p>
            <p>最近 7 天（UTC，含首尾）：<time className="font-mono" dateTime={data.sevenDayStartKey}>{data.sevenDayStartKey}</time> 至 <time className="font-mono" dateTime={data.periodKey}>{data.periodKey}</time></p>
          </div>
          {conflict && (
            <div role="alert" className="mb-3 rounded-lg border border-yx-warning/30 bg-yx-warning-soft p-3 text-xs leading-relaxed text-yx-warning-text">
              预算已被其他管理员修改，未覆盖最新设置。你的草稿已保留，请先点击“重新加载（保留草稿）”，核对最新上限后再保存。
            </div>
          )}
          <fieldset disabled={loading || saving} className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            <legend className="sr-only">单用户每日与最近 7 天 Token 上限</legend>
            {BUDGET_ROWS.map((row) => (
              <div key={row.tokens} className="min-w-0 rounded-lg border border-yx-line bg-yx-paper p-3.5 sm:p-4">
                <BudgetNumberField
                  field={row.tokens}
                  label={row.label}
                  value={draft[row.tokens]}
                  error={validation?.errors[row.tokens]}
                  occupied={data.usage[row.tokens].toLocaleString('zh-CN')}
                  savedLimit={data.settings[row.tokens].toLocaleString('zh-CN')}
                  onChange={budget.changeField}
                />
              </div>
            ))}
          </fieldset>
          <BudgetReservations reservation={data.reservation} />
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-yx-line pt-4">
            <p role="status" className="text-xs text-yx-muted">{saving ? '正在保存…' : dirty ? '有未保存的更改' : '当前没有未保存的更改'}</p>
            <button type="submit" disabled={!dirty || !validation?.limits || loading || saving || conflict} className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md bg-yx-brand px-4 text-xs font-semibold text-white hover:bg-yx-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yx-brand disabled:cursor-not-allowed disabled:opacity-50">
              {saving ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <Save aria-hidden="true" className="h-3.5 w-3.5" />}
              {saving ? '正在保存…' : '保存预算'}
            </button>
          </div>
          {success && <p role="status" className="mt-3 text-xs leading-relaxed text-yx-brand">{success}</p>}
        </form>
      )}
    </div>
  )
}

function LoadingBudget() {
  return <p role="status" className="flex items-center gap-2 text-xs text-yx-muted"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin text-yx-brand motion-reduce:animate-none" />正在加载预算…</p>
}

function BudgetRules() {
  return (
    <aside className="flex items-start gap-2 rounded-lg border border-yx-line bg-yx-surface p-3 text-xs leading-relaxed text-yx-ink-soft" aria-label="预算规则">
      <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-yx-muted" />
      <ul className="min-w-0 space-y-1.5">
        <li>每个用户独立使用同一组上限，该用户跨课题的用量合并计算，其他用户的用量不影响自己的额度。</li>
        <li>每日按 UTC 日期计量；最近 7 天包含今日和之前 6 个 UTC 日期，每天 UTC 00:00（北京时间 08:00）向前滚动，不是固定自然周。</li>
        <li>任一 Token 上限的剩余额度不足以预留时，该用户的新任务将被拦截。</li>
        <li>保存不会清空已有消耗或未结算预留；下一次任务立即生效，无需重启。</li>
      </ul>
    </aside>
  )
}

function BudgetNumberField({ field, label, value, error, occupied, savedLimit, onChange }: {
  field: keyof AiBudgetLimits
  label: string
  value: string
  error?: string
  occupied: string
  savedLimit: string
  onChange: (field: keyof AiBudgetLimits, value: string) => void
}) {
  const id = 'ai-budget-' + field
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1.5 block text-xs font-medium text-yx-ink">{label}</label>
      <input
        id={id}
        type="number"
        name={field}
        inputMode="numeric"
        min="1"
        max={String(Number.MAX_SAFE_INTEGER)}
        step="1"
        required
        value={value}
        onChange={(event) => onChange(field, event.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={id + '-usage' + (error ? ' ' + id + '-error' : '')}
        className="h-10 w-full min-w-0 rounded-md border border-yx-line bg-yx-paper px-2.5 font-mono text-sm text-yx-ink outline-none focus:border-yx-brand focus:ring-2 focus:ring-yx-brand/15 disabled:opacity-60 aria-invalid:border-yx-danger"
      />
      <p id={id + '-usage'} className="mt-1.5 break-words text-[11px] leading-relaxed text-yx-muted">当前用户已占用 / 已保存上限：<span className="font-mono">{occupied} / {savedLimit}</span></p>
      {error && <p id={id + '-error'} className="mt-1.5 text-xs leading-relaxed text-yx-danger-text">{error}</p>}
    </div>
  )
}

function BudgetReservations({ reservation }: { reservation: AiBudgetSettingsResponse['reservation'] }) {
  return (
    <section className="mt-4 rounded-lg border border-yx-line bg-yx-surface p-3.5" aria-labelledby="ai-budget-reservations">
      <h2 id="ai-budget-reservations" className="text-xs font-semibold text-yx-ink">任务启动预留</h2>
      <p className="mt-1 text-[11px] leading-relaxed text-yx-muted">预留会先占用额度，不代表单次实际消耗；任务结算后以实际用量为准。</p>
      <dl className="mt-3 grid min-w-0 gap-3 text-xs sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-yx-ink-soft">单次分析预留</dt>
          <dd className="mt-1 break-words font-mono leading-relaxed text-yx-ink">{reservation.analysisTokens.toLocaleString('zh-CN')} Token</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-yx-ink-soft">单次洞察预留</dt>
          <dd className="mt-1 break-words font-mono leading-relaxed text-yx-ink">{reservation.insightTokens.toLocaleString('zh-CN')} Token</dd>
        </div>
      </dl>
    </section>
  )
}

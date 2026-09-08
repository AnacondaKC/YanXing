import { NextResponse } from 'next/server'
import { normalizeChatCompletionsBaseUrl } from '@/lib/ai/runtime/chat-completions'
import { readResponseBytes } from '@/lib/ai/runtime/http'
import { requireSettingsRevision } from '@/lib/http/settings-revision'
import { requireAdmin } from '@/lib/auth/request'
import { jsonBodyFailureResponse } from '@/lib/http/json-body-response'
import { readJsonBody, RequestBodyTimeoutError, RequestBodyTooLargeError } from '@/lib/http/request-body'
import {
  getPublicAiModelSettings,
  getChannelApiKeyForBaseUrl,
  isAiModelSelectionTarget,
  saveAiModelAssignments,
  saveAiModelChannel,
  deleteAiModelChannel,
  type AiModelAssignmentInput,
  type AiModelChannelInput,
  type AiModelProfileInput,
  SettingsRevisionConflictError,
} from '@/lib/db/settings-repository'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RequestBody = {
  action?: unknown
  channel?: unknown
  channelId?: unknown
  assignments?: unknown
  revision?: unknown
}

type ChannelRequest = {
  id?: unknown
  name?: unknown
  baseUrl?: unknown
  apiKey?: unknown
  clearApiKey?: unknown
  models?: unknown
}

export async function GET(request: Request) {
  const access = requireAdmin(request)
  if (access instanceof NextResponse) return access
  try {
    const settings = getPublicAiModelSettings()
    const etag = `"models-${settings.revision}"`
    if (request.headers.get('if-none-match') === etag) return new NextResponse(null, { status: 304, headers: { ETag: etag } })
    return NextResponse.json({ settings }, { headers: { ETag: etag } })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '设置读取失败。' }, { status: 500 })
  }
}

async function readSettingsBody(request: Request) {
  try {
    return await readJsonBody<RequestBody>(request, 256 * 1024)
  } catch (error) {
    if (error instanceof RequestBodyTimeoutError) return 'TIMEOUT' as const
    if (error instanceof RequestBodyTooLargeError) return 'TOO_LARGE' as const
    throw error
  }
}

export async function POST(request: Request) {
  const user = requireAdmin(request)
  if (user instanceof NextResponse) return user
  const body = await readSettingsBody(request)
  if (body === 'TIMEOUT') return jsonBodyFailureResponse(408)
  if (body === 'TOO_LARGE') return jsonBodyFailureResponse(413)
  if (!body || typeof body.action !== 'string') return NextResponse.json({ error: '设置请求无效。' }, { status: 400 })

  try {
    if (body.action === 'fetch_models') {
      const parsed = parseFetchModelsInput(body)
      if (parsed instanceof NextResponse) return parsed
      const apiKey = parsed.apiKey ?? (parsed.channelId
        ? getChannelApiKeyForBaseUrl(parsed.channelId, parsed.baseUrl)
        : undefined)
      if (!apiKey) return NextResponse.json({ error: parsed.channelId ? '渠道不存在、未配置 API 密钥，或 API 地址与渠道不一致。' : '请先填写 API 密钥，或保存包含 API 密钥的渠道。' }, { status: 400 })
      try {
        const models = await fetchAvailableModels(parsed.baseUrl, apiKey)
        return NextResponse.json({ models })
      } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : '模型列表获取失败。' }, { status: 400 })
      }
    }
    return NextResponse.json({ error: '未知的设置操作。' }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '模型列表获取失败。' }, { status: 400 })
  }
}

export async function PUT(request: Request) {
  const user = requireAdmin(request)
  if (user instanceof NextResponse) return user
  const body = await readSettingsBody(request)
  if (body === 'TIMEOUT') return jsonBodyFailureResponse(408)
  if (body === 'TOO_LARGE') return jsonBodyFailureResponse(413)
  if (!body || typeof body.action !== 'string') return NextResponse.json({ error: '设置请求无效。' }, { status: 400 })

  try {
    if (body.action === 'save_channel') {
      const parsed = parseChannelInput(body.channel, user.displayName || user.username)
      if (parsed instanceof NextResponse) return parsed
      const condition = requireSettingsRevision(body.revision, request, 'models')
      if (condition instanceof NextResponse) return condition
      const settings = saveAiModelChannel(parsed.input, parsed.id, user.id, condition.revision)
      return NextResponse.json({ settings }, { headers: { ETag: `"models-${settings.revision}"` } })
    }

    if (body.action === 'delete_channel') {
      if (typeof body.channelId !== 'string' || !body.channelId.trim()) {
        return NextResponse.json({ error: '渠道标识无效。' }, { status: 400 })
      }
      const condition = requireSettingsRevision(body.revision, request, 'models')
      if (condition instanceof NextResponse) return condition
      const settings = deleteAiModelChannel(body.channelId.trim(), user.displayName || user.username, user.id, condition.revision)
      return NextResponse.json({ settings }, { headers: { ETag: `"models-${settings.revision}"` } })
    }

    if (body.action === 'save_assignments') {
      const assignments = parseAssignments(body.assignments)
      if (assignments instanceof NextResponse) return assignments
      const condition = requireSettingsRevision(body.revision, request, 'models')
      if (condition instanceof NextResponse) return condition
      const settings = saveAiModelAssignments(assignments, user.displayName || user.username, user.id, condition.revision)
      return NextResponse.json({ settings }, { headers: { ETag: `"models-${settings.revision}"` } })
    }

    return NextResponse.json({ error: '未知的设置操作。' }, { status: 400 })
  } catch (error) {
    if (error instanceof SettingsRevisionConflictError) {
      const status = request.headers.get('if-match') === null ? 409 : 412
      return NextResponse.json({ error: error.message, revision: error.actualRevision }, { status, headers: { ETag: `"models-${error.actualRevision}"` } })
    }
    const message = error instanceof Error ? error.message : '设置保存失败。'
    return NextResponse.json({ error: message }, { status: message === '管理员权限已变更，请重新登录。' ? 403 : 400 })
  }
}

function parseFetchModelsInput(value: unknown): { baseUrl: string; apiKey?: string; channelId?: string } | NextResponse {
  if (!isRecord(value)) return NextResponse.json({ error: '拉取请求无效。' }, { status: 400 })
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : ''
  const normalized = normalizeChatCompletionsBaseUrl(baseUrl)
  if (!normalized) return NextResponse.json({ error: 'API 地址无效。' }, { status: 400 })
  return {
    baseUrl: normalized,
    apiKey: typeof value.apiKey === 'string' && value.apiKey.trim() ? value.apiKey.trim() : undefined,
    channelId: typeof value.channelId === 'string' && value.channelId.trim() ? value.channelId.trim() : undefined,
  }
}

async function fetchAvailableModels(baseUrl: string, apiKey: string) {
  const signal = AbortSignal.timeout(15_000)
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  }).catch(() => null)
  if (!response) throw new Error('无法连接上游模型服务。')
  const body = await readResponseBytes(response, apiKey, {
    signal,
    providerLabel: '模型列表',
    maxBytes: 256 * 1024,
    idleTimeoutMs: 5_000,
  })
  if (!response.ok) {
    throw new Error(`模型列表获取失败（HTTP ${response.status}）。`)
  }
  const payload = body.value
  if (!Array.isArray(payload.data)) throw new Error('模型列表响应格式无效。')
  if (payload.data.length > 200) throw new Error('上游返回的模型数量超过限制。')
  const models = [...new Set(payload.data
    .map((item) => (isRecord(item) && typeof item.id === 'string' ? item.id.trim() : ''))
    .filter((id) => id.length > 0 && id.length <= 160))]
  if (!models.length) throw new Error('上游未返回可用模型。')
  return models
}

function parseChannelInput(value: unknown, updatedBy: string): { id?: string; input: AiModelChannelInput } | NextResponse {
  if (!isRecord(value)) return NextResponse.json({ error: '渠道配置无效。' }, { status: 400 })
  const channel = value as ChannelRequest
  const id = typeof channel.id === 'string' && channel.id.trim() ? channel.id.trim() : undefined
  const baseUrl = typeof channel.baseUrl === 'string' ? channel.baseUrl.trim() : ''
  const normalized = normalizeChatCompletionsBaseUrl(baseUrl)
  if (!normalized || baseUrl.length > 2_048) {
    return NextResponse.json({ error: 'Chat Completions API 地址无效。' }, { status: 400 })
  }
  if (!Array.isArray(channel.models)) return NextResponse.json({ error: '模型列表格式无效。' }, { status: 400 })
  if (channel.apiKey !== undefined && typeof channel.apiKey !== 'string') {
    return NextResponse.json({ error: 'API 密钥格式无效。' }, { status: 400 })
  }

  return {
    id,
    input: {
      name: typeof channel.name === 'string' ? channel.name : '',
      baseUrl: typeof channel.baseUrl === 'string' ? channel.baseUrl : '',
      apiKey: typeof channel.apiKey === 'string' ? channel.apiKey : undefined,
      clearApiKey: channel.clearApiKey === true,
      models: channel.models as AiModelProfileInput[],
      updatedBy,
    },
  }
}

function parseAssignments(value: unknown): AiModelAssignmentInput[] | NextResponse {
  if (!Array.isArray(value)) return NextResponse.json({ error: '模型选择内容无效。' }, { status: 400 })
  const assignments: AiModelAssignmentInput[] = []
  for (const item of value) {
    if (!isRecord(item) || !isAiModelSelectionTarget(item.target)) {
      return NextResponse.json({ error: '模型选择内容无效。' }, { status: 400 })
    }
    if (item.modelId !== undefined && item.modelId !== null && typeof item.modelId !== 'string') {
      return NextResponse.json({ error: '模型标识无效。' }, { status: 400 })
    }
    assignments.push({
      target: item.target,
      modelId: typeof item.modelId === 'string' && item.modelId.trim() ? item.modelId.trim() : undefined,
    })
  }
  return assignments
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

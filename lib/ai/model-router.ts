import {
  type ChatCompletionsModel,
} from '@/lib/ai/runtime/chat-completions'
import { ModelProviderError } from '@/lib/ai/runtime/errors'
import { decryptSecret } from '@/lib/db/settings-crypto'
import {
  AI_MODEL_SELECTION_TARGET_LABELS,
  getAiModelRuntimeConfiguration,
  type AiModelRuntimeSnapshot,
  type AiModelSelectionTarget,
} from '@/lib/db/settings-repository'

export type RuntimeModel = ChatCompletionsModel

export interface ModelRuntime {
  primary: RuntimeModel
  apiKey: string
  maxContextCharacters: number
}

/** 入队时传入冻结配置；未传入时仅用于创建任务前的当前设置解析。 */
export function createModelRuntime(target: AiModelSelectionTarget, frozen?: AiModelRuntimeSnapshot): ModelRuntime {
  const selection = frozen ? { ...frozen, apiKey: decryptSecret(frozen.apiKeyEncrypted) ?? undefined } : getAiModelRuntimeConfiguration(target)
  const targetLabel = AI_MODEL_SELECTION_TARGET_LABELS[target]
  if (!selection) throw new Error(targetLabel + '尚未选择模型。')

  const channelLabel = selection.channelName
  if (!selection.apiKey) throw new Error(channelLabel + ' 尚未配置 API 密钥。')
  if (selection.channel !== 'chat_completions' || !selection.baseUrl) {
    throw new Error(channelLabel + ' 的 Chat Completions API 地址尚未配置。')
  }

  return {
    primary: {
      id: selection.modelName,
      provider: 'chat_completions',
      baseUrl: selection.baseUrl,
      maxContextCharacters: selection.maxContextCharacters,
      maxOutputTokens: selection.maxOutputTokens,
      reasoningEffort: selection.reasoningEffort,
    },
    apiKey: selection.apiKey,
    maxContextCharacters: selection.maxContextCharacters,
  }
}

export function isRetryableModelError(error: unknown) {
  // 重试判定只信 ModelProviderError.retryable：文本嗅探会把消息里偶然含
  // “timeout/429”等子串的确定性失败误判为可重试。
  return error instanceof ModelProviderError && error.retryable
}

export function getRetryAfterMs(error: unknown) {
  return error instanceof ModelProviderError ? error.retryAfterMs : undefined
}

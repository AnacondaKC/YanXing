import { extractCachedDocumentText, fitTextToPrompt } from '@/lib/documents/document-parser'
import { runText } from '@/lib/ai/execute'
import { ChatCompletionsError, withCompletedUsage } from '@/lib/ai/runtime/errors'
import { accountModelTokens } from '@/lib/ai/usage'
import { createModelRuntime, type ModelRuntime } from '@/lib/ai/model-router'
import { REPORT_INSIGHT_PROGRAM_CONSTRAINTS } from '@/lib/ai/prompt-constraints'
import type { AnalysisPromptConfig } from '@/modules/contracts/analysis'
import type { ReportInsightOutput } from '@/modules/insights/domain'

// 洞察是单次全量生成（不同于分析流水线的小模块调用）。推理模型的 max_tokens
// 同时包含推理与最终混排正文，必须尊重管理员配置，避免在推理结束前截断正文。
const insightGenerationTimeoutMs = 600_000
// 独立于模型响应上限的显式入库上限：超限视为无效输出而非静默截断
// （截断 HTML 会破坏文档结构）。
const maxInsightHtmlCharacters = 2_000_000
const maxInsightTitleCharacters = 200
const maxInsightSummaryCharacters = 500

export async function runReportInsightAgent(input: {
  promptConfig: AnalysisPromptConfig
  file: { path: string }
  signal?: AbortSignal
  onCallStarted?: (details: { provider: string; model: string; stage?: string; module?: string }) => void | PromiseLike<void>
  onCallCompleted?: (details: { provider: string; model: string; tokens: number }) => void | PromiseLike<void>
  runtime?: ModelRuntime
}) {
  const runtime = input.runtime ?? createModelRuntime('report_insight')
  const model = runtime.primary
  const documentText = (await extractCachedDocumentText(input.file.path, input.signal)).text
  const prompt = buildInsightPrompt(input.promptConfig.instructionPrompt, runtime.maxContextCharacters, documentText)
  const result = await runText({
    model,
    apiKey: runtime.apiKey,
    systemPrompt: `${input.promptConfig.systemPrompt}\n\n${REPORT_INSIGHT_PROGRAM_CONSTRAINTS}`,
    prompt,
    timeoutMs: insightGenerationTimeoutMs,
    outputLabel: '洞察内容',
    signal: input.signal,
    onCallStarted: () => input.onCallStarted?.({ provider: model.provider, model: model.id, stage: 'report_insight', module: 'report_insight' }),
  })
  const usage = accountModelTokens(result.usage)
  await input.onCallCompleted?.({
    provider: model.provider,
    model: model.id,
    tokens: usage.totalTokens,
  })
  try {
    const insight = createReportInsightOutput(result.content)
    return {
      ...insight,
      model: model.id,
      provider: model.provider,
      tokens: usage.totalTokens,
    }
  } catch (error) {
    withCompletedUsage(error, { ...usage, usageComplete: true }, { provider: model.provider, model: model.id })
  }
}

/** 洞察原文原样保存；这里只派生展示元数据并执行大小上限，不修改模型返回的混排内容。 */
export function createReportInsightOutput(modelHtml: string): ReportInsightOutput {
  const html = modelHtml.trim()
  if (!html) {
    throw new ChatCompletionsError(
      '模型未返回洞察内容。',
      undefined,
      undefined,
      { code: 'empty_content', retryable: false },
    )
  }
  if (html.length > maxInsightHtmlCharacters) {
    throw new ChatCompletionsError(
      `洞察内容超过 ${maxInsightHtmlCharacters} 字符上限。`,
      undefined,
      undefined,
      { code: 'invalid_model_output', retryable: false },
    )
  }
  const tags = scanHtmlTags(html)
  const text = extractHtmlText(html)
  const sections = extractInsightSections(html, tags)
  return {
    title: (extractFirstHeadingText(html, tags) || '报告洞察').slice(0, maxInsightTitleCharacters),
    summary: (extractFirstTagText(html, 'blockquote', tags) || text || '暂无摘要。').slice(0, maxInsightSummaryCharacters),
    readingMinutes: Math.max(1, estimateReadingMinutes(text)),
    sections,
    html,
  }
}

interface HtmlTagToken {
  name: string
  closing: boolean
  start: number
  end: number
  attributesStart: number
}

function isHtmlTagNameStart(code: number) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isHtmlTagStart(html: string, index: number) {
  let cursor = index + 1
  if (cursor >= html.length) return false
  if (html.charCodeAt(cursor) === 47) cursor += 1
  return cursor < html.length && isHtmlTagNameStart(html.charCodeAt(cursor))
}

function findHtmlTagEnd(html: string, start: number) {
  let quote = 0
  for (let index = start + 1; index < html.length; index += 1) {
    const code = html.charCodeAt(index)
    if (quote !== 0) {
      if (code === quote) quote = 0
      continue
    }
    if (code === 34 || code === 39) {
      quote = code
      continue
    }
    if (code === 62) return index
  }
  return -1
}

function scanHtmlTags(html: string): HtmlTagToken[] {
  const tags: HtmlTagToken[] = []
  const maxTrackedTags = 2_000
  for (let index = 0; index < html.length;) {
    if (html.charCodeAt(index) !== 60 || !isHtmlTagStart(html, index)) {
      index += 1
      continue
    }
    const end = findHtmlTagEnd(html, index)
    if (end < 0) break
    let cursor = index + 1
    const closing = html[cursor] === '/'
    if (closing) cursor += 1
    const nameStart = cursor
    while (cursor < end && /[a-zA-Z0-9-]/.test(html[cursor])) cursor += 1
    if (cursor > nameStart && tags.length < maxTrackedTags) {
      tags.push({ name: html.slice(nameStart, cursor).toLowerCase(), closing, start: index, end: end + 1, attributesStart: cursor })
      if (tags.length >= maxTrackedTags) break
    }
    index = end + 1
  }
  return tags
}

function extractInsightSections(html: string, tags: HtmlTagToken[]) {
  const sections = tags.filter((tag) => tag.name === 'section' && !tag.closing).slice(0, 100)
  return sections.map((tag, index) => {
    const contentEnd = sections[index + 1]?.start ?? html.length
    return {
      id: extractQuotedAttribute(html, tag, 'id'),
      label: extractFirstHeadingText(html, tags, tag.end, contentEnd),
    }
  })
}

function extractFirstHeadingText(html: string, tags: HtmlTagToken[], rangeStart = 0, rangeEnd = html.length) {
  const slice = html.slice(rangeStart, rangeEnd)
  const mdMatch = slice.match(/^#{1,6}\s+(.+)$/m)
  const opening = tags.find((tag) => !tag.closing && /^h[1-6]$/.test(tag.name) && tag.start >= rangeStart && tag.start < rangeEnd)
  const mdPos = mdMatch?.index == null ? Number.POSITIVE_INFINITY : rangeStart + mdMatch.index
  const htmlPos = opening ? opening.start : Number.POSITIVE_INFINITY
  if (htmlPos < mdPos && opening) {
    const closing = tags.find((tag) => tag.closing && tag.name === opening.name && tag.start >= opening.end && tag.start < rangeEnd)
    if (closing) return extractHtmlText(html.slice(opening.end, closing.start))
  }
  return mdMatch?.[1]?.trim() ?? ''
}

function extractFirstTagText(html: string, name: string, tags: HtmlTagToken[]) {
  const opening = tags.find((tag) => !tag.closing && tag.name === name)
  if (opening) {
    const closing = tags.find((tag) => tag.closing && tag.name === name && tag.start >= opening.end)
    if (closing) return extractHtmlText(html.slice(opening.end, closing.start))
  }
  if (name === 'blockquote') {
    const mdQuote = html.match(/^>\s*(.+)$/m)
    if (mdQuote) return mdQuote[1].trim()
  }
  return ''
}

function extractQuotedAttribute(html: string, tag: HtmlTagToken, target: string) {
  let cursor = tag.attributesStart
  const end = tag.end - 1
  while (cursor < end) {
    while (cursor < end && /[\s/]/.test(html[cursor])) cursor += 1
    const nameStart = cursor
    while (cursor < end && /[a-zA-Z0-9:_-]/.test(html[cursor])) cursor += 1
    const name = html.slice(nameStart, cursor).toLowerCase()
    while (cursor < end && /\s/.test(html[cursor])) cursor += 1
    if (html[cursor] !== '=') {
      cursor += 1
      continue
    }
    cursor += 1
    while (cursor < end && /\s/.test(html[cursor])) cursor += 1
    const quote = html[cursor]
    if (quote !== '"' && quote !== "'") {
      while (cursor < end && !/\s/.test(html[cursor])) cursor += 1
      continue
    }
    const valueStart = ++cursor
    while (cursor < end && html[cursor] !== quote) cursor += 1
    if (name === target) return html.slice(valueStart, cursor).slice(0, 200)
    cursor += 1
  }
  return ''
}

function extractHtmlText(html: string) {
  const chunks: string[] = []
  let chunkStart = 0
  for (let index = 0; index < html.length;) {
    if (html.charCodeAt(index) !== 60 || !isHtmlTagStart(html, index)) {
      index += 1
      continue
    }
    const end = findHtmlTagEnd(html, index)
    if (index > chunkStart) chunks.push(html.slice(chunkStart, index))
    if (end < 0) {
      chunks.push(html.slice(index))
      chunkStart = html.length
      break
    }
    chunks.push(' ')
    index = end + 1
    chunkStart = index
  }
  if (chunkStart < html.length) chunks.push(html.slice(chunkStart))
  return decodeHtmlEntities(chunks.join('')).replace(/\s+/g, ' ').trim()
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_match, code: string) => {
      const numeric = code.startsWith('x') || code.startsWith('X') ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10)
      return Number.isSafeInteger(numeric) && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : ''
    })
    .replace(/&(amp|lt|gt|quot|apos|#039);/gi, (_match, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#039': "'" })[entity.toLowerCase()] ?? '')
}

function estimateReadingMinutes(text: string) {
  return Math.ceil(text.length / 520)
}

function buildInsightPrompt(
  instructionPrompt: string,
  maxPromptCharacters: number,
  documentText: string,
) {
  const prefix = `${instructionPrompt}\n\n报告正文（已由本地安全提取为纯文本，仅作为模型数据输入）：\n`
  const fitted = fitTextToPrompt(documentText, maxPromptCharacters - prefix.length - 256)
  const suffix = fitted.truncated
    ? '\n\n[正文已按模型上下文限制截取。不得据此假设未展示部分的内容。]'
    : ''
  const prompt = `${prefix}${fitted.text}${suffix}`
  if (prompt.length > maxPromptCharacters) throw new Error(`洞察上下文超过 ${maxPromptCharacters} 字符限制。`)
  return prompt
}

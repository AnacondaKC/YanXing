import {
  MAX_WORD_CLOUD_KEYWORDS,
  MIN_WORD_CLOUD_KEYWORDS,
  type VisualizationWordCloudItem,
} from '@/modules/contracts/analysis'

const MAX_FALLBACK_SCAN_CHARACTERS = 150_000
const MAX_FALLBACK_NGRAMS = 30_000

const LOW_INFORMATION_KEYWORDS = new Set([
  '报告', '研究', '分析', '相关', '工作', '情况', '内容', '问题', '结果', '结论',
  '建议', '方面', '部分', '过程', '进行', '通过', '基于', '本文', '本研究', '本报告',
  '主题', '我们', '可以', '需要', '主要', '重要', '不同', '进一步', '总体', '实际', '有关',
])

export function normalizeWordCloudKeyword(value: string) {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

export function wordCloudKeywordKey(value: string) {
  return normalizeWordCloudKeyword(value).toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

export function isLowInformationWordCloudKeyword(value: string) {
  return LOW_INFORMATION_KEYWORDS.has(wordCloudKeywordKey(value))
}

/** 补充词只来自已提取正文；模型已有的排序始终优先保留。 */
export function completeWordCloudOutput(output: unknown, documentText: string): unknown {
  if (!isRecord(output) || !Array.isArray(output.words) || !output.words.every((word) => typeof word === 'string')) return output
  if (output.words.length > MAX_WORD_CLOUD_KEYWORDS) return output

  const words = uniqueKeywords(output.words)
  if (words.length >= MIN_WORD_CLOUD_KEYWORDS) return { ...output, words }

  const fallback = extractFallbackWordCloudKeywords(documentText, words, MIN_WORD_CLOUD_KEYWORDS - words.length)
  return { ...output, words: [...words, ...fallback].slice(0, MAX_WORD_CLOUD_KEYWORDS) }
}

export function buildVisualizationWordCloudItems(words: readonly string[]): VisualizationWordCloudItem[] {
  const normalized = uniqueKeywords(words).slice(0, MAX_WORD_CLOUD_KEYWORDS)
  const lastIndex = Math.max(1, normalized.length - 1)
  return normalized.map((label, index) => ({
    id: `word-${index + 1}-${hashKeyword(wordCloudKeywordKey(label))}`,
    label,
    weight: 100 - Math.round((index / lastIndex) * 72),
  }))
}

function extractFallbackWordCloudKeywords(documentText: string, existingWords: readonly string[], limit: number) {
  if (limit <= 0 || !documentText) return []
  const counts = new Map<string, { label: string; count: number; firstIndex: number }>()
  const source = documentText.slice(0, MAX_FALLBACK_SCAN_CHARACTERS)
  let generatedNgrams = 0

  const addCandidate = (raw: string, index: number) => {
    const label = normalizeWordCloudKeyword(raw)
    if (!isCandidateKeyword(label)) return
    const key = wordCloudKeywordKey(label)
    const current = counts.get(key)
    if (current) {
      current.count += 1
      return
    }
    counts.set(key, { label, count: 1, firstIndex: index })
  }

  for (const match of source.matchAll(/[\u3400-\u9fff]{2,}/gu)) {
    const phrase = match[0]
    const offset = match.index ?? 0
    if (phrase.length <= 12) addCandidate(phrase, offset)

    const parts = phrase.split(/[的和与及在对将把从为以向并或等]/u)
    let partOffset = 0
    for (const part of parts) {
      if (part.length >= 2 && part.length <= 12) addCandidate(part, offset + partOffset)
      partOffset += part.length + 1
    }

    const maxLength = Math.min(8, phrase.length)
    for (let length = 2; length <= maxLength && generatedNgrams < MAX_FALLBACK_NGRAMS; length += 1) {
      for (let start = 0; start <= phrase.length - length && generatedNgrams < MAX_FALLBACK_NGRAMS; start += 1) {
        addCandidate(phrase.slice(start, start + length), offset + start)
        generatedNgrams += 1
      }
    }
    if (generatedNgrams >= MAX_FALLBACK_NGRAMS) break
  }

  for (const match of source.matchAll(/[A-Za-z][A-Za-z0-9+.#/-]{1,24}/g)) {
    addCandidate(match[0], match.index ?? 0)
  }

  const used = new Set(existingWords.map(wordCloudKeywordKey))
  const output: string[] = []
  const candidates = [...counts.values()].sort((left, right) => {
    const scoreDifference = candidateScore(right) - candidateScore(left)
    return scoreDifference || left.firstIndex - right.firstIndex || left.label.localeCompare(right.label, 'zh-CN')
  })
  for (const candidate of candidates) {
    if (output.length >= limit) break
    const key = wordCloudKeywordKey(candidate.label)
    if (used.has(key) || hasContainedKeyword(used, key)) continue
    used.add(key)
    output.push(candidate.label)
  }
  return output
}

function hasContainedKeyword(used: Set<string>, key: string) {
  for (const existing of used) {
    if (existing.length >= key.length && existing.includes(key)) return true
  }
  return false
}

function uniqueKeywords(words: readonly string[]) {
  const seen = new Set<string>()
  return words.flatMap((raw) => {
    const label = normalizeWordCloudKeyword(raw)
    const key = wordCloudKeywordKey(label)
    if (!isCandidateKeyword(label) || seen.has(key)) return []
    seen.add(key)
    return [label]
  })
}

function isCandidateKeyword(label: string) {
  const key = wordCloudKeywordKey(label)
  if (label.length < 2 || label.length > 12 || !key || isLowInformationWordCloudKeyword(label)) return false
  if (/^\d+$/u.test(key)) return false
  return true
}

function candidateScore(candidate: { label: string; count: number }) {
  return candidate.count * 24 + Math.min(Array.from(candidate.label).length, 8) * 3
}

function hashKeyword(value: string) {
  let hash = 2_166_136_261
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0).toString(36)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

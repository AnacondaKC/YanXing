import { MAX_WORD_CLOUD_KEYWORDS, type VisualizationWordCloudItem } from '@/modules/contracts/analysis'

export const WORD_CLOUD_LAYOUT_SCALES = [1, 0.9, 0.8, 0.7] as const

export interface WordCloudRenderWord {
  id: string
  text: string
  value: number
  rank: number
  fontSize: number
  fontWeight: 600 | 700
}

export interface WordCloudLayout {
  words: WordCloudRenderWord[]
  minFontSize: number
  maxFontSize: number
  padding: number
}

export function createWordCloudLayout(
  items: readonly VisualizationWordCloudItem[],
  size: { width: number; height: number },
  scale = 1,
): WordCloudLayout {
  const ranked = [...items]
    .sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id))
    .slice(0, MAX_WORD_CLOUD_KEYWORDS)
  const count = ranked.length
  const averageLength = count
    ? ranked.reduce((total, item) => total + Math.max(2, Array.from(item.label).length), 0) / count
    : 2
  const maxCap = Math.max(56, Math.min(100, Math.round(Math.min(size.width, size.height) * 0.2)))
  const calculatedMax = Math.round(0.85 * Math.sqrt((Math.max(1, size.width) * Math.max(1, size.height) * 0.78) / (Math.max(1, count) * averageLength)))
  const baseMax = clamp(
    calculatedMax,
    20,
    maxCap,
  )
  const maxFontSize = Math.max(8, Math.round(baseMax * scale))
  const minFontSize = clamp(Math.round(maxFontSize * 0.28), 8, 22)
  const lastRank = Math.max(1, count - 1)

  return {
    words: ranked.map((item, rank) => {
      const importance = 1 - rank / lastRank
      return {
        id: item.id,
        text: item.label,
        value: item.weight,
        rank,
        fontSize: Math.round(minFontSize + (maxFontSize - minFontSize) * importance ** 1.8),
        fontWeight: rank < Math.ceil(count * 0.15) ? 700 : 600,
      }
    }),
    minFontSize,
    maxFontSize,
    padding: scale <= WORD_CLOUD_LAYOUT_SCALES[WORD_CLOUD_LAYOUT_SCALES.length - 1] ? 2 : clamp(Math.round(4 * scale), 2, 4),
  }
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value))
}

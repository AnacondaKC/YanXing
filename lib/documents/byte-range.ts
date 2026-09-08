export interface ResolvedByteRange {
  start: number
  end: number
  partial: boolean
}

export function resolveByteRange(header: string | null, size: number): ResolvedByteRange | undefined {
  if (!Number.isSafeInteger(size) || size <= 0) return undefined
  if (!header) return { start: 0, end: size - 1, partial: false }
  if (!header.startsWith('bytes=') || header.includes(',')) return undefined

  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2])) return undefined

  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return undefined
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
      partial: true,
    }
  }

  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(requestedEnd)
    || start < 0
    || start >= size
    || requestedEnd < start
  ) return undefined

  return {
    start,
    end: Math.min(requestedEnd, size - 1),
    partial: true,
  }
}

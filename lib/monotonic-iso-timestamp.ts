export function nextMonotonicIsoTimestamp(previousIso?: string | null) {
  if (previousIso === undefined || previousIso === null || previousIso === '') {
    return new Date().toISOString()
  }
  const previousMs = Date.parse(previousIso)
  if (!Number.isFinite(previousMs)) throw new Error('记录版本时间无效，请刷新后重试。')
  return new Date(Math.max(Date.now(), previousMs + 1)).toISOString()
}

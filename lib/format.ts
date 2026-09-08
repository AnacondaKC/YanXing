export function scoreTextClass(score: number | undefined) {
  if (score === undefined) return 'text-yx-faint'
  if (score >= 80) return 'text-yx-brand'
  if (score >= 60) return 'text-yx-brand-hover'
  return 'text-yx-warning-text'
}

export function formatCharacters(count: number) {
  if (count >= 10000) return `${(count / 10000).toFixed(1)} 万`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
  return String(count)
}

export function formatReportCharacters(value: number) {
  return value >= 10000 ? `${(value / 10000).toFixed(1)}万` : value.toLocaleString('zh-CN')
}

export function formatMetric(value: number | undefined, suffix = '') {
  if (value === undefined) return '--'
  const formatted = Number.isInteger(value) ? value.toString() : value.toFixed(1)
  return `${formatted}${suffix}`
}

export function formatDate(value: string | undefined) {
  if (!value) return '--'
  return value.slice(5, 10).replace('-', '/')
}

export function formatRelativeTime(value: string) {
  const time = new Date(value).getTime()
  if (Number.isNaN(time)) return '--'
  const diff = Date.now() - time
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 60 * 60 * 1000) return Math.max(1, Math.floor(diff / 60000)) + ' 分钟前'
  if (diff < 24 * 60 * 60 * 1000) return Math.max(1, Math.floor(diff / 3600000)) + ' 小时前'
  if (diff < 48 * 60 * 60 * 1000) return '昨天'
  return formatDate(value)
}

export function formatReportDate(value: string) {
  return new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export function formatReportTime(value: string) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function formatBytes(bytes: number) {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${parseFloat((bytes / Math.pow(1024, index)).toFixed(1))} ${units[index]}`
}

export const OVERVIEW_TREND_DAYS = 7

export function localDayKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return year + "-" + month + "-" + day
}

export function lastDayKeys(days = OVERVIEW_TREND_DAYS, now = new Date()): string[] {
  const keys: string[] = []
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    keys.push(localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset)))
  }
  return keys
}

export function cumulativeTrend(
  events: Array<{ at: string; value: number }>,
  days = OVERVIEW_TREND_DAYS,
  now = new Date(),
): number[] {
  const keys = lastDayKeys(days, now)
  const windowStart = keys[0]
  const byDay = new Map<string, number>()
  let running = 0

  for (const event of events) {
    const parsed = new Date(event.at)
    if (Number.isNaN(parsed.getTime())) continue
    const key = localDayKey(parsed)
    if (key < windowStart) running += event.value
    else byDay.set(key, (byDay.get(key) ?? 0) + event.value)
  }

  return keys.map((key) => {
    running += byDay.get(key) ?? 0
    return running
  })
}

export type TrendDirection = 'up' | 'down' | 'flat'

export function trendDirectionOf(points: number[]): TrendDirection {
  const values = points.filter((point) => Number.isFinite(point))
  if (values.length < 2) return 'flat'
  const first = values[0]
  const last = values[values.length - 1]
  if (last > first) return 'up'
  if (last < first) return 'down'
  return 'flat'
}

export function runningAverageValues(
  events: Array<{ at: string; value: number }>,
  days = OVERVIEW_TREND_DAYS,
  now = new Date(),
): number[] {
  const keys = lastDayKeys(days, now)
  const windowStart = keys[0]
  const byDay = new Map<string, { sum: number; count: number }>()
  let sum = 0
  let count = 0
  for (const event of events) {
    const parsed = new Date(event.at)
    if (Number.isNaN(parsed.getTime())) continue
    const key = localDayKey(parsed)
    if (key < windowStart) {
      sum += event.value
      count += 1
      continue
    }
    const bucket = byDay.get(key) ?? { sum: 0, count: 0 }
    bucket.sum += event.value
    bucket.count += 1
    byDay.set(key, bucket)
  }
  return keys.map((key) => {
    const bucket = byDay.get(key)
    if (bucket) {
      sum += bucket.sum
      count += bucket.count
    }
    return count ? sum / count : 0
  })
}

import { localDayKey } from '@/lib/overview-trends'

export function dateWeeksFromNow(weeksFromNow: number, from = new Date()) {
  const next = new Date(from)
  next.setDate(next.getDate() + weeksFromNow * 7)
  return localDayKey(next)
}

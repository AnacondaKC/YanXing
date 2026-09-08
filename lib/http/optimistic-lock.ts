export function readRequiredUpdatedAt(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  if (!Number.isFinite(Date.parse(value))) return undefined
  return value
}

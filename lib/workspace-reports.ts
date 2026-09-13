export function toggleHiddenProjectId(hiddenIds: readonly string[], projectId: string) {
  return hiddenIds.includes(projectId)
    ? hiddenIds.filter((id) => id !== projectId)
    : [...hiddenIds, projectId]
}

export function parseHiddenProjectIds(raw: string | null) {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
  } catch {
    return []
  }
}

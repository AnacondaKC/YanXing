/** 仅回传短中文业务文案；SQLite / 系统错误走 fallback，避免把内部细节交给浏览器。 */
export function publicErrorMessage(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback
  const message = error.message.trim()
  if (!message || message.length > 180) return fallback
  if (!/[\u4e00-\u9fff]/.test(message)) return fallback
  return message
}

export function logUnexpectedError(scope: string, error: unknown) {
  console.error(`[${scope}]`, error)
}

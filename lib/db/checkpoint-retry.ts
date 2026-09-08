export const CHECKPOINT_BUSY_MAX_ATTEMPTS = 3

export function isTransientSqliteBusyError(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const details = error as Record<string, unknown>
  const code = String(details.code ?? '')
  const message = error instanceof Error ? error.message : String(details.message ?? '')
  return code.includes('SQLITE_BUSY') || /SQLITE_BUSY|database is locked/i.test(message)
}

export async function retryOnSqliteBusy<T>(
  operation: () => T,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  for (let attempt = 0; attempt < CHECKPOINT_BUSY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return operation()
    } catch (error) {
      if (!isTransientSqliteBusyError(error) || attempt === CHECKPOINT_BUSY_MAX_ATTEMPTS - 1) throw error
      await waitForCheckpointRetry(attempt, options.signal)
    }
  }
  throw new Error('检查点重试已耗尽。')
}

export async function waitForCheckpointRetry(retry: number, signal?: AbortSignal) {
  const milliseconds = 25 * (retry + 1)
  if (signal?.aborted) throw cancelledError()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      reject(cancelledError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function cancelledError() {
  return new Error('Analysis cancelled')
}

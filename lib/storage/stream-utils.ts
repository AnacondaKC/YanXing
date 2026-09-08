export type UploadReader = ReadableStreamDefaultReader<Uint8Array>

export const storageUnavailableErrnos = new Set([
  'EACCES',
  'EDQUOT',
  'EIO',
  'EMFILE',
  'ENFILE',
  'ENOSPC',
  'EPERM',
  'EROFS',
])

export function cancelReader(reader: UploadReader, reason?: unknown) {
  try {
    void reader.cancel(reason).catch(() => undefined)
  } catch {
    // Cancellation is best effort and must never delay the primary error.
  }
}

export function releaseReaderLock(reader: UploadReader) {
  try {
    reader.releaseLock()
  } catch {
    // A pending read keeps the lock until the stream settles.
  }
}

export function errorCode(error: unknown, seen = new Set<object>()): string | undefined {
  if (!error || typeof error !== 'object' || seen.has(error)) return undefined
  seen.add(error)
  if ('code' in error && typeof error.code === 'string' && error.code) return error.code
  if ('cause' in error) return errorCode(error.cause, seen)
  return undefined
}

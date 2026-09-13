export const NATIVE_SCHEMA_ERROR_CODES = {
  LEGACY_DATABASE: 'LEGACY_DATABASE',
  INCOMPATIBLE_DATABASE: 'INCOMPATIBLE_DATABASE',
  IDENTITY_MISMATCH: 'IDENTITY_MISMATCH',
  STORAGE_ROOT_MISMATCH: 'STORAGE_ROOT_MISMATCH',
  RESTORE_INCOMPLETE: 'RESTORE_INCOMPLETE',
} as const

export type NativeSchemaErrorCode = typeof NATIVE_SCHEMA_ERROR_CODES[keyof typeof NATIVE_SCHEMA_ERROR_CODES]

export const NATIVE_SCHEMA_PUBLIC_MESSAGES: Record<NativeSchemaErrorCode, string> = {
  LEGACY_DATABASE: '当前数据库属于旧版报告结构，本版本不会迁移或改写它。请停止服务后使用全新空目录重新初始化。',
  INCOMPATIBLE_DATABASE: '当前数据库结构与本版本不匹配，本版本不会改写它。请停止服务后使用全新空目录重新初始化。',
  IDENTITY_MISMATCH: '当前数据库的原生结构标记与本版本不一致，本版本不会改写它。请停止服务后使用全新空目录重新初始化。',
  STORAGE_ROOT_MISMATCH: '当前数据库绑定的报告存储目录与本进程不一致，本版本不会改写它。',
  RESTORE_INCOMPLETE: '检测到未完成的原生恢复。当前进程拒绝打开或初始化数据库。请停止 Web 与 Worker，由操作者核对部分目标后手动清除恢复标记；进程不会自动删除该标记或部分目标。',
}

/** Fail-closed native bootstrap error. Message is public-safe: no filesystem paths, keys, or SQL. */
export class NativeSchemaError extends Error {
  readonly code: NativeSchemaErrorCode

  constructor(code: NativeSchemaErrorCode) {
    super(NATIVE_SCHEMA_PUBLIC_MESSAGES[code])
    this.name = 'NativeSchemaError'
    this.code = code
  }
}

export function isNativeSchemaError(error: unknown): error is NativeSchemaError {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown }
  if (candidate.name !== 'NativeSchemaError') return false
  if (typeof candidate.code !== 'string' || !isNativeSchemaErrorCode(candidate.code)) return false
  return candidate.message === NATIVE_SCHEMA_PUBLIC_MESSAGES[candidate.code]
}

export function isNativeSchemaErrorCode(code: string): code is NativeSchemaErrorCode {
  return Object.hasOwn(NATIVE_SCHEMA_PUBLIC_MESSAGES, code)
}

export function publicNativeSchemaFailure(error: NativeSchemaError) {
  return { error: error.message, code: error.code }
}

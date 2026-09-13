export const NATIVE_BACKUP_ERROR_CODES = {
  EXPLICIT_PATH_REQUIRED: 'EXPLICIT_PATH_REQUIRED',
  PATH_NOT_ABSOLUTE: 'PATH_NOT_ABSOLUTE',
  PATH_TRAVERSAL: 'PATH_TRAVERSAL',
  SYMLINK_REJECTED: 'SYMLINK_REJECTED',
  UNSUPPORTED_FILE_TYPE: 'UNSUPPORTED_FILE_TYPE',
  DESTINATION_EXISTS: 'DESTINATION_EXISTS',
  TARGET_OCCUPIED: 'TARGET_OCCUPIED',
  PATH_MISMATCH: 'PATH_MISMATCH',
  LAYOUT_INVALID: 'LAYOUT_INVALID',
  SOURCE_MISSING: 'SOURCE_MISSING',
  NOT_QUIESCENT: 'NOT_QUIESCENT',
  LOCK_UNAVAILABLE: 'LOCK_UNAVAILABLE',
  LEGACY_DATABASE: 'LEGACY_DATABASE',
  INCOMPATIBLE_DATABASE: 'INCOMPATIBLE_DATABASE',
  IDENTITY_MISMATCH: 'IDENTITY_MISMATCH',
  STORAGE_ROOT_MISMATCH: 'STORAGE_ROOT_MISMATCH',
  INTEGRITY_FAILED: 'INTEGRITY_FAILED',
  TAMPERED_ARCHIVE: 'TAMPERED_ARCHIVE',
  ARCHIVE_INVALID: 'ARCHIVE_INVALID',
  KEY_MISMATCH: 'KEY_MISMATCH',
  KEY_REQUIRED: 'KEY_REQUIRED',
  MASTER_KEY_FORBIDDEN: 'MASTER_KEY_FORBIDDEN',
  MISSING_FILE: 'MISSING_FILE',
  SOURCE_INTEGRITY: 'SOURCE_INTEGRITY',
  UNMANAGED_PATH: 'UNMANAGED_PATH',
  RESTORE_INCOMPLETE: 'RESTORE_INCOMPLETE',
} as const

export type NativeBackupErrorCode = typeof NATIVE_BACKUP_ERROR_CODES[keyof typeof NATIVE_BACKUP_ERROR_CODES]

export const NATIVE_BACKUP_PUBLIC_MESSAGES: Record<NativeBackupErrorCode, string> = {
  EXPLICIT_PATH_REQUIRED: '必须显式提供数据库路径、绑定的报告存储根和外部目标路径；不会使用当前进程默认数据库。',
  PATH_NOT_ABSOLUTE: '数据库、存储根、备份目标和密钥文件都必须是绝对路径。',
  PATH_TRAVERSAL: '路径包含相对段或空字节，已拒绝。',
  SYMLINK_REJECTED: '拒绝符号链接路径，避免备份或恢复逃出指定根目录。',
  UNSUPPORTED_FILE_TYPE: '存储树中存在非常规文件，已拒绝。',
  DESTINATION_EXISTS: '备份目标已存在，拒绝覆盖。',
  TARGET_OCCUPIED: '恢复目标路径已存在，拒绝覆盖或删除。',
  PATH_MISMATCH: '只能恢复到归档记录的原绝对运行路径，不会改写绑定存储根或文件身份。',
  LAYOUT_INVALID: '数据库必须位于运行根下，且 --storage-root 必须是该运行根下的 reports 目录。',
  SOURCE_MISSING: '源数据库或存储根不存在，无法备份。',
  NOT_QUIESCENT: '存在活动任务、未完成上传或配额预留，拒绝在线备份；请停止 Web/Worker 后再试。',
  LOCK_UNAVAILABLE: '无法获取 SQLite 写栅栏，请停止所有写入进程后重试。',
  LEGACY_DATABASE: '当前数据库属于旧版报告结构，本工具不会备份或改写它。',
  INCOMPATIBLE_DATABASE: '当前数据库结构与本版本不匹配，本工具不会备份或改写它。',
  IDENTITY_MISMATCH: '原生结构标记与本版本不一致，拒绝备份或恢复。',
  STORAGE_ROOT_MISMATCH: '绑定的报告存储目录与给定 --storage-root 不一致，拒绝继续。',
  INTEGRITY_FAILED: 'SQLite 完整性或外键检查失败，拒绝发布快照。',
  TAMPERED_ARCHIVE: '归档校验和不匹配或已被改动，拒绝恢复。',
  ARCHIVE_INVALID: '归档格式无效、含符号链接或含未登记文件，拒绝恢复。',
  KEY_MISMATCH: '提供的设置密钥无法解密归档或源库中的加密配置，或 HMAC 密钥校验失败；密钥不得写入归档。',
  KEY_REQUIRED: '备份和恢复都必须显式提供 YANXING_SETTINGS_ENCRYPTION_KEY 或 --key-file；不会读取隐式 .settings-key。',
  MASTER_KEY_FORBIDDEN: '拒绝使用位于运行根、归档或目标内的密钥文件，也拒绝将设置主密钥写入归档。',
  MISSING_FILE: '数据库引用的正式报告、墓碑报告或知识库文件缺失，拒绝备份。',
  SOURCE_INTEGRITY: '数据库记录的文件哈希或大小与磁盘文件不一致，拒绝备份或恢复。',
  UNMANAGED_PATH: '知识库路径不在本次运行根下的 knowledge 目录，或配置了外部 YANXING_KNOWLEDGE_STORAGE_ROOT，拒绝备份或恢复。',
  RESTORE_INCOMPLETE: '存在未完成的原生恢复标记，拒绝继续恢复或覆盖部分目标；请由操作者核对后手动清除标记，本工具不会自动删除。',
}

export class NativeBackupError extends Error {
  readonly code: NativeBackupErrorCode

  constructor(code: NativeBackupErrorCode, detail?: string) {
    super(detail ? NATIVE_BACKUP_PUBLIC_MESSAGES[code] + ' ' + detail : NATIVE_BACKUP_PUBLIC_MESSAGES[code])
    this.name = 'NativeBackupError'
    this.code = code
  }
}

export function isNativeBackupError(error: unknown): error is NativeBackupError {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; code?: unknown }
  return candidate.name === 'NativeBackupError' && typeof candidate.code === 'string' && Object.hasOwn(NATIVE_BACKUP_PUBLIC_MESSAGES, candidate.code)
}

import { pathToFileURL } from 'node:url'
import { loadYanXingEnv } from '../lib/config/load-env.mjs'
import { NativeBackupError, backupNativeRuntime, isNativeBackupError, restoreNativeRuntime } from '@/lib/storage/native-backup'

export const NATIVE_BACKUP_USAGE = [
  '用法:',
  '  backup  --database PATH --storage-root PATH --destination PATH [--key-file PATH]',
  '  restore --archive PATH --database PATH --storage-root PATH [--key-file PATH]',
  '',
  '安全约定:',
  '  必须显式给出数据库和绑定的 reports 绝对路径；不会使用进程默认数据库。',
  '  备份目标必须不存在，恢复目标必须不存在；拒绝覆盖、符号链接和相对路径。',
  '  必须提供 YANXING_SETTINGS_ENCRYPTION_KEY 或 --key-file；不会读取隐式 .settings-key。',
  '  --key-file 必须放在运行根、归档和目标之外单独保管；按原始字节读取，请用 printf 写入以免尾随换行（环境变量按 UTF-8）。',
  '  设置主密钥不得写入归档。清单始终 HMAC 认证；含加密配置时会实际解密校验密钥。',
  '  恢复前必须停止 Web 与 Worker，不得由本命令自动启动任何服务。',
  '  恢复成功后由操作者核对 RPO、绑定路径和模型供应商可用性，再手动启动。',
  '  未完成恢复会留下同级 .yanxing-restore-incomplete 标记；默认启动拒绝打开数据库，操作者核对后才能手动清除，进程不会自动删除部分目标。',
  '  Docker 的 /app/storage 作为挂载根通常已经存在，本工具会拒绝覆盖。请用维护容器把同一虚拟路径恢复到新的可写父目录绑定，使用发行包 /tools 中的 native-backup，再挂回重建后的 storage；不要增加空目标强制开关。',
].join('\n')

export async function runNativeBackupCli(argv: string[]) {
  try {
    loadYanXingEnv()
    const command = parseNativeBackupCli(argv)
    if (command.kind === 'help') {
      console.log(NATIVE_BACKUP_USAGE)
      return 0
    }
    if (command.kind === 'backup') {
      const result = await backupNativeRuntime(command.request)
      console.log(JSON.stringify({
        action: result.action,
        destination: result.destination,
        identity: result.manifest.identity,
        counts: result.manifest.counts,
        hasEncryptedSecrets: result.manifest.hasEncryptedSecrets,
        authenticationMode: result.manifest.authenticationMode,
      }, null, 2))
      return 0
    }
    const result = await restoreNativeRuntime(command.request)
    console.log(JSON.stringify({
      action: result.action,
      databasePath: result.databasePath,
      storageRoot: result.storageRoot,
      runtimeRoot: result.runtimeRoot,
      identity: result.manifest.identity,
      counts: result.manifest.counts,
    }, null, 2))
    return 0
  } catch (error) {
    return printFailure(error)
  }
}

const BACKUP_FLAGS = new Set(['database', 'storage-root', 'destination', 'key-file'])
const RESTORE_FLAGS = new Set(['archive', 'database', 'storage-root', 'key-file'])

export function parseNativeBackupCli(argv: string[]) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === 'help') return { kind: 'help' as const }
  const action = argv[0]
  if (action === 'backup') {
    const flags = readFlags(argv.slice(1), BACKUP_FLAGS)
    return {
      kind: 'backup' as const,
      request: {
        databasePath: requiredFlag(flags, 'database'),
        storageRoot: requiredFlag(flags, 'storage-root'),
        destination: requiredFlag(flags, 'destination'),
        keyFile: optionalFlag(flags, 'key-file'),
      },
    }
  }
  if (action === 'restore') {
    const flags = readFlags(argv.slice(1), RESTORE_FLAGS)
    return {
      kind: 'restore' as const,
      request: {
        archivePath: requiredFlag(flags, 'archive'),
        databasePath: requiredFlag(flags, 'database'),
        storageRoot: requiredFlag(flags, 'storage-root'),
        keyFile: optionalFlag(flags, 'key-file'),
      },
    }
  }
  throw new NativeBackupError('EXPLICIT_PATH_REQUIRED', action)
}

function readFlags(argv: string[], allowed: Set<string>) {
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!flag.startsWith('--') || flag === '--') throw new NativeBackupError('EXPLICIT_PATH_REQUIRED', flag)
    const name = flag.slice(2)
    if (!allowed.has(name) || flags.has(name)) throw new NativeBackupError('EXPLICIT_PATH_REQUIRED', flag)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--') || value.trim() === '') {
      throw new NativeBackupError('EXPLICIT_PATH_REQUIRED', flag)
    }
    flags.set(name, value)
    index += 1
  }
  return flags
}

function requiredFlag(flags: Map<string, string>, name: string) {
  const value = flags.get(name)?.trim()
  if (!value) throw new NativeBackupError('EXPLICIT_PATH_REQUIRED', name)
  return value
}

function optionalFlag(flags: Map<string, string>, name: string) {
  const value = flags.get(name)
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (!trimmed) throw new NativeBackupError('EXPLICIT_PATH_REQUIRED', name)
  return trimmed
}

function printFailure(error: unknown) {
  if (isNativeBackupError(error)) {
    console.error(error.message)
    return 1
  }
  console.error(error instanceof Error ? error.message : String(error))
  return 1
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void runNativeBackupCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}

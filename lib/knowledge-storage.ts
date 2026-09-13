import { constants } from 'node:fs'
import { open, realpath, type FileHandle } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { runtimeConfig } from '@/lib/config/environment'
import { isPathWithinRoot } from '@/lib/storage/path-containment'
import { getDefaultKnowledgeStorageRoot } from '@/lib/storage/runtime-roots'
import { errorCode } from '@/lib/storage/stream-utils'

const FILE_OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const missingErrnos = new Set(['ENOENT', 'ENOTDIR', 'ELOOP'])

export function getKnowledgeStorageRoot() {
  const configured = runtimeConfig.knowledgeStorageRoot
  return configured ? resolve(configured) : getDefaultKnowledgeStorageRoot()
}

export function isManagedKnowledgePath(sourcePath: string) {
  return isPathWithinRoot(getKnowledgeStorageRoot(), sourcePath)
}

export function getKnowledgeCleanupTarget(sourcePath: string) {
  if (!isManagedKnowledgePath(sourcePath)) return undefined
  const storageRoot = getKnowledgeStorageRoot()
  const directory = dirname(resolve(sourcePath))
  return dirname(directory) === storageRoot ? directory : undefined
}

export async function openManagedKnowledgeFile(sourcePath: string): Promise<
  { ok: true; handle: FileHandle; size: number } | { ok: false; status: 404 | 500 }
> {
  if (!isManagedKnowledgePath(sourcePath)) return { ok: false, status: 404 }
  let handle: FileHandle | undefined
  try {
    handle = await open(sourcePath, FILE_OPEN_FLAGS)
    const stats = await handle.stat()
    if (!stats.isFile()) {
      await handle.close()
      return { ok: false, status: 404 }
    }
    const realRoot = await realpath(getKnowledgeStorageRoot())
    const realFile = process.platform === 'linux'
      ? await realpath(`/proc/self/fd/${handle.fd}`)
      : await realpath(sourcePath)
    if (!isPathWithinRoot(realRoot, realFile)) {
      await handle.close()
      return { ok: false, status: 404 }
    }
    return { ok: true, handle, size: stats.size }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    const code = errorCode(error)
    if (code && missingErrnos.has(code)) return { ok: false, status: 404 }
    return { ok: false, status: 500 }
  }
}

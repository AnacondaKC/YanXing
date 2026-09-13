import { dirname, resolve } from 'node:path'
import { runtimeConfig } from '@/lib/config/environment'
import { isPathWithinRoot } from '@/lib/storage/path-containment'
import { getDefaultKnowledgeStorageRoot } from '@/lib/storage/runtime-roots'

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

import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Return true only for a non-root path lexically contained by a managed root. */
export function isPathWithinRoot(root: string, candidate: string) {
  const relativePath = relative(resolve(root), resolve(candidate))
  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith('..' + sep)
    && !isAbsolute(relativePath)
}

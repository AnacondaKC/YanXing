import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PARSER_WORKER_FILE_NAMES = {
  PDF: 'pdf-parser-worker.ts',
  DOCX: 'docx-parser-worker.ts',
} as const

export type ParserKind = keyof typeof PARSER_WORKER_FILE_NAMES

export interface ParserChildRuntime {
  workerPath: string
  tsxLoaderPath: string
}

export interface ParserChildRuntimeLookup {
  kind: ParserKind
  cwd?: string
  moduleUrl?: string
}

export class ParserChildRuntimeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ParserChildRuntimeError'
  }
}

export function resolveParserChildRuntime(lookup: ParserChildRuntimeLookup): ParserChildRuntime {
  const cwd = lookup.cwd ?? process.cwd()
  const moduleUrl = lookup.moduleUrl ?? import.meta.url
  const fileName = PARSER_WORKER_FILE_NAMES[lookup.kind]
  const workerPath = firstExistingPath(parserWorkerCandidates(fileName, cwd, moduleUrl))
  if (!workerPath) {
    throw new ParserChildRuntimeError(`无法定位 ${lookup.kind} 解析子进程脚本 ${fileName}。`)
  }
  return {
    workerPath,
    tsxLoaderPath: resolveTsxEsmLoader(cwd, moduleUrl),
  }
}

function parserWorkerCandidates(fileName: string, cwd: string, moduleUrl: string) {
  return uniqueResolvedPaths([
    path.join(cwd, 'lib', 'documents', fileName),
    moduleFilePath(moduleUrl, fileName),
  ])
}

function resolveTsxEsmLoader(cwd: string, moduleUrl: string) {
  const failures: string[] = []
  for (const parent of tsxRequireParents(cwd, moduleUrl)) {
    try {
      return createRequire(parent).resolve('tsx/esm')
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  const detail = failures[0] ? ` ${failures[0]}` : ''
  throw new ParserChildRuntimeError(`无法解析 tsx/esm 加载器。${detail}`)
}

function tsxRequireParents(cwd: string, moduleUrl: string) {
  return uniqueResolvedPaths([
    path.join(cwd, 'package.json'),
    moduleFilePath(moduleUrl),
    moduleFilePath(import.meta.url),
  ])
}

function moduleFilePath(moduleUrl: string, childName?: string) {
  if (!moduleUrl.startsWith('file:')) return undefined
  try {
    const modulePath = fileURLToPath(moduleUrl)
    return childName ? path.join(path.dirname(modulePath), childName) : modulePath
  } catch {
    return undefined
  }
}

function firstExistingPath(candidates: string[]) {
  return candidates.find((candidate) => existsSync(candidate))
}

function uniqueResolvedPaths(candidates: Array<string | undefined>) {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const candidate of candidates) {
    if (!candidate) continue
    const resolved = path.resolve(candidate)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    paths.push(resolved)
  }
  return paths
}

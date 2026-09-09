import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const COMPILED_RUNTIME_ENV_NAME = 'YANXING_COMPILED_RUNTIME'
export const COMPILED_RUNTIME_ENV_VALUE = '1'
export const COMPILED_RUNTIME_DIR_NAME = '.runtime'

export const PARSER_WORKER_FILE_NAMES = {
  PDF: 'pdf-parser-worker.ts',
  DOCX: 'docx-parser-worker.ts',
}

export const PARSER_WORKER_COMPILED_FILE_NAMES = {
  PDF: 'pdf-parser-worker.mjs',
  DOCX: 'docx-parser-worker.mjs',
}

export class ParserChildRuntimeError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'ParserChildRuntimeError'
  }
}

export function isCompiledRuntimeEnabled(env = process.env) {
  return env[COMPILED_RUNTIME_ENV_NAME] === COMPILED_RUNTIME_ENV_VALUE
}

export function resolveParserChildRuntime(lookup) {
  const cwd = lookup.cwd ?? process.cwd()
  const env = lookup.env ?? process.env
  if (isCompiledRuntimeEnabled(env)) {
    return resolveCompiledParserChildRuntime(lookup.kind, cwd)
  }
  return resolveSourceParserChildRuntime(lookup.kind, cwd, lookup.moduleUrl ?? import.meta.url)
}

export function parserChildSpawnArguments(runtime, memoryMb, filePath) {
  const arguments_ = [`--max-old-space-size=${memoryMb}`]
  if (runtime.tsxLoaderPath) {
    arguments_.push('--import', runtime.tsxLoaderPath)
  }
  arguments_.push(runtime.workerPath, filePath)
  return arguments_
}

function resolveCompiledParserChildRuntime(kind, cwd) {
  const fileName = PARSER_WORKER_COMPILED_FILE_NAMES[kind]
  const workerPath = firstExistingPath([
    path.join(cwd, COMPILED_RUNTIME_DIR_NAME, 'lib', 'documents', fileName),
  ])
  if (!workerPath) {
    throw new ParserChildRuntimeError(`无法定位 ${kind} 解析子进程脚本 ${fileName}。`)
  }
  return { workerPath }
}

function resolveSourceParserChildRuntime(kind, cwd, moduleUrl) {
  const fileName = PARSER_WORKER_FILE_NAMES[kind]
  const workerPath = firstExistingPath(parserWorkerCandidates(fileName, cwd, moduleUrl))
  if (!workerPath) {
    throw new ParserChildRuntimeError(`无法定位 ${kind} 解析子进程脚本 ${fileName}。`)
  }
  return {
    workerPath,
    tsxLoaderPath: resolveTsxEsmLoader(cwd, moduleUrl),
  }
}

function parserWorkerCandidates(fileName, cwd, moduleUrl) {
  return uniqueResolvedPaths([
    path.join(cwd, 'lib', 'documents', fileName),
    moduleFilePath(moduleUrl, fileName),
  ])
}

function resolveTsxEsmLoader(cwd, moduleUrl) {
  const failures = []
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

function tsxRequireParents(cwd, moduleUrl) {
  return uniqueResolvedPaths([
    path.join(cwd, 'package.json'),
    moduleFilePath(moduleUrl),
    moduleFilePath(import.meta.url),
  ])
}

function moduleFilePath(moduleUrl, childName) {
  if (!moduleUrl.startsWith('file:')) return undefined
  try {
    const modulePath = fileURLToPath(moduleUrl)
    return childName ? path.join(path.dirname(modulePath), childName) : modulePath
  } catch {
    return undefined
  }
}

function firstExistingPath(candidates) {
  return candidates.find((candidate) => existsSync(candidate))
}

function uniqueResolvedPaths(candidates) {
  const seen = new Set()
  const paths = []
  for (const candidate of candidates) {
    if (!candidate) continue
    const resolved = path.resolve(candidate)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    paths.push(resolved)
  }
  return paths
}

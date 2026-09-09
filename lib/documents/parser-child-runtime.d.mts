export const COMPILED_RUNTIME_ENV_NAME: 'YANXING_COMPILED_RUNTIME'
export const COMPILED_RUNTIME_ENV_VALUE: '1'
export const COMPILED_RUNTIME_DIR_NAME: '.runtime'

export const PARSER_WORKER_FILE_NAMES: {
  readonly PDF: 'pdf-parser-worker.ts'
  readonly DOCX: 'docx-parser-worker.ts'
}

export const PARSER_WORKER_COMPILED_FILE_NAMES: {
  readonly PDF: 'pdf-parser-worker.mjs'
  readonly DOCX: 'docx-parser-worker.mjs'
}

export type ParserKind = keyof typeof PARSER_WORKER_FILE_NAMES
export type RuntimeProcessEnv = Readonly<Record<string, string | undefined>>

export interface ParserChildRuntime {
  workerPath: string
  tsxLoaderPath?: string
}

export interface ParserChildRuntimeLookup {
  kind: ParserKind
  cwd?: string
  moduleUrl?: string
  env?: RuntimeProcessEnv
}

export class ParserChildRuntimeError extends Error {
  constructor(message: string, options?: { cause?: unknown })
}

export function isCompiledRuntimeEnabled(env?: RuntimeProcessEnv): boolean
export function resolveParserChildRuntime(lookup: ParserChildRuntimeLookup): ParserChildRuntime
export function parserChildSpawnArguments(
  runtime: ParserChildRuntime,
  memoryMb: number,
  filePath: string,
): string[]

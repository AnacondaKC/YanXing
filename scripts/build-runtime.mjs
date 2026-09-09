import { createRequire } from 'node:module'
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { COMPILED_RUNTIME_DIR_NAME } from '../lib/documents/parser-child-runtime.mjs'

const require = createRequire(import.meta.url)
const { nodeFileTrace } = require('next/dist/compiled/@vercel/nft')

export const RUNTIME_OUTPUT_DIR_NAME = COMPILED_RUNTIME_DIR_NAME
export const RUNTIME_MANIFEST_FILE_NAME = 'runtime.nft.json'
export const RUNTIME_MANIFEST_VERSION = 1
export const NEXT_ENV_PACKAGE_NAME = '@next/env'
export const CANVAS_PACKAGE_NAME = '@napi-rs/canvas'
export const COMPILED_RUNTIME_ENTRY_SOURCES = [
  'worker/index.ts',
  'scripts/migrate.ts',
  'scripts/create-user.ts',
  'scripts/storage-maintenance.ts',
  'scripts/relocate-storage.ts',
  'lib/documents/pdf-parser-worker.ts',
  'lib/documents/docx-parser-worker.ts',
]
export const EXTRA_TRACE_ENTRY_PATHS = [
  'scripts/docker-runtime-config.mjs',
  'scripts/docker-healthcheck.mjs',
  'scripts/docker-supervisor.mjs',
  'scripts/deployment-smoke.mjs',
  'lib/documents/parser-child-runtime.mjs',
  'lib/config/load-env.mjs',
]
export const PDFJS_RESOURCE_DIRECTORY_NAMES = ['cmaps', 'standard_fonts', 'wasm']
export const IGNORED_TRACE_PACKAGE_NAMES = ['tsx', 'esbuild', 'typescript']
export const IGNORED_TRACE_PNPM_PREFIXES = ['tsx@', 'esbuild@', 'typescript@', '@esbuild+']

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

export async function buildYanXingRuntime(root = projectRoot) {
  const runtimeDir = path.join(root, RUNTIME_OUTPUT_DIR_NAME)
  await rm(runtimeDir, { recursive: true, force: true })
  await mkdir(runtimeDir, { recursive: true })
  await bundleCompiledEntries(root, runtimeDir)
  const compiledOutputs = COMPILED_RUNTIME_ENTRY_SOURCES.map((source) => compiledOutputPath(root, source))
  for (const compiledOutput of compiledOutputs) {
    if (!existsSync(compiledOutput)) {
      throw new Error(`esbuild 未写出编译入口：${toProjectRelativePosix(root, compiledOutput)}`)
    }
  }
  const files = await traceRuntimeFiles(root, compiledOutputs)
  assertNoPrivateTraceFiles(files)
  const manifestPath = path.join(runtimeDir, RUNTIME_MANIFEST_FILE_NAME)
  const manifest = {
    version: RUNTIME_MANIFEST_VERSION,
    base: '.',
    files,
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { runtimeDir, manifestPath, files, compiledOutputs }
}

export function shouldIgnoreTracedFile(relativePath) {
  const posix = toPosix(relativePath)
  if (isPrivateTracePath(posix)) return true
  if (posix.startsWith('.git/')) return true
  return isIgnoredCompilerPackage(posix)
}

export function isPrivateTracePath(relativePath) {
  const posix = toPosix(relativePath)
  if (posix === 'storage' || posix.startsWith('storage/')) return true
  if (posix === '.env' || posix.startsWith('.env.')) return true
  const baseName = posix.slice(posix.lastIndexOf('/') + 1)
  const atProjectRoot = !posix.includes('/')
  if ((atProjectRoot || posix.startsWith('storage/')) && /\.sqlite(?:-shm|-wal)?$/.test(baseName)) return true
  return false
}

function compiledOutputPath(root, source) {
  const parsed = path.parse(source)
  return path.join(root, RUNTIME_OUTPUT_DIR_NAME, parsed.dir, `${parsed.name}.mjs`)
}

async function bundleCompiledEntries(root, runtimeDir) {
  await build({
    absWorkingDir: root,
    alias: { '@': root },
    bundle: true,
    entryPoints: COMPILED_RUNTIME_ENTRY_SOURCES,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    packages: 'external',
    outdir: runtimeDir,
    outbase: root,
    outExtension: { '.js': '.mjs' },
    sourcemap: false,
    minify: false,
    legalComments: 'inline',
    logLevel: 'warning',
  })
}

async function traceRuntimeFiles(root, compiledOutputs) {
  const extraEntries = EXTRA_TRACE_ENTRY_PATHS.map((relativePath) => path.join(root, relativePath))
  const busboyPath = require.resolve('next/dist/compiled/busboy/index.js')
  const pdfjsResources = resolvePdfjsResourceFiles()
  const packageAnchors = collectRuntimePackageAnchors(root)
  const entries = uniqueAbsolutePaths([
    ...compiledOutputs,
    ...extraEntries,
    busboyPath,
    ...pdfjsResources,
    ...packageAnchors.traceEntries,
  ])
  const { fileList, esmFileList } = await nodeFileTrace(entries, {
    base: root,
    processCwd: root,
    mixedModules: true,
    ignore: (file) => shouldIgnoreTracedFile(file),
  })
  const files = new Set()
  for (const file of [...fileList, ...esmFileList]) {
    const relative = toProjectRelativePosix(root, path.isAbsolute(file) ? file : path.join(root, file))
    if (!relative || relative.startsWith('../') || shouldIgnoreTracedFile(relative)) continue
    files.add(relative)
  }
  for (const absolutePath of [...entries, ...packageAnchors.files]) {
    addForcedTraceFile(files, root, absolutePath)
  }
  return [...files].sort()
}

// NFT cannot discover every createRequire alias or PDF.js process.getBuiltinModule call.
// Keep their package entrypoints, resolver links and installed native payloads explicitly.
function collectRuntimePackageAnchors(root) {
  const loadEnvPath = path.join(root, 'lib/config/load-env.mjs')
  const pdfParseEntry = require.resolve('pdf-parse')
  const pdfjsPackage = createRequire(pdfParseEntry).resolve('pdfjs-dist/package.json')
  const nextEnv = collectPackageAnchor({ packageName: NEXT_ENV_PACKAGE_NAME, fromFile: loadEnvPath })
  const canvasFromPdfjs = collectPackageAnchor({ packageName: CANVAS_PACKAGE_NAME, fromFile: pdfjsPackage })
  const canvasFromPdfParse = collectPackageAnchor({ packageName: CANVAS_PACKAGE_NAME, fromFile: pdfParseEntry })
  return {
    traceEntries: uniqueAbsolutePaths([...nextEnv.traceEntries, ...canvasFromPdfjs.traceEntries, ...canvasFromPdfParse.traceEntries]),
    files: uniqueAbsolutePaths([...nextEnv.files, ...canvasFromPdfjs.files, ...canvasFromPdfParse.files]),
  }
}

function collectPackageAnchor({ packageName, fromFile }) {
  const resolver = createRequire(fromFile)
  const packageJsonPath = resolver.resolve(`${packageName}/package.json`)
  const entryPath = resolver.resolve(packageName)
  const visibleRoot = findVisiblePackagePath(fromFile, packageName)
  const files = uniqueAbsolutePaths([
    packageJsonPath,
    entryPath,
    ...(visibleRoot && lstatSync(visibleRoot).isSymbolicLink() ? [visibleRoot] : []),
    ...listFilesRecursive(realpathSync(path.dirname(packageJsonPath))),
    ...listScopedNativeSiblings(path.dirname(realpathSync(packageJsonPath))),
  ])
  const traceEntries = [entryPath]
  if (visibleRoot) {
    const visibleEntry = path.join(visibleRoot, path.relative(realpathSync(path.dirname(packageJsonPath)), entryPath))
    if (existsSync(visibleEntry)) traceEntries.push(visibleEntry)
  }
  return { files, traceEntries }
}

function findVisiblePackagePath(fromFile, packageName) {
  const parts = packageName.split('/')
  let directory = path.dirname(fromFile)
  while (true) {
    const candidate = path.join(directory, 'node_modules', ...parts)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

function listScopedNativeSiblings(packageRoot) {
  const scopeDir = path.dirname(packageRoot)
  if (!path.basename(scopeDir).startsWith('@')) return []
  const files = []
  for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
    const fullPath = path.join(scopeDir, entry.name)
    if (entry.isSymbolicLink() || entry.isFile()) files.push(fullPath)
    const realPath = realpathSync(fullPath)
    if (lstatSync(realPath).isDirectory()) files.push(...listFilesRecursive(realPath))
    else files.push(realPath)
  }
  return files
}

function resolvePdfjsResourceFiles() {
  const pdfjsRequire = createRequire(require.resolve('pdf-parse'))
  const workerPath = pdfjsRequire.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
  const packagePath = pdfjsRequire.resolve('pdfjs-dist/package.json')
  const pdfjsRoot = path.dirname(packagePath)
  const files = [workerPath, packagePath]
  for (const directoryName of PDFJS_RESOURCE_DIRECTORY_NAMES) {
    const directory = path.join(pdfjsRoot, directoryName)
    if (!existsSync(directory)) {
      throw new Error(`pdfjs-dist 缺少 ${directoryName} 资源目录：${directory}`)
    }
    files.push(...listFilesRecursive(directory))
  }
  return files
}

function listFilesRecursive(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listFilesRecursive(fullPath))
    else if (entry.isFile() || entry.isSymbolicLink()) files.push(fullPath)
  }
  return files
}

function addForcedTraceFile(files, root, absolutePath) {
  const relative = toProjectRelativePosix(root, absolutePath)
  if (!relative || relative.startsWith('../')) {
    throw new Error(`运行时追踪入口位于仓库外：${absolutePath}`)
  }
  if (isPrivateTracePath(relative)) {
    throw new Error(`运行时追踪入口命中私有路径：${relative}`)
  }
  if (lstatSync(absolutePath).isDirectory()) {
    throw new Error(`运行时追踪不能包含目录：${relative}`)
  }
  files.add(relative)
}

function uniqueAbsolutePaths(paths) {
  const seen = new Set()
  const unique = []
  for (const absolutePath of paths) {
    const resolved = path.resolve(absolutePath)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    unique.push(resolved)
  }
  return unique
}

function isIgnoredCompilerPackage(posixPath) {
  const segments = posixPath.split('/')
  const nodeModulesIndex = segments.lastIndexOf('node_modules')
  if (nodeModulesIndex < 0) return false
  const packageName = segments[nodeModulesIndex + 1] ?? ''
  if (IGNORED_TRACE_PACKAGE_NAMES.includes(packageName) || packageName.startsWith('@esbuild')) return true
  if (packageName !== '.pnpm') return false
  const virtualName = segments[nodeModulesIndex + 2] ?? ''
  return IGNORED_TRACE_PNPM_PREFIXES.some((prefix) => virtualName.startsWith(prefix))
}

function assertNoPrivateTraceFiles(files) {
  const privateFiles = files.filter((file) => isPrivateTracePath(file))
  if (privateFiles.length === 0) return
  throw new Error(`runtime nft 包含私有路径：${privateFiles.join(', ')}`)
}

function toProjectRelativePosix(root, absolutePath) {
  return toPosix(path.relative(root, absolutePath))
}

function toPosix(filePath) {
  return filePath.replaceAll('\\', '/')
}

function isMainModule() {
  return Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
}

if (isMainModule()) {
  try {
    const result = await buildYanXingRuntime()
    console.log(`[build-runtime] wrote ${toPosix(path.relative(projectRoot, result.manifestPath))} (${result.files.length} files)`)
    for (const compiledOutput of result.compiledOutputs) {
      console.log(`[build-runtime] ${toPosix(path.relative(projectRoot, compiledOutput))}`)
    }
  } catch (error) {
    console.error('[build-runtime]', error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

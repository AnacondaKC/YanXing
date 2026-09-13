import { existsSync, globSync, lstatSync, readlinkSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseReportMaxUploadBytes, reportMaxUploadBytes } from '../lib/upload-limits.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
export const DEFAULT_DOCKER_RUNTIME_DIR_NAME = '.docker-runtime'
export const DEFAULT_NEXT_DIST_DIR_NAME = '.next'
export const DOCKER_BUILD_CONFIG_FILE_NAME = '.docker-build.json'
export const STANDALONE_OUTPUT_DIR_NAME = 'standalone'
export const STATIC_ASSETS_DIR_NAME = 'static'
const runtimeTraceManifest = '.runtime/runtime.nft.json'
const publicDirectoryName = 'public'
const liveVolumeDirectoryName = 'yanxing_data'
const privateEnvPattern = /^\.env(?:$|\.)/
const runtimeFiles = [
  'LICENSE',
  'scripts/docker-entrypoint.sh',
  'scripts/docker-supervisor.mjs',
  'scripts/docker-runtime-config.mjs',
  'scripts/docker-healthcheck.mjs',
  'scripts/docker-security-smoke.mjs',
  'scripts/deployment-smoke.mjs',
  'scripts/deployment-fixtures.mjs',
  'lib/upload-limits.mjs',
]
const licensePattern = 'node_modules/.pnpm/**/{LICENSE*,license*,NOTICE*,notice*,COPYING*,copying*}'
const forbiddenIsolatedRoots = ['.git', 'storage', 'storage-native', 'test']

export function resolveTracePath(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error('Runtime trace must contain relative file paths')
  }
  const resolved = path.resolve(root, relativePath)
  const relative = path.relative(root, resolved)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Runtime trace escapes the project: ${relativePath}`)
  }
  return resolved
}

export function isPrivateRuntimePath(relativePath) {
  const segments = relativePath.split(path.sep)
  if (segments[0] === 'storage' || segments[0] === 'storage-native' || segments[0] === 'test') return true
  return segments.some((segment) => segment === '.git' || privateEnvPattern.test(segment))
}

export function computeDockerBuildConfig(environment = process.env) {
  return {
    reportMaxUploadBytes: parseReportMaxUploadBytes(environment.REPORT_MAX_UPLOAD_BYTES, reportMaxUploadBytes),
  }
}

export function resolveAssemblyDestination(root, destination) {
  if (typeof destination !== 'string' || destination.trim() === '') {
    throw new Error('Assembly destination must be a non-empty path')
  }
  return path.isAbsolute(destination) ? path.resolve(destination) : path.resolve(root, destination)
}

export function assertSafeIsolatedDestination(root, destination) {
  const resolvedRoot = path.resolve(root)
  const resolvedDestination = resolveAssemblyDestination(resolvedRoot, destination)
  const liveRuntime = path.join(resolvedRoot, DEFAULT_DOCKER_RUNTIME_DIR_NAME)
  if (isSameOrInside(liveRuntime, resolvedDestination)) {
    throw new Error('Isolated assembly refuses the live Docker runtime destination')
  }
  if (resolvedDestination === resolvedRoot) {
    throw new Error('Isolated assembly refuses the project root')
  }
  if (isSameOrInside(resolvedDestination, resolvedRoot) && resolvedDestination !== resolvedRoot) {
    throw new Error('Isolated assembly refuses a destination that contains the project')
  }
  for (const relative of forbiddenIsolatedRoots) {
    if (isSameOrInside(path.join(resolvedRoot, relative), resolvedDestination)) {
      throw new Error(`Isolated assembly refuses ${relative} as a destination`)
    }
  }
  if (resolvedDestination.split(path.sep).includes(liveVolumeDirectoryName)) {
    throw new Error('Isolated assembly refuses existing Docker volume paths')
  }
  return resolvedDestination
}

export function assertFreshIsolatedDestination(root, destination) {
  const resolvedDestination = assertSafeIsolatedDestination(root, destination)
  if (existsSync(resolvedDestination)) {
    throw new Error('Isolated assembly refuses to overwrite an existing destination')
  }
  return resolvedDestination
}

export async function assembleDockerRuntime(root = projectRoot, options = {}) {
  const nextDistDir = resolveNextDistDirName(options.nextDistDir ?? DEFAULT_NEXT_DIST_DIR_NAME)
  const destination = options.destination
    ? resolveAssemblyDestination(root, options.destination)
    : path.join(path.resolve(root), DEFAULT_DOCKER_RUNTIME_DIR_NAME)
  await writeAssembledRuntime({
    root: path.resolve(root),
    destination,
    nextDistDir,
    buildConfig: options.buildConfig,
  })
  console.log(`Assembled Docker runtime: ${destination}`)
  return { destination, nextDistDir }
}

export async function assembleIsolatedDockerRuntime({
  root = projectRoot,
  destination,
  nextDistDir = DEFAULT_NEXT_DIST_DIR_NAME,
  buildConfig,
  environment = process.env,
} = {}) {
  const resolvedRoot = path.resolve(root)
  const resolvedDestination = assertFreshIsolatedDestination(resolvedRoot, destination)
  return assembleDockerRuntime(resolvedRoot, {
    destination: resolvedDestination,
    nextDistDir,
    buildConfig: buildConfig ?? computeDockerBuildConfig(environment),
  })
}

function resolveNextDistDirName(nextDistDir) {
  if (typeof nextDistDir !== 'string' || nextDistDir.trim() === '') {
    throw new Error('Next distDir must be a relative directory name')
  }
  if (path.isAbsolute(nextDistDir)) {
    throw new Error('Next distDir must be a relative directory name')
  }
  const normalized = path.normalize(nextDistDir)
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized)) {
    throw new Error(`Next distDir escapes the project: ${nextDistDir}`)
  }
  return normalized
}

async function writeAssembledRuntime({ root, destination, nextDistDir, buildConfig }) {
  const nextDirectory = path.join(root, nextDistDir)
  const standalone = path.join(nextDirectory, STANDALONE_OUTPUT_DIR_NAME)
  const staticAssets = path.join(nextDirectory, STATIC_ASSETS_DIR_NAME)
  const trace = JSON.parse(await readFile(path.join(root, runtimeTraceManifest), 'utf8'))
  if (trace.version !== 1 || !Array.isArray(trace.files)) throw new Error('Invalid runtime trace manifest')
  for (const relativePath of trace.files) {
    const source = resolveTracePath(root, relativePath)
    if (isPrivateRuntimePath(path.relative(root, source))) {
      throw new Error(`Private data found in runtime trace: ${relativePath}`)
    }
    await assertSymlinkStaysInside(root, source, `Runtime file symlink escapes the project: ${relativePath}`)
  }
  if (!existsSync(standalone)) {
    throw new Error(`Standalone output is missing: ${path.join(nextDistDir, STANDALONE_OUTPUT_DIR_NAME)}`)
  }
  if (!existsSync(staticAssets)) {
    throw new Error(`Static assets are missing: ${path.join(nextDistDir, STATIC_ASSETS_DIR_NAME)}`)
  }

  await rm(destination, { recursive: true, force: true })
  await cp(standalone, destination, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    filter: (source) => allowStandaloneEntry(root, standalone, source),
  })
  for (const relativePath of new Set([...trace.files, ...runtimeFiles])) {
    await copyProjectFile({ root, destination, relativePath })
  }
  await cp(staticAssets, path.join(destination, nextDistDir, STATIC_ASSETS_DIR_NAME), { recursive: true })
  await cp(path.join(root, publicDirectoryName), path.join(destination, publicDirectoryName), { recursive: true })
  await preserveLicenses({ root, destination })
  await rm(path.join(destination, path.join(DEFAULT_NEXT_DIST_DIR_NAME, 'cache')), { recursive: true, force: true })
  await rm(path.join(destination, nextDistDir, 'cache'), { recursive: true, force: true })
  await writeDestinationBuildConfig({ root, destination, buildConfig })
}

function allowStandaloneEntry(root, standalone, source) {
  const relative = path.relative(standalone, source)
  if (!relative) return true
  if (isPrivateRuntimePath(relative)) return false
  const stats = lstatSync(source)
  if (stats.isSymbolicLink()) {
    const target = path.resolve(path.dirname(source), readlinkSync(source))
    if (escapesDirectory(root, target)) {
      throw new Error(`Standalone symlink escapes the project: ${relative}`)
    }
  }
  return true
}

async function copyProjectFile({ root, destination, relativePath }) {
  const source = resolveTracePath(root, relativePath)
  const target = resolveTracePath(destination, relativePath)
  const stats = await lstat(source)
  if (stats.isDirectory()) throw new Error(`Runtime trace contains a directory: ${relativePath}`)
  await assertSymlinkStaysInside(root, source, `Runtime file symlink escapes the project: ${relativePath}`)
  await mkdir(path.dirname(target), { recursive: true })
  await cp(source, target, { dereference: false, verbatimSymlinks: true, force: true })
}

async function writeDestinationBuildConfig({ root, destination, buildConfig }) {
  const target = path.join(destination, DOCKER_BUILD_CONFIG_FILE_NAME)
  if (buildConfig) {
    await writeFile(target, JSON.stringify(buildConfig) + '\n')
    return
  }
  await copyProjectFile({ root, destination, relativePath: DOCKER_BUILD_CONFIG_FILE_NAME })
}

async function preserveLicenses({ root, destination }) {
  for (const relativePath of globSync(licensePattern, { cwd: root })) {
    const source = path.join(root, relativePath)
    if (!(await lstat(source)).isFile()) continue
    const target = path.join(destination, 'third-party-licenses', relativePath)
    await mkdir(path.dirname(target), { recursive: true })
    await cp(source, target)
  }
}

async function assertSymlinkStaysInside(root, source, message) {
  const stats = await lstat(source)
  if (!stats.isSymbolicLink()) return
  const target = path.resolve(path.dirname(source), await readlink(source))
  if (escapesDirectory(root, target)) throw new Error(message)
}

function isSameOrInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function escapesDirectory(root, resolved) {
  const relative = path.relative(root, resolved)
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await assembleDockerRuntime()
}

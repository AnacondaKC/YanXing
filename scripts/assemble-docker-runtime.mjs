import { globSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const runtimeFiles = [
  'LICENSE',
  '.docker-build.json',
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
  return segments[0] === 'storage' || segments.some((segment) => segment === '.git' || /^\.env(?:$|\.)/.test(segment))
}

async function copyProjectFile({ root, destination, relativePath }) {
  const source = resolveTracePath(root, relativePath)
  const target = resolveTracePath(destination, relativePath)
  const stats = await lstat(source)
  if (stats.isDirectory()) throw new Error(`Runtime trace contains a directory: ${relativePath}`)
  await mkdir(path.dirname(target), { recursive: true })
  await cp(source, target, { dereference: false, verbatimSymlinks: true, force: true })
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

export async function assembleDockerRuntime(root = projectRoot) {
  const destination = path.join(root, '.docker-runtime')
  const nextDirectory = path.join(root, '.next')
  const trace = JSON.parse(await readFile(path.join(root, '.runtime/runtime.nft.json'), 'utf8'))
  if (trace.version !== 1 || !Array.isArray(trace.files)) throw new Error('Invalid runtime trace manifest')
  for (const relativePath of trace.files) {
    const source = resolveTracePath(root, relativePath)
    if (isPrivateRuntimePath(path.relative(root, source))) {
      throw new Error(`Private data found in runtime trace: ${relativePath}`)
    }
  }

  await rm(destination, { recursive: true, force: true })
  const standalone = path.join(nextDirectory, 'standalone')
  await cp(standalone, destination, {
    recursive: true, dereference: false, verbatimSymlinks: true,
    filter: (source) => !isPrivateRuntimePath(path.relative(standalone, source)),
  })
  for (const relativePath of new Set([...trace.files, ...runtimeFiles])) {
    await copyProjectFile({ root, destination, relativePath })
  }
  await cp(path.join(nextDirectory, 'static'), path.join(destination, '.next/static'), { recursive: true })
  await cp(path.join(root, 'public'), path.join(destination, 'public'), { recursive: true })
  await preserveLicenses({ root, destination })
  await rm(path.join(destination, '.next/cache'), { recursive: true, force: true })
  console.log(`Assembled Docker runtime: ${destination}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await assembleDockerRuntime()
}

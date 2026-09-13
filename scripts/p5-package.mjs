import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readlinkSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  assembleIsolatedDockerRuntime,
  computeDockerBuildConfig,
} from './assemble-docker-runtime.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))

export const P5_NEXT_DIST_DIR = '.next-p5-qa'
export const P5_CANDIDATE_DIR_NAME = 'p5-docker-candidate'
export const P5_DEFAULT_NODE_IMAGE = 'node:24.20.0-bookworm-slim'
export const P5_ISOLATED_IMAGE_REPOSITORY = 'yanxing'
export const P5_ISOLATED_IMAGE_TAG = 'p5-qa-isolated'
export const P5_ISOLATED_IMAGE = `${P5_ISOLATED_IMAGE_REPOSITORY}:${P5_ISOLATED_IMAGE_TAG}`
export const P5_CANDIDATE_DOCKERFILE_NAME = 'Dockerfile'
export const P5_CANDIDATE_MANIFEST_NAME = 'p5-candidate-manifest.json'
export const P5_PACKAGE_HELP = "Usage: node scripts/p5-package.mjs --destination /absolute/new/path [options]\n\nAssemble an isolated P5 Docker release candidate. Does not overwrite an existing\ndestination (including an empty directory) and does not touch .docker-runtime.\n\n  --destination <path>    Absolute path to a new directory that must not exist\n  --next-dist-dir <dir>   Next distDir (default: .next-p5-qa)\n  --node-image <image>    Base image (default: node:24.20.0-bookworm-slim)\n  --help, -h              Show this help\n"

export function defaultP5CandidateRoot(root = projectRoot) {
  return path.join(path.resolve(root), 'out', P5_CANDIDATE_DIR_NAME)
}

export function parseP5PackageArguments(argv) {
  const options = { help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--destination' || arg === '--next-dist-dir' || arg === '--node-image') {
      const value = argv[index + 1]
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
        throw new Error(arg + ' requires a value')
      }
      index += 1
      if (arg === '--destination') options.destination = value
      if (arg === '--next-dist-dir') options.nextDistDir = value
      if (arg === '--node-image') options.nodeImage = value
      continue
    }
    throw new Error('Unknown argument: ' + arg)
  }
  if (options.help) return options
  if (typeof options.destination !== 'string' || options.destination.length === 0) {
    throw new Error('--destination is required and must be an absolute new path')
  }
  if (!path.isAbsolute(options.destination)) {
    throw new Error('--destination must be an absolute new path')
  }
  return options
}

export function renderP5CandidateDockerfile({
  nodeImage = P5_DEFAULT_NODE_IMAGE,
  nextDistDir = P5_NEXT_DIST_DIR,
} = {}) {
  const imageArg = '${NODE_IMAGE}'
  return [
    '# syntax=docker/dockerfile:1.7',
    '# Isolated P5 acceptance candidate. Not a production cutover image.',
    'ARG NODE_IMAGE=' + nodeImage,
    '',
    'FROM ' + imageArg + ' AS runtime',
    'WORKDIR /app',
    'ENV NODE_ENV=production \\',
    '    YANXING_COMPILED_RUNTIME=1 \\',
    '    NEXT_TELEMETRY_DISABLED=1 \\',
    '    PORT=3000 \\',
    '    YANXING_NEXT_DIST_DIR=' + nextDistDir + ' \\',
    '    YANXING_WORKER_HEARTBEAT_PATH=/tmp/yanxing-worker-heartbeat.json \\',
    '    YANXING_DATABASE_PATH=/app/storage/yanxing.sqlite \\',
    '    YANXING_KNOWLEDGE_STORAGE_ROOT=/app/storage/knowledge',
    'COPY --chown=root:root . ./',
    'RUN chmod -R a=rX /app \\',
    '    && chmod 0555 /app/scripts/docker-entrypoint.sh \\',
    '    && install -d -m 0700 -o node -g node /app/storage /app/' + nextDistDir + '/cache',
    'USER node',
    'EXPOSE 3000',
    'STOPSIGNAL SIGTERM',
    'HEALTHCHECK --interval=15s --timeout=10s --start-period=60s --retries=3 \\',
    '    CMD ["node", "/app/scripts/docker-healthcheck.mjs"]',
    'ENTRYPOINT ["/bin/sh", "/app/scripts/docker-entrypoint.sh"]',
    'CMD []',
    '',
  ].join('\n')
}

export async function packageP5ReleaseCandidate({
  root = projectRoot,
  destination,
  nextDistDir = P5_NEXT_DIST_DIR,
  nodeImage = P5_DEFAULT_NODE_IMAGE,
  environment = process.env,
  buildConfig = computeDockerBuildConfig(environment),
} = {}) {
  if (typeof destination !== 'string' || destination.length === 0) {
    throw new Error('--destination is required and must be an absolute new path')
  }
  const assembled = await assembleIsolatedDockerRuntime({
    root,
    destination,
    nextDistDir,
    buildConfig,
    environment,
  })
  const dockerfile = renderP5CandidateDockerfile({ nodeImage, nextDistDir: assembled.nextDistDir })
  await writeFile(path.join(assembled.destination, P5_CANDIDATE_DOCKERFILE_NAME), dockerfile)
  const artifacts = await createCandidateArtifactManifest({
    root: path.resolve(root),
    destination: assembled.destination,
    nextDistDir: assembled.nextDistDir,
  })
  const manifest = {
    kind: 'yanxing-p5-isolated-candidate',
    cutover: false,
    destination: assembled.destination,
    nextDistDir: assembled.nextDistDir,
    buildId: artifacts.buildId,
    identity: artifacts.identity,
    runtimeEntries: artifacts.runtimeEntries,
    buildConfig,
    nodeImage,
    imageTag: P5_ISOLATED_IMAGE,
  }
  await writeFile(
    path.join(assembled.destination, P5_CANDIDATE_MANIFEST_NAME),
    JSON.stringify(manifest, null, 2) + '\n',
  )
  return {
    ...assembled,
    dockerfilePath: path.join(assembled.destination, P5_CANDIDATE_DOCKERFILE_NAME),
    manifestPath: path.join(assembled.destination, P5_CANDIDATE_MANIFEST_NAME),
    imageTag: P5_ISOLATED_IMAGE,
    buildConfig,
    nodeImage,
    buildId: artifacts.buildId,
    identity: artifacts.identity,
  }
}

export async function createCandidateArtifactManifest({ root, destination, nextDistDir }) {
  const buildIdPath = path.join(destination, nextDistDir, 'BUILD_ID')
  if (!existsSync(buildIdPath)) {
    throw new Error('Candidate is missing ' + nextDistDir + '/BUILD_ID')
  }
  const buildId = (await readFile(buildIdPath, 'utf8')).trim()
  const trace = JSON.parse(await readFile(path.join(root, '.runtime/runtime.nft.json'), 'utf8'))
  if (!Array.isArray(trace.files)) throw new Error('Invalid runtime trace manifest')
  const runtimeEntries = []
  for (const relativePath of [...new Set(trace.files)].sort()) {
    runtimeEntries.push(await hashRuntimeEntry(path.join(destination, relativePath), relativePath))
  }
  const canonical = ['buildId=' + buildId, ...runtimeEntries.map((entry) => entry.path + '=' + entry.sha256)].join('\n')
  return {
    buildId,
    runtimeEntries,
    identity: {
      algorithm: 'sha256',
      value: createHash('sha256').update(canonical).digest('hex'),
    },
  }
}

async function hashRuntimeEntry(target, relativePath) {
  if (!existsSync(target)) {
    throw new Error('Runtime entry missing from candidate: ' + relativePath)
  }
  const stats = lstatSync(target)
  if (stats.isSymbolicLink()) {
    const symlinkTarget = readlinkSync(target)
    return {
      path: relativePath,
      sha256: createHash('sha256').update('symlink:' + symlinkTarget).digest('hex'),
      symlink: symlinkTarget,
    }
  }
  if (stats.isDirectory()) {
    throw new Error('Runtime entry is a directory: ' + relativePath)
  }
  const bytes = await readFile(target)
  return { path: relativePath, sha256: createHash('sha256').update(bytes).digest('hex') }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseP5PackageArguments(process.argv.slice(2))
    if (options.help) {
      process.stdout.write(P5_PACKAGE_HELP)
      process.exit(0)
    }
    const result = await packageP5ReleaseCandidate(options)
    console.log('P5 isolated candidate: ' + result.destination)
    console.log('P5 isolated image tag: ' + result.imageTag)
    console.log('P5 BUILD_ID: ' + result.buildId)
    console.log('P5 identity: ' + result.identity.value)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

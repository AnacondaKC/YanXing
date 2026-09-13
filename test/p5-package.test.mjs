import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  assembleIsolatedDockerRuntime,
  assertSafeIsolatedDestination,
  computeDockerBuildConfig,
  isPrivateRuntimePath,
} from '../scripts/assemble-docker-runtime.mjs'
import {
  P5_ISOLATED_IMAGE,
  P5_NEXT_DIST_DIR,
  P5_PACKAGE_HELP,
  packageP5ReleaseCandidate,
  parseP5PackageArguments,
  renderP5CandidateDockerfile,
} from '../scripts/p5-package.mjs'

const defaultUploadLimit = 25 * 1024 * 1024
const runtimeScriptFiles = {
  'scripts/docker-entrypoint.sh': '#!/bin/sh',
  'scripts/docker-supervisor.mjs': 'supervisor',
  'scripts/docker-runtime-config.mjs': '',
  'scripts/docker-healthcheck.mjs': '',
  'scripts/docker-security-smoke.mjs': '',
  'scripts/deployment-smoke.mjs': '',
  'scripts/deployment-fixtures.mjs': 'completeDocx+CRC',
  'lib/upload-limits.mjs': '',
  LICENSE: 'project license',
}

test('isolated assembly refuses live runtime, project root, storage, git, test data and volumes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yanxing-p5-refuse-'))
  try {
    const liveRuntime = path.join(root, '.docker-runtime')
    await mkdir(liveRuntime, { recursive: true })
    await writeFile(path.join(liveRuntime, 'server.js'), 'live-artifact')
    await mkdir(path.join(root, 'storage'), { recursive: true })
    await mkdir(path.join(root, '.git'), { recursive: true })
    await mkdir(path.join(root, 'test'), { recursive: true })
    const refusals = [
      ['.docker-runtime', /live Docker runtime/],
      [path.join(root, '.docker-runtime'), /live Docker runtime/],
      [path.join(root, '.docker-runtime', 'current'), /live Docker runtime/],
      [root, /project root/],
      ['', /non-empty path/],
      [path.join(root, 'storage', 'data'), /storage/],
      [path.join(root, '.git', 'objects'), /\.git/],
      [path.join(root, 'test', 'tmp'), /test/],
      [path.join(root, 'yanxing_data'), /Docker volume/],
      [path.resolve('/'), /contains the project|Docker volume|project root/],
    ]
    for (const [destination, pattern] of refusals) {
      assert.throws(() => assertSafeIsolatedDestination(root, destination), pattern, String(destination))
      await assert.rejects(assembleIsolatedDockerRuntime({ root, destination }), pattern)
    }
    assert.equal(await readFile(path.join(liveRuntime, 'server.js'), 'utf8'), 'live-artifact')
    assert.equal(existsSync(path.join(root, '.docker-build.json')), false)
    const emptyDestination = path.join(root, 'out', 'empty-candidate')
    await mkdir(emptyDestination, { recursive: true })
    await assert.rejects(
      assembleIsolatedDockerRuntime({ root, destination: emptyDestination }),
      /overwrite an existing destination/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('private packaging paths include env, storage, git and test data', () => {
  for (const entry of ['.env', '.env.lan', 'storage/yanxing.sqlite', 'storage/.settings-key', 'storage-native/yanxing.sqlite', 'storage-native/reports/report.docx', '.git/config', 'test/docker-assembly.test.mjs']) {
    assert.equal(isPrivateRuntimePath(entry), true, entry)
  }
  assert.equal(isPrivateRuntimePath('.runtime/worker/index.mjs'), false)
  assert.equal(isPrivateRuntimePath('scripts/deployment-fixtures.mjs'), false)
})

test('isolated candidate maps custom distDir, excludes private files and does not write root build config', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yanxing-p5-pack-'))
  const destination = path.join(root, 'out', 'p5-docker-candidate')
  try {
    await seedIsolatedProject(root)
    const outside = path.join(os.tmpdir(), `yanxing-p5-secret-${process.pid}`)
    await writeFile(outside, 'host-secret')
    try {
      await symlink(outside, path.join(root, 'node_modules', 'escaped-link'))
      await writeFile(path.join(root, '.runtime/runtime.nft.json'), JSON.stringify({
        version: 1,
        files: ['.runtime/worker/index.mjs', 'node_modules/example', 'node_modules/.pnpm/example/node_modules/example/index.js'],
      }))
      const result = await packageP5ReleaseCandidate({
        root,
        destination,
        nextDistDir: P5_NEXT_DIST_DIR,
        environment: { REPORT_MAX_UPLOAD_BYTES: '31457280' },
      })
      assert.equal(result.destination, destination)
      assert.equal(result.nextDistDir, P5_NEXT_DIST_DIR)
      assert.equal(result.imageTag, P5_ISOLATED_IMAGE)
      assert.notEqual(result.imageTag, 'latest')
      assert.equal(await readFile(path.join(destination, 'server.js'), 'utf8'), 'standalone')
      assert.equal(await readFile(path.join(destination, P5_NEXT_DIST_DIR, 'static/chunks/app.js'), 'utf8'), 'client')
      assert.equal(await readFile(path.join(destination, P5_NEXT_DIST_DIR, 'server/app.js'), 'utf8'), 'server-app')
      assert.equal(await readFile(path.join(destination, 'scripts/deployment-fixtures.mjs'), 'utf8'), 'completeDocx+CRC')
      assert.equal(await readFile(path.join(destination, 'public/logo.svg'), 'utf8'), 'logo')
      assert.deepEqual(JSON.parse(await readFile(path.join(destination, '.docker-build.json'), 'utf8')), {
        reportMaxUploadBytes: 30 * 1024 * 1024,
      })
      const dockerfile = await readFile(path.join(destination, 'Dockerfile'), 'utf8')
      assert.match(dockerfile, /^# syntax=docker\/dockerfile:1.7/)
      assert.match(dockerfile, /YANXING_NEXT_DIST_DIR=\.next-p5-qa/)
      assert.match(dockerfile, /USER node/)
      assert.doesNotMatch(dockerfile, /latest/)
      assert.equal(existsSync(path.join(destination, '.next/static/chunks/app.js')), false)
      assert.equal(existsSync(path.join(destination, '.next/cache')), false)
      assert.equal(existsSync(path.join(destination, P5_NEXT_DIST_DIR, 'cache')), false)
      for (const excluded of ['.env.production', 'storage/.settings-key', '.git/config', 'test/secret.test.mjs']) {
        await assert.rejects(readFile(path.join(destination, excluded)), { code: 'ENOENT' })
      }
      const manifest = JSON.parse(await readFile(path.join(destination, 'p5-candidate-manifest.json'), 'utf8'))
      assert.equal(manifest.buildId, 'test-build-id')
      assert.equal(manifest.identity.algorithm, 'sha256')
      assert.equal(manifest.identity.value.length, 64)
      assert.equal(manifest.runtimeEntries.length > 0, true)
      assert.equal(manifest.runtimeEntries.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256)), true)
      assert.equal(existsSync(path.join(root, '.docker-build.json')), false)
      assert.equal(existsSync(path.join(root, '.docker-runtime')), false)
      await assert.rejects(packageP5ReleaseCandidate({ root, destination }), /overwrite an existing destination/)
      await writeFile(path.join(root, '.runtime/runtime.nft.json'), JSON.stringify({
        version: 1,
        files: ['storage/.settings-key'],
      }))
      await assert.rejects(assembleIsolatedDockerRuntime({ root, destination: path.join(root, 'out', 'p5-private') }), /Private data found/)
      await writeFile(path.join(root, '.runtime/runtime.nft.json'), JSON.stringify({
        version: 1,
        files: ['test/secret.test.mjs'],
      }))
      await assert.rejects(assembleIsolatedDockerRuntime({ root, destination: path.join(root, 'out', 'p5-test') }), /Private data found/)
      await writeFile(path.join(root, '.runtime/runtime.nft.json'), JSON.stringify({
        version: 1,
        files: ['.runtime/worker/index.mjs', 'node_modules/escaped-link'],
      }))
      await assert.rejects(assembleIsolatedDockerRuntime({ root, destination: path.join(root, 'out', 'p5-link') }), /symlink escapes/)
    } finally {
      await rm(outside, { force: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('p5-package CLI requires an absolute new destination and supports help', () => {
  assert.throws(() => parseP5PackageArguments([]), /--destination is required/)
  assert.throws(() => parseP5PackageArguments(['--destination', 'relative/path']), /absolute new path/)
  assert.throws(() => parseP5PackageArguments(['--destination']), /requires a value/)
  assert.throws(() => parseP5PackageArguments(['--unknown']), /Unknown argument/)
  assert.deepEqual(parseP5PackageArguments(['--help']), { help: true })
  assert.match(P5_PACKAGE_HELP, /--destination/)
  assert.match(P5_PACKAGE_HELP, /--next-dist-dir/)
  assert.match(P5_PACKAGE_HELP, /--node-image/)
  assert.deepEqual(
    parseP5PackageArguments([
      '--destination', '/tmp/yanxing-p5-new',
      '--next-dist-dir', '.next-p5-qa',
      '--node-image', 'node:24.20.0-bookworm-slim',
    ]),
    {
      help: false,
      destination: '/tmp/yanxing-p5-new',
      nextDistDir: '.next-p5-qa',
      nodeImage: 'node:24.20.0-bookworm-slim',
    },
  )
})

test('candidate Dockerfile matches the runtime stage with custom distDir', () => {
  const dockerfile = renderP5CandidateDockerfile()
  assert.match(dockerfile, /FROM \$\{NODE_IMAGE\} AS runtime/)
  assert.match(dockerfile, /YANXING_NEXT_DIST_DIR=\.next-p5-qa/)
  assert.match(dockerfile, /install -d -m 0700 -o node -g node \/app\/storage \/app\/\.next-p5-qa\/cache/)
  assert.equal(computeDockerBuildConfig({}).reportMaxUploadBytes, defaultUploadLimit)
})

async function seedIsolatedProject(root) {
  const files = {
    '.next-p5-qa/standalone/server.js': 'standalone',
    '.next-p5-qa/standalone/.env.production': 'secret',
    '.next-p5-qa/standalone/storage/.settings-key': 'secret',
    '.next-p5-qa/standalone/.git/config': 'git',
    '.next-p5-qa/standalone/test/secret.test.mjs': 'should not ship',
    '.next-p5-qa/standalone/.next-p5-qa/cache/webpack/cache': 'must not ship',
    '.next-p5-qa/BUILD_ID': 'test-build-id',
    '.next-p5-qa/standalone/.next-p5-qa/BUILD_ID': 'test-build-id',
    '.next-p5-qa/standalone/.next-p5-qa/server/app.js': 'server-app',
    '.next-p5-qa/static/chunks/app.js': 'client',
    'public/logo.svg': 'logo',
    '.runtime/worker/index.mjs': 'worker',
    'node_modules/.pnpm/example/node_modules/example/index.js': 'dependency',
    'node_modules/.pnpm/example/node_modules/example/LICENSE': 'license',
    'storage/.settings-key': 'secret',
    'test/secret.test.mjs': 'test-data',
    ...runtimeScriptFiles,
  }
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  await symlink('.pnpm/example/node_modules/example', path.join(root, 'node_modules/example'))
}


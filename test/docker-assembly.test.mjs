import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { assembleDockerRuntime, isPrivateRuntimePath, resolveTracePath } from '../scripts/assemble-docker-runtime.mjs'

test('runtime trace refuses absolute paths, empty paths and traversal outside the project', () => {
  const root = '/project'
  for (const entry of ['', '.', '..', '../secret', '/etc/passwd', null]) {
    assert.throws(() => resolveTracePath(root, entry))
  }
  assert.equal(resolveTracePath(root, '.runtime/worker/index.mjs'), '/project/.runtime/worker/index.mjs')
})

test('runtime packaging identifies private environment and storage paths', () => {
  for (const entry of ['.env', '.env.lan', 'storage/yanxing.sqlite', 'storage/.settings-key', '.git/config']) {
    assert.equal(isPrivateRuntimePath(entry), true, entry)
  }
  assert.equal(isPrivateRuntimePath('.runtime/worker/index.mjs'), false)
  assert.equal(isPrivateRuntimePath('node_modules/@next/env/dist/index.js'), false)
})

test('Docker assembly merges traced runtime, static assets and licenses without build caches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yanxing-assembly-'))
  const files = {
    '.next/standalone/server.js': 'standalone',
    '.next/standalone/.env.production': 'secret',
    '.next/standalone/storage/.settings-key': 'secret',
    '.next/standalone/.next/cache/webpack/cache': 'must not ship',
    '.next/static/chunks/app.js': 'client',
    'public/logo.svg': 'logo',
    '.runtime/worker/index.mjs': 'worker',
    'node_modules/.pnpm/example/node_modules/example/index.js': 'dependency',
    'node_modules/.pnpm/example/node_modules/example/LICENSE': 'license',
    'LICENSE': 'project license',
    '.docker-build.json': '{}',
    'scripts/docker-entrypoint.sh': '#!/bin/sh',
    'scripts/docker-runtime-config.mjs': '',
    'scripts/docker-healthcheck.mjs': '',
    'scripts/docker-security-smoke.mjs': '',
    'scripts/deployment-smoke.mjs': '',
    'scripts/deployment-fixtures.mjs': '',
    'lib/upload-limits.mjs': '',
  }
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const target = path.join(root, relativePath)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, content)
    }
    await symlink('.pnpm/example/node_modules/example', path.join(root, 'node_modules/example'))
    await writeFile(path.join(root, '.runtime/runtime.nft.json'), JSON.stringify({
      version: 1, files: ['.runtime/worker/index.mjs', 'node_modules/example', 'node_modules/.pnpm/example/node_modules/example/index.js'],
    }))
    await assembleDockerRuntime(root)
    const output = path.join(root, '.docker-runtime')
    assert.equal(await readFile(path.join(output, 'node_modules/example/index.js'), 'utf8'), 'dependency')
    assert.equal(await readFile(path.join(output, '.runtime/worker/index.mjs'), 'utf8'), 'worker')
    assert.equal(await readFile(path.join(output, '.next/static/chunks/app.js'), 'utf8'), 'client')
    assert.equal(await readFile(path.join(output, 'public/logo.svg'), 'utf8'), 'logo')
    assert.equal(await readFile(path.join(output, 'third-party-licenses/node_modules/.pnpm/example/node_modules/example/LICENSE'), 'utf8'), 'license')
    for (const excluded of ['.next/cache/webpack/cache', '.env.production', 'storage/.settings-key']) {
      await assert.rejects(readFile(path.join(output, excluded)), { code: 'ENOENT' })
    }
    await writeFile(path.join(root, '.runtime/runtime.nft.json'), JSON.stringify({ version: 1, files: ['storage/.settings-key'] }))
    await assert.rejects(assembleDockerRuntime(root), /Private data found/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

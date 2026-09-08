import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { validateDockerRuntimeConfig } from '../scripts/docker-runtime-config.mjs'

const defaultLimit = 25 * 1024 * 1024

test('Docker accepts matching default and custom build/runtime upload limits', () => {
  assert.doesNotThrow(() => validateDockerRuntimeConfig({ reportMaxUploadBytes: defaultLimit }, {}))
  assert.doesNotThrow(() => validateDockerRuntimeConfig({ reportMaxUploadBytes: defaultLimit }, { REPORT_MAX_UPLOAD_BYTES: '' }))
  assert.doesNotThrow(() => validateDockerRuntimeConfig({ reportMaxUploadBytes: 30 * 1024 * 1024 }, { REPORT_MAX_UPLOAD_BYTES: '31457280' }))
})

test('Docker refuses changed upload limits until the image is rebuilt', () => {
  assert.throws(() => validateDockerRuntimeConfig({ reportMaxUploadBytes: defaultLimit }, { REPORT_MAX_UPLOAD_BYTES: '31457280' }), /重新构建镜像/)
  assert.throws(() => validateDockerRuntimeConfig({ reportMaxUploadBytes: 30 * 1024 * 1024 }, {}), /重新构建镜像/)
})

test('Docker refuses invalid build metadata', () => {
  for (const reportMaxUploadBytes of [undefined, 0, -1, 1.5, '26214400']) {
    assert.throws(() => validateDockerRuntimeConfig({ reportMaxUploadBytes }, {}), /构建记录/)
  }
})

test('Docker entrypoint runs services in foreground with explicit production mode', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yanxing-entrypoint-'))
  try {
    await writeFile(path.join(directory, 'node'), '#!/bin/sh\nprintf \"%s\\n\" \"$@\"\n', { mode: 0o700 })
    const entrypoint = new URL('../scripts/docker-entrypoint.sh', import.meta.url).pathname
    for (const [command, expected] of [
      ['worker', '/app/worker/index.ts'],
      ['migrate', '/app/scripts/migrate.ts'],
      ['user:create', '/app/scripts/create-user.ts'],
      ['storage:reconcile', '/app/scripts/storage-maintenance.ts'],
    ]) {
      const result = spawnSync('/bin/sh', [entrypoint, command], { encoding: 'utf8', env: { ...process.env, PATH: directory } })
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(result.stdout.trim().split('\n'), [
        '/app/scripts/docker-runtime-config.mjs', '--import', 'tsx', expected, '--mode=production',
      ])
    }
    const web = spawnSync('/bin/sh', [entrypoint], { encoding: 'utf8', env: { ...process.env, PATH: directory } })
    assert.equal(web.status, 0, web.stderr)
    assert.match(web.stdout, /next\nstart\n--hostname\n0.0.0.0\n--port\n3000/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('image normalizes readable code permissions before creating private storage', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8')
  const normalizeCode = dockerfile.indexOf('chmod -R a+rX /app')
  const privateStorage = dockerfile.indexOf('install -d -m 0700 -o node -g node /app/storage')
  assert.ok(normalizeCode >= 0 && privateStorage > normalizeCode)
  assert.ok(dockerfile.includes('--package-import-method=copy'))
  assert.ok(dockerfile.indexOf('USER node') > privateStorage)
})

test('Docker shell scripts parse and deployment files contain no control characters', async () => {
  for (const file of ['Dockerfile', 'compose.yaml', 'scripts/docker-entrypoint.sh', 'scripts/test-docker.sh']) {
    const source = new URL('../' + file, import.meta.url)
    const content = await readFile(source, 'utf8')
    assert.doesNotMatch(content, /[\x00-\x08\x0b\x0c\x0e-\x1f]/)
    if (file.endsWith('.sh')) {
      const result = spawnSync('sh', ['-n', source.pathname], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
  }
})

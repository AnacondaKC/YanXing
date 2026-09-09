import assert from 'node:assert/strict'
import test from 'node:test'
import {
  COMPILED_RUNTIME_ENTRY_SOURCES,
  EXTRA_TRACE_ENTRY_PATHS,
  isPrivateTracePath,
  shouldIgnoreTracedFile,
} from '../scripts/build-runtime.mjs'

test('runtime compile entries cover worker, scripts, and parser children', () => {
  assert.deepEqual(COMPILED_RUNTIME_ENTRY_SOURCES, [
    'worker/index.ts',
    'scripts/migrate.ts',
    'scripts/create-user.ts',
    'scripts/storage-maintenance.ts',
    'scripts/relocate-storage.ts',
    'lib/documents/pdf-parser-worker.ts',
    'lib/documents/docx-parser-worker.ts',
  ])
})

test('runtime nft extra entries include docker scripts and the parser resolver', () => {
  assert.deepEqual(EXTRA_TRACE_ENTRY_PATHS, [
    'scripts/docker-runtime-config.mjs',
    'scripts/docker-healthcheck.mjs',
    'scripts/deployment-smoke.mjs',
    'lib/documents/parser-child-runtime.mjs',
    'lib/config/load-env.mjs',
  ])
})

test('runtime nft treats project storage and env files as private without matching lib/storage', () => {
  assert.equal(isPrivateTracePath('storage/yanxing.sqlite'), true)
  assert.equal(isPrivateTracePath('storage/knowledge/file.pdf'), true)
  assert.equal(isPrivateTracePath('.env'), true)
  assert.equal(isPrivateTracePath('.env.local'), true)
  assert.equal(isPrivateTracePath('.env.production'), true)
  assert.equal(isPrivateTracePath('yanxing.sqlite'), true)
  assert.equal(isPrivateTracePath('lib/storage/maintenance.ts'), false)
  assert.equal(isPrivateTracePath('lib/documents/parser-child-runtime.mjs'), false)
  assert.equal(isPrivateTracePath('.runtime/worker/index.mjs'), false)
})

test('runtime nft ignores tsx, esbuild, and typescript package traces', () => {
  assert.equal(shouldIgnoreTracedFile('node_modules/tsx/dist/esm/index.mjs'), true)
  assert.equal(shouldIgnoreTracedFile('node_modules/.pnpm/tsx@4.23.1/node_modules/tsx/dist/esm/index.mjs'), true)
  assert.equal(shouldIgnoreTracedFile('node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/lib/main.js'), true)
  assert.equal(shouldIgnoreTracedFile('node_modules/.pnpm/typescript@5.7.0/node_modules/typescript/lib/typescript.js'), true)
  assert.equal(shouldIgnoreTracedFile('node_modules/.pnpm/pdf-parse@2.4.5/node_modules/pdf-parse/dist/pdf-parse/esm/index.js'), false)
  assert.equal(shouldIgnoreTracedFile('storage/secret.txt'), true)
})

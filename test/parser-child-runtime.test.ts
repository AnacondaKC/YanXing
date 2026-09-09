import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  COMPILED_RUNTIME_ENV_NAME,
  COMPILED_RUNTIME_ENV_VALUE,
  PARSER_WORKER_COMPILED_FILE_NAMES,
  PARSER_WORKER_FILE_NAMES,
  ParserChildRuntimeError,
  parserChildSpawnArguments,
  resolveParserChildRuntime,
} from '../lib/documents/parser-child-runtime'
import { extractDocxText, extractPdfText } from '../lib/documents/document-parser'
import { createMinimalDocxBuffer, createMinimalPdfBuffer } from '../scripts/deployment-fixtures.mjs'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const documentsDir = path.join(projectRoot, 'lib', 'documents')
const compiledEnv = { [COMPILED_RUNTIME_ENV_NAME]: COMPILED_RUNTIME_ENV_VALUE } as const

test('default parser child lookup finds source workers from an isolated test cwd', () => {
  const pdf = resolveParserChildRuntime({ kind: 'PDF' })
  const docx = resolveParserChildRuntime({ kind: 'DOCX' })
  assert.equal(pdf.workerPath, path.join(documentsDir, PARSER_WORKER_FILE_NAMES.PDF))
  assert.equal(docx.workerPath, path.join(documentsDir, PARSER_WORKER_FILE_NAMES.DOCX))
  assert.ok(pdf.tsxLoaderPath)
  assert.ok(docx.tsxLoaderPath)
  assert.equal(existsSync(pdf.tsxLoaderPath), true)
  assert.equal(existsSync(docx.tsxLoaderPath), true)
})

test('parser child lookup prefers cwd/lib/documents over a webpack chunk URL', async () => {
  const fakeRoot = await mkdtemp(`${tmpdir()}/yanxing-parser-cwd-`)
  const workerDir = path.join(fakeRoot, 'lib', 'documents')
  await mkdir(workerDir, { recursive: true })
  const decoy = path.join(workerDir, PARSER_WORKER_FILE_NAMES.PDF)
  await writeFile(decoy, '// decoy parser worker\n')
  const webpackUrl = pathToFileURL(path.join(fakeRoot, '.next', 'server', 'chunks', 'ssr', 'chunk-parser.js')).href
  const resolved = resolveParserChildRuntime({ kind: 'PDF', cwd: fakeRoot, moduleUrl: webpackUrl })
  assert.equal(resolved.workerPath, decoy)
})

test('parser child lookup throws when neither cwd nor the module directory has workers', async () => {
  const emptyCwd = await mkdtemp(`${tmpdir()}/yanxing-parser-missing-`)
  const fakeModule = pathToFileURL(path.join(emptyCwd, 'chunk.js')).href
  assert.throws(
    () => resolveParserChildRuntime({ kind: 'PDF', cwd: emptyCwd, moduleUrl: fakeModule }),
    (error: unknown) => error instanceof ParserChildRuntimeError && /无法定位 PDF/.test(error.message),
  )
})

test('NODE_ENV=production without compiled-runtime flag still uses source workers', async () => {
  const fakeRoot = await mkdtemp(`${tmpdir()}/yanxing-parser-prod-source-`)
  const sourceDir = path.join(fakeRoot, 'lib', 'documents')
  const compiledDir = path.join(fakeRoot, '.runtime', 'lib', 'documents')
  await mkdir(sourceDir, { recursive: true })
  await mkdir(compiledDir, { recursive: true })
  const sourcePath = path.join(sourceDir, PARSER_WORKER_FILE_NAMES.PDF)
  const compiledPath = path.join(compiledDir, PARSER_WORKER_COMPILED_FILE_NAMES.PDF)
  await writeFile(sourcePath, '// source parser worker\n')
  await writeFile(compiledPath, '// compiled parser worker\n')
  const resolved = resolveParserChildRuntime({
    kind: 'PDF',
    cwd: fakeRoot,
    env: { NODE_ENV: 'production' },
  })
  assert.equal(resolved.workerPath, sourcePath)
  assert.ok(resolved.tsxLoaderPath)
})

test('compiled-runtime flag uses .runtime workers without tsx and ignores source files', async () => {
  const fakeRoot = await mkdtemp(`${tmpdir()}/yanxing-parser-compiled-`)
  const sourceDir = path.join(fakeRoot, 'lib', 'documents')
  const compiledDir = path.join(fakeRoot, '.runtime', 'lib', 'documents')
  await mkdir(sourceDir, { recursive: true })
  await mkdir(compiledDir, { recursive: true })
  await writeFile(path.join(sourceDir, PARSER_WORKER_FILE_NAMES.PDF), '// source parser worker\n')
  const compiledPath = path.join(compiledDir, PARSER_WORKER_COMPILED_FILE_NAMES.PDF)
  await writeFile(compiledPath, '// compiled parser worker\n')
  const resolved = resolveParserChildRuntime({
    kind: 'PDF',
    cwd: fakeRoot,
    env: { NODE_ENV: 'development', ...compiledEnv },
  })
  assert.equal(resolved.workerPath, compiledPath)
  assert.equal(resolved.tsxLoaderPath, undefined)
})

test('compiled-runtime flag fails closed when compiled workers are missing', async () => {
  const fakeRoot = await mkdtemp(`${tmpdir()}/yanxing-parser-compiled-missing-`)
  const sourceDir = path.join(fakeRoot, 'lib', 'documents')
  await mkdir(sourceDir, { recursive: true })
  await writeFile(path.join(sourceDir, PARSER_WORKER_FILE_NAMES.PDF), '// source parser worker\n')
  assert.throws(
    () => resolveParserChildRuntime({ kind: 'PDF', cwd: fakeRoot, env: compiledEnv }),
    (error: unknown) => error instanceof ParserChildRuntimeError && /pdf-parser-worker\.mjs/.test(error.message),
  )
})

test('parser child spawn arguments omit --import when no tsx loader is present', () => {
  const compiled = parserChildSpawnArguments({ workerPath: '/app/.runtime/lib/documents/pdf-parser-worker.mjs' }, 256, '/tmp/a.pdf')
  assert.deepEqual(compiled, [
    '--max-old-space-size=256',
    '/app/.runtime/lib/documents/pdf-parser-worker.mjs',
    '/tmp/a.pdf',
  ])
  const source = parserChildSpawnArguments(
    { workerPath: '/app/lib/documents/pdf-parser-worker.ts', tsxLoaderPath: '/app/node_modules/tsx/esm/index.mjs' },
    128,
    '/tmp/a.pdf',
  )
  assert.deepEqual(source, [
    '--max-old-space-size=128',
    '--import',
    '/app/node_modules/tsx/esm/index.mjs',
    '/app/lib/documents/pdf-parser-worker.ts',
    '/tmp/a.pdf',
  ])
})

test('compiled parser worker process runs without a tsx loader', async () => {
  const fakeRoot = await mkdtemp(`${tmpdir()}/yanxing-parser-compiled-spawn-`)
  const compiledDir = path.join(fakeRoot, '.runtime', 'lib', 'documents')
  await mkdir(compiledDir, { recursive: true })
  const workerPath = path.join(compiledDir, PARSER_WORKER_COMPILED_FILE_NAMES.PDF)
  await writeFile(workerPath, [
    'const payload = { ok: true, text: "compiled-pdf", paragraphCount: 1, characterCount: 12 }',
    'process.stdout.write(JSON.stringify(payload) + "\\n")',
    '',
  ].join('\n'))
  const runtime = resolveParserChildRuntime({ kind: 'PDF', cwd: fakeRoot, env: compiledEnv })
  const inputPath = path.join(fakeRoot, 'in.pdf')
  await writeFile(inputPath, 'pdf')
  const spawned = spawnSync(process.execPath, parserChildSpawnArguments(runtime, 64, inputPath), {
    encoding: 'utf8',
    cwd: fakeRoot,
  })
  assert.equal(spawned.status, 0, spawned.stderr)
  assert.equal(spawned.stdout.includes('--import'), false)
  assert.match(spawned.stdout, /compiled-pdf/)
})

test('isolated parser children still extract PDF and DOCX after the runtime helper change', async () => {
  const directory = await mkdtemp(`${tmpdir()}/yanxing-parser-extract-`)
  const pdfPath = path.join(directory, 'smoke.pdf')
  const docxPath = path.join(directory, 'smoke.docx')
  await writeFile(pdfPath, createMinimalPdfBuffer('Parser runtime PDF'))
  await writeFile(docxPath, createMinimalDocxBuffer('Parser runtime DOCX'))
  const pdf = await extractPdfText(pdfPath)
  const docx = await extractDocxText(docxPath)
  assert.match(pdf.text, /Parser runtime PDF/)
  assert.match(docx.text, /Parser runtime DOCX/)
})

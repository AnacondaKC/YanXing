import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  PARSER_WORKER_FILE_NAMES,
  ParserChildRuntimeError,
  resolveParserChildRuntime,
} from '../lib/documents/parser-child-runtime'
import { extractDocxText, extractPdfText } from '../lib/documents/document-parser'
import { createMinimalDocxBuffer, createMinimalPdfBuffer } from '../scripts/deployment-fixtures.mjs'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const documentsDir = path.join(projectRoot, 'lib', 'documents')

test('default parser child lookup finds source workers from an isolated test cwd', () => {
  const pdf = resolveParserChildRuntime({ kind: 'PDF' })
  const docx = resolveParserChildRuntime({ kind: 'DOCX' })
  assert.equal(pdf.workerPath, path.join(documentsDir, PARSER_WORKER_FILE_NAMES.PDF))
  assert.equal(docx.workerPath, path.join(documentsDir, PARSER_WORKER_FILE_NAMES.DOCX))
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

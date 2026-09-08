import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('isolated runner probe', async () => {
  const outputPath = process.env.YANXING_TEST_PROBE_OUTPUT
  assert.ok(outputPath)
  const { getDatabasePath } = await import('../../lib/db/database-path')
  const { getKnowledgeStorageRoot } = await import('../../lib/knowledge-storage')
  const { reportStorageRoot } = await import('../../lib/documents/report-storage')
  await writeFile(outputPath, JSON.stringify({
    cwd: process.cwd(),
    workspaceRoot: process.env.YANXING_TEST_WORKSPACE_ROOT,
    databasePath: getDatabasePath(),
    knowledgeRoot: getKnowledgeStorageRoot(),
    reportRoot: reportStorageRoot,
    tsconfigPath: process.env.TSX_TSCONFIG_PATH,
    testSourcePath: path.resolve(process.argv[1] ?? fileURLToPath(import.meta.url)),
  }))
})

test('unmatched runner probe must not execute', () => {
  assert.fail('test name filtering was not forwarded')
})

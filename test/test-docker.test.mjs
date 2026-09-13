import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

const source = await readFile(new URL('../scripts/test-docker.sh', import.meta.url), 'utf8')

test('Docker smoke corruption targets the native identity, not the retired migration ledger', () => {
  const sql = source.match(/db\.prepare\("(UPDATE [^"]+)"\)/)?.[1]
  assert.equal(sql, 'UPDATE native_schema_identity SET checksum = ? WHERE id = 1')
  const database = new DatabaseSync(':memory:')
  try {
    database.exec("CREATE TABLE native_schema_identity (id INTEGER PRIMARY KEY, checksum TEXT); INSERT INTO native_schema_identity VALUES (1, 'valid')")
    assert.equal(database.prepare(sql).run('smoke-invalid-checksum').changes, 1)
    assert.equal(database.prepare('SELECT checksum FROM native_schema_identity WHERE id = 1').get().checksum, 'smoke-invalid-checksum')
  } finally {
    database.close()
  }
})

test('Docker smoke recognizes current bootstrap and supervisor failures only', () => {
  const functionSource = source.match(/logs_show_migration_failure\(\) \{[\s\S]*?\n\}/)?.[0]
  assert.ok(functionSource)
  for (const [logs, expected] of [
    ['[yanxing] 数据库初始化失败：当前数据库的原生结构标记与本版本不一致', 0],
    ['[yanxing-supervisor] migrate failed (code=1)', 0],
    ['[yanxing] 原生数据库已就绪：yanxing-native-p3 checksum=abc。', 1],
    ['unrelated failure', 1],
    ['数据库迁移失败 checksum 不匹配 迁移账本校验失败', 1],
  ]) {
    const result = spawnSync('sh', ['-c', functionSource + '\nlogs_show_migration_failure "$1"', 'smoke-log-test', logs], { encoding: 'utf8' })
    assert.equal(result.status, expected, result.stderr || logs)
  }
})

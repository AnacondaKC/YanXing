import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { NATIVE_SCHEMA_CHECKSUM, NATIVE_SCHEMA_NAME } from '../lib/db/native-schema'
import { NATIVE_SCHEMA_PUBLIC_MESSAGES } from '../lib/db/native-schema-error'

const directory = await mkdtemp(tmpdir() + '/yanxing-native-bootstrap-')
const fixturePath = path.join(import.meta.dirname, 'fixtures', 'database-process.ts')
const tsxLoader = import.meta.resolve('tsx')

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function runInitialization(databasePath: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsxLoader, fixturePath, 'database-initialization'], {
      cwd: process.cwd(),
      env: { ...process.env, YANXING_DATABASE_PATH: databasePath },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error('database initialization exited with ' + code + ': ' + stderr))
    })
  })
}

test('fresh init binds report storage to the database parent reports directory', async () => {
  const databasePath = path.join(directory, 'isolated', 'app.sqlite')
  assert.equal(await runInitialization(databasePath), 'ok')
  const database = new DatabaseSync(databasePath)
  const identity = database.prepare('SELECT name, checksum FROM native_schema_identity WHERE id = 1').get() as { name: string; checksum: string }
  const boundRoot = database.prepare('SELECT path FROM submission_storage_root WHERE id = 1').get() as { path: string }
  const journalMode = (database.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode
  database.close()
  assert.equal(identity.name, NATIVE_SCHEMA_NAME)
  assert.equal(identity.checksum, NATIVE_SCHEMA_CHECKSUM)
  assert.equal(boundRoot.path, path.resolve(directory, 'isolated', 'reports'))
  assert.equal(journalMode.toLowerCase(), 'wal')
})

test('legacy report database is refused without WAL or identity writes', async () => {
  const databasePath = path.join(directory, 'legacy.sqlite')
  const database = new DatabaseSync(databasePath)
  database.exec("CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT NOT NULL); CREATE TABLE report_versions(id TEXT PRIMARY KEY);")
  database.exec("INSERT INTO users(id, username) VALUES ('legacy-user', 'legacy-user')")
  database.close()

  await assert.rejects(runInitialization(databasePath), new RegExp(NATIVE_SCHEMA_PUBLIC_MESSAGES.LEGACY_DATABASE))
  assert.equal(existsSync(databasePath + '-wal'), false)
  const after = new DatabaseSync(databasePath)
  const journalMode = (after.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode
  const user = after.prepare("SELECT username FROM users WHERE id = 'legacy-user'").get() as { username: string }
  const identity = after.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'native_schema_identity'").get()
  const reportVersions = after.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'report_versions'").get()
  after.close()
  assert.equal(journalMode.toLowerCase(), 'delete')
  assert.equal(user.username, 'legacy-user')
  assert.equal(identity, undefined)
  assert.ok(reportVersions)
})

test('mismatched native schema is refused without rewriting the database', async () => {
  const databasePath = path.join(directory, 'mismatched-native.sqlite')
  assert.equal(await runInitialization(databasePath), 'ok')
  const database = new DatabaseSync(databasePath)
  database.prepare('UPDATE native_schema_identity SET checksum = ? WHERE id = 1').run('unsupported-schema-checksum')
  database.close()
  const before = await readFile(databasePath)

  await assert.rejects(runInitialization(databasePath), new RegExp(NATIVE_SCHEMA_PUBLIC_MESSAGES.IDENTITY_MISMATCH))

  assert.deepEqual(await readFile(databasePath), before)
})

test('default database path keeps reports under the shared storage directory', async () => {
  const workspace = await mkdtemp(tmpdir() + '/yanxing-native-default-root-')
  const databasePath = path.join(workspace, 'storage', 'yanxing.sqlite')
  try {
    assert.equal(await runInitialization(databasePath), 'ok')
    const database = new DatabaseSync(databasePath)
    const boundRoot = database.prepare('SELECT path FROM submission_storage_root WHERE id = 1').get() as { path: string }
    database.close()
    assert.equal(boundRoot.path, path.resolve(workspace, 'storage', 'reports'))
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { decryptSecret, decryptSecretWithSecret } from '../lib/db/settings-crypto'
import { readBoundStorageRoot } from '../lib/db/native-schema'
import { NativeSchemaError, NATIVE_SCHEMA_PUBLIC_MESSAGES, publicNativeSchemaFailure } from '../lib/db/native-schema-error'
import { authenticateBackupManifest } from '../lib/storage/native-backup-key'
import {
  RestorePublicationInterruptedError,
  createRestoreIncompleteMarker,
  incompleteRestoreMarkerPresent,
  restoreIncompleteMarkerPath,
} from '../lib/storage/native-restore-guard'
import { createBackupStagingDirectory, hashRegularFile, publishStagedDirectory } from '../lib/storage/native-backup-archive'
import {
  backupNativeRuntime,
  isNativeBackupError,
  restoreNativeRuntime,
} from '../lib/storage/native-backup'
import { parseNativeBackupCli, runNativeBackupCli } from '../scripts/native-backup'
import {
  BACKUP_FIXTURE_API_SECRET,
  BACKUP_FIXTURE_KEY,
  createNativeBackupFixture,
} from './helpers/native-backup-fixture'

async function expectCode(run: () => Promise<unknown>, code: string) {
  await assert.rejects(run, (error: unknown) => {
    assert.equal(isNativeBackupError(error) ? error.code : String(error), code)
    return true
  })
}

function expectThrownCode(run: () => unknown, code: string) {
  assert.throws(run, (error: unknown) => {
    assert.equal(isNativeBackupError(error) ? error.code : String(error), code)
    return true
  })
}

test('backs up a quiescent native runtime and restores onto the same absent paths', async () => {
  const fixture = await createNativeBackupFixture()
  try {
    const destination = join(fixture.root, 'archive')
    const result = await backupNativeRuntime({
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
      destination,
    })
    assert.equal(result.manifest.counts.liveReports, 1)
    assert.equal(result.manifest.counts.tombstoneReports, 1)
    assert.equal(result.manifest.counts.knowledge, 1)
    assert.equal(result.manifest.counts.branding, 1)
    assert.equal(result.manifest.hasEncryptedSecrets, true)
    assert.equal(result.manifest.authenticationMode, 'hmac-sha256-scrypt-v2')
    assert.equal(existsSync(join(destination, 'yanxing.sqlite-wal')), false)
    assert.equal(existsSync(join(destination, 'database', 'yanxing.sqlite-wal')), false)
    const manifestText = await readFile(join(destination, 'MANIFEST.json'), 'utf8')
    assert.equal(manifestText.includes(BACKUP_FIXTURE_KEY), false)
    assert.equal(manifestText.includes(BACKUP_FIXTURE_API_SECRET), false)
    assert.equal(manifestText.includes('.settings-key'), false)

    fixture.database.close()
    await rm(fixture.runtimeRoot, { recursive: true, force: true })
    const restored = await restoreNativeRuntime({
      archivePath: destination,
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
    })
    assert.equal(restored.runtimeRoot, fixture.runtimeRoot)
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true })
    try {
      assert.equal(readBoundStorageRoot(database), fixture.storageRoot)
      const live = database.prepare('SELECT title, deleted_at AS deletedAt FROM report_submissions WHERE id = ?').get('report-live') as { title: string; deletedAt: string | null }
      const tombstone = database.prepare('SELECT deleted_at AS deletedAt FROM report_submissions WHERE id = ?').get('report-tombstone') as { deletedAt: string }
      assert.equal(live.title, '正式报告')
      assert.equal(live.deletedAt, null)
      assert.ok(tombstone.deletedAt)
      const encrypted = database.prepare('SELECT api_key_encrypted AS value FROM ai_model_channels WHERE api_key_encrypted IS NOT NULL').get() as { value: string }
      assert.equal(decryptSecret(encrypted.value), BACKUP_FIXTURE_API_SECRET)
      assert.equal(decryptSecretWithSecret(encrypted.value, Buffer.from(BACKUP_FIXTURE_KEY)), BACKUP_FIXTURE_API_SECRET)
      const usage = database.prepare("SELECT used_bytes AS usedBytes, item_count AS itemCount FROM storage_usage WHERE scope_type = 'global'").get() as { usedBytes: number; itemCount: number }
      assert.equal(usage.itemCount, 3)
      const audit = database.prepare('SELECT COUNT(*) AS n FROM report_submission_audit').get() as { n: number }
      assert.equal(Number(audit.n), 1)
      const task = database.prepare("SELECT status FROM submission_tasks WHERE id = 'task-1'").get() as { status: string }
      assert.equal(task.status, 'completed')
      const resultRow = database.prepare('SELECT COUNT(*) AS n FROM submission_task_results').get() as { n: number }
      assert.equal(Number(resultRow.n), 1)
    } finally {
      database.close()
    }
    assert.equal(await readFile(fixture.livePath, 'utf8'), 'live-report-body')
    assert.equal(await readFile(fixture.tombstonePath, 'utf8'), 'tombstone-report-body')
    assert.equal(await readFile(fixture.knowledgePath, 'utf8'), 'knowledge-item-body')
    assert.equal(await readFile(fixture.brandingPath, 'utf8'), 'brand-logo-bytes')
    assert.equal(existsSync(fixture.tmpPath), false)
    assert.equal(incompleteRestoreMarkerPresent(fixture.runtimeRoot), false)
  } finally {
    await fixture.dispose()
  }
})

test('refuses a wrong key at backup against original ciphertexts', async () => {
  const fixture = await createNativeBackupFixture()
  try {
    const original = fixture.encryptedApiKey
    process.env.YANXING_SETTINGS_ENCRYPTION_KEY = 'wrong-backup-key-not-the-original'
    await expectCode(() => backupNativeRuntime({
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
      destination: join(fixture.root, 'archive-wrong'),
    }), 'KEY_MISMATCH')
    process.env.YANXING_SETTINGS_ENCRYPTION_KEY = BACKUP_FIXTURE_KEY
    assert.equal(decryptSecret(original), BACKUP_FIXTURE_API_SECRET)
    const still = fixture.database.prepare('SELECT api_key_encrypted AS value FROM ai_model_channels WHERE api_key_encrypted IS NOT NULL').get() as { value: string }
    assert.equal(still.value, original)
    assert.equal(existsSync(join(fixture.root, 'archive-wrong')), false)
  } finally {
    await fixture.dispose()
  }
})

test('refuses restore when the HMAC is stripped as a downgrade', async () => {
  const fixture = await createNativeBackupFixture()
  try {
    const destination = join(fixture.root, 'archive')
    await backupNativeRuntime({
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
      destination,
    })
    const manifestPath = join(destination, 'MANIFEST.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    delete manifest.keyVerifier
    delete manifest.manifestMac
    manifest.hasEncryptedSecrets = false
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
    fixture.database.close()
    await rm(fixture.runtimeRoot, { recursive: true, force: true })
    await expectCode(() => restoreNativeRuntime({
      archivePath: destination,
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
    }), 'ARCHIVE_INVALID')
    assert.equal(existsSync(fixture.runtimeRoot), false)
  } finally {
    await fixture.dispose()
  }
})

test('refuses a corrupted report file in the archive', async () => {
  const fixture = await createNativeBackupFixture()
  try {
    const destination = join(fixture.root, 'archive')
    await backupNativeRuntime({
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
      destination,
    })
    const liveArchive = join(destination, 'files', 'reports', 'live', 'live.docx')
    const bytes = Buffer.from(await readFile(liveArchive))
    bytes[bytes.length - 1] ^= 0xff
    await writeFile(liveArchive, bytes)
    fixture.database.close()
    await rm(fixture.runtimeRoot, { recursive: true, force: true })
    await expectCode(() => restoreNativeRuntime({
      archivePath: destination,
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
    }), 'TAMPERED_ARCHIVE')
    assert.equal(existsSync(fixture.runtimeRoot), false)
  } finally {
    await fixture.dispose()
  }
})

test('refuses occupied restore targets including an empty runtime directory', async () => {
  const fixture = await createNativeBackupFixture()
  try {
    const destination = join(fixture.root, 'archive')
    await backupNativeRuntime({
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
      destination,
    })
    await expectCode(() => restoreNativeRuntime({
      archivePath: destination,
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
    }), 'TARGET_OCCUPIED')
    fixture.database.close()
    await rm(fixture.runtimeRoot, { recursive: true, force: true })
    await mkdir(fixture.runtimeRoot, { recursive: true })
    await expectCode(() => restoreNativeRuntime({
      archivePath: destination,
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
    }), 'TARGET_OCCUPIED')
  } finally {
    await fixture.dispose()
  }
})

test('refuses backup while a reservation is active and while a writer holds BEGIN IMMEDIATE', async () => {
  const fixture = await createNativeBackupFixture()
  try {
    fixture.database.prepare(`
      INSERT INTO storage_reservations(id, user_id, project_id, expected_bytes, owner_type, expires_at, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('reservation-active', 'submitter', 'project-native', 12, 'report', '2099-01-01T00:00:00.000Z', 'active', '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z')
    await expectCode(() => backupNativeRuntime({
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
      destination: join(fixture.root, 'archive-active'),
    }), 'NOT_QUIESCENT')
    fixture.database.prepare("UPDATE storage_reservations SET state = 'released' WHERE id = 'reservation-active'").run()

    const blocker = new DatabaseSync(fixture.databasePath, { timeout: 1 })
    blocker.exec('PRAGMA busy_timeout = 1')
    blocker.exec('BEGIN IMMEDIATE')
    try {
      await expectCode(() => backupNativeRuntime({
        databasePath: fixture.databasePath,
        storageRoot: fixture.storageRoot,
        destination: join(fixture.root, 'archive-locked'),
      }), 'LOCK_UNAVAILABLE')
    } finally {
      blocker.exec('ROLLBACK')
      blocker.close()
    }
  } finally {
    await fixture.dispose()
  }
})

test('refuses destination overwrite, empty dest, and concurrent exclusive publish', async () => {
  const fixture = await createNativeBackupFixture()
  try {
    const destination = join(fixture.root, 'archive')
    await backupNativeRuntime({
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
      destination,
    })
    await expectCode(() => backupNativeRuntime({
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
      destination,
    }), 'DESTINATION_EXISTS')

    const emptyDest = join(fixture.root, 'empty-dest')
    await mkdir(emptyDest)
    await expectCode(() => backupNativeRuntime({
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
      destination: emptyDest,
    }), 'DESTINATION_EXISTS')

    const concurrent = join(fixture.root, 'concurrent')
    const firstStaging = await createBackupStagingDirectory(fixture.root)
    const secondStaging = await createBackupStagingDirectory(fixture.root)
    await writeFile(join(firstStaging, 'MANIFEST.json'), '{}\n')
    await writeFile(join(secondStaging, 'MANIFEST.json'), '{}\n')
    const settled = await Promise.allSettled([
      publishStagedDirectory({ stagingPath: firstStaging, destination: concurrent }),
      publishStagedDirectory({ stagingPath: secondStaging, destination: concurrent }),
    ])
    const fulfilled = settled.filter((item) => item.status === 'fulfilled')
    const rejected = settled.filter((item) => item.status === 'rejected')
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    const rejectedError = (rejected[0] as PromiseRejectedResult).reason
    assert.equal(isNativeBackupError(rejectedError) ? rejectedError.code : '', 'DESTINATION_EXISTS')
  } finally {
    await fixture.dispose()
  }
})

test('refuses restore to a different absolute path and rejects symlink sources', async () => {
  const fixture = await createNativeBackupFixture()
  try {
    const destination = join(fixture.root, 'archive')
    await backupNativeRuntime({
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
      destination,
    })
    const otherRoot = join(fixture.root, 'other-runtime')
    await expectCode(() => restoreNativeRuntime({
      archivePath: destination,
      databasePath: join(otherRoot, 'yanxing.sqlite'),
      storageRoot: join(otherRoot, 'reports'),
    }), 'PATH_MISMATCH')

    await symlink(fixture.livePath, join(fixture.storageRoot, 'link.docx'))
    await expectCode(() => backupNativeRuntime({
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
      destination: join(fixture.root, 'archive-symlink'),
    }), 'SYMLINK_REJECTED')
  } finally {
    await fixture.dispose()
  }
})

test('refuses unmanaged knowledge roots and outside-root knowledge files', async () => {
  const fixture = await createNativeBackupFixture()
  try {
    process.env.YANXING_KNOWLEDGE_STORAGE_ROOT = join(fixture.root, 'external-knowledge')
    await expectCode(() => backupNativeRuntime({
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
      destination: join(fixture.root, 'archive-knowledge'),
    }), 'UNMANAGED_PATH')
    delete process.env.YANXING_KNOWLEDGE_STORAGE_ROOT
    fixture.database.prepare("UPDATE knowledge_items SET source_path = ? WHERE id = 'knowledge-1'").run(join(fixture.root, 'outside.pdf'))
    await expectCode(() => backupNativeRuntime({
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
      destination: join(fixture.root, 'archive-outside'),
    }), 'UNMANAGED_PATH')
  } finally {
    await fixture.dispose()
  }
})

test('refuses backup when referenced files are missing or hash/size disagree, including tombstones, and when a restore marker is present', async () => {
  const fixture = await createNativeBackupFixture()
  try {
    const missingDest = join(fixture.root, 'archive-missing')
    await rm(fixture.livePath)
    await expectCode(() => backupNativeRuntime({
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
      destination: missingDest,
    }), 'MISSING_FILE')
    assert.equal(existsSync(missingDest), false)
    await writeFile(fixture.livePath, 'live-report-body')

    await writeFile(fixture.livePath, 'corrupted-live-report')
    await expectCode(() => backupNativeRuntime({
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
      destination: join(fixture.root, 'archive-live-tamper'),
    }), 'SOURCE_INTEGRITY')
    await writeFile(fixture.livePath, 'live-report-body')

    await writeFile(fixture.tombstonePath, 'corrupted-tombstone-report')
    await expectCode(() => backupNativeRuntime({
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
      destination: join(fixture.root, 'archive-tombstone-tamper'),
    }), 'SOURCE_INTEGRITY')
    await writeFile(fixture.tombstonePath, 'tombstone-report-body')

    await createRestoreIncompleteMarker(fixture.runtimeRoot)
    await expectCode(() => backupNativeRuntime({
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
      destination: join(fixture.root, 'archive-marker'),
    }), 'RESTORE_INCOMPLETE')
    assert.equal(existsSync(join(fixture.root, 'archive-marker')), false)
    assert.equal(incompleteRestoreMarkerPresent(fixture.runtimeRoot), true)
  } finally {
    await fixture.dispose()
  }
})

test('restore refuses when staged database file identities disagree with the manifest', async () => {
  const fixture = await createNativeBackupFixture()
  try {
    const destination = join(fixture.root, 'archive')
    await backupNativeRuntime({
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
      destination,
    })
    const archiveDatabase = join(destination, 'database', 'yanxing.sqlite')
    const archive = new DatabaseSync(archiveDatabase)
    try {
      archive.exec('DROP TRIGGER IF EXISTS report_submissions_protect_immutable_fields')
      archive.prepare("UPDATE report_submissions SET file_hash = ? WHERE id = 'report-live'").run('0'.repeat(64))
    } finally {
      archive.close()
    }
    const hashed = await hashRegularFile(archiveDatabase)
    const manifestPath = join(destination, 'MANIFEST.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown> & {
      database: { sha256: string; sizeBytes: number }
      keyVerifier?: string
      manifestMac?: string
    }
    manifest.database = { ...manifest.database, sha256: hashed.sha256, sizeBytes: hashed.sizeBytes }
    const payload = { ...manifest }
    delete payload.keyVerifier
    delete payload.manifestMac
    const mac = authenticateBackupManifest(payload, Buffer.from(BACKUP_FIXTURE_KEY))
    await writeFile(manifestPath, JSON.stringify({ ...payload, ...mac }, null, 2))
    fixture.database.close()
    await rm(fixture.runtimeRoot, { recursive: true, force: true })
    await expectCode(() => restoreNativeRuntime({
      archivePath: destination,
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
    }), 'SOURCE_INTEGRITY')
    assert.equal(existsSync(fixture.runtimeRoot), false)
  } finally {
    await fixture.dispose()
  }
})

test('requires an explicit key and rejects a tampered HMAC payload even after re-signing identity', async () => {
  const fixture = await createNativeBackupFixture()
  try {
    const destination = join(fixture.root, 'archive')
    await backupNativeRuntime({
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
      destination,
    })
    const previous = process.env.YANXING_SETTINGS_ENCRYPTION_KEY
    delete process.env.YANXING_SETTINGS_ENCRYPTION_KEY
    await expectCode(() => backupNativeRuntime({
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
      destination: join(fixture.root, 'archive-nokey'),
    }), 'KEY_REQUIRED')
    process.env.YANXING_SETTINGS_ENCRYPTION_KEY = previous

    const manifestPath = join(destination, 'MANIFEST.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown> & {
      identity: { name: string; checksum: string; initializedAt: string }
      keyVerifier?: string
      manifestMac?: string
    }
    manifest.identity = { ...manifest.identity, checksum: '0'.repeat(64) }
    const payload = { ...manifest }
    delete payload.keyVerifier
    delete payload.manifestMac
    const mac = authenticateBackupManifest(payload, Buffer.from(BACKUP_FIXTURE_KEY))
    await writeFile(manifestPath, JSON.stringify({ ...payload, ...mac }, null, 2))
    fixture.database.close()
    await rm(fixture.runtimeRoot, { recursive: true, force: true })
    await expectCode(() => restoreNativeRuntime({
      archivePath: destination,
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
    }), 'IDENTITY_MISMATCH')
  } finally {
    await fixture.dispose()
  }
})

test('rejects a --key-file nested inside runtime reports or the archive', async () => {
  const fixture = await createNativeBackupFixture()
  try {
    const nested = join(fixture.storageRoot, 'key.txt')
    await writeFile(nested, BACKUP_FIXTURE_KEY)
    await expectCode(() => backupNativeRuntime({
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
      destination: join(fixture.root, 'archive'),
      keyFile: nested,
    }), 'MASTER_KEY_FORBIDDEN')
    assert.equal(existsSync(join(fixture.root, 'archive')), false)

    const destination = join(fixture.root, 'archive')
    await backupNativeRuntime({
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
      destination,
    })
    const archiveKey = join(destination, 'key.txt')
    await writeFile(archiveKey, BACKUP_FIXTURE_KEY)
    fixture.database.close()
    await rm(fixture.runtimeRoot, { recursive: true, force: true })
    await expectCode(() => restoreNativeRuntime({
      archivePath: destination,
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
      keyFile: archiveKey,
    }), 'MASTER_KEY_FORBIDDEN')
    assert.equal(existsSync(fixture.runtimeRoot), false)
  } finally {
    await fixture.dispose()
  }
})

test('backup CLI loads env files while preserving explicit key precedence',async()=>{
  const fixture=await createNativeBackupFixture()
  try {
    const entry=fileURLToPath(new URL('../scripts/native-backup.ts',import.meta.url))
    const env:NodeJS.ProcessEnv={...process.env,NODE_ENV:'development'}
    delete env.NODE_TEST_CONTEXT
    delete env.YANXING_SETTINGS_ENCRYPTION_KEY
    await writeFile(join(fixture.root,'.env.local'),'YANXING_SETTINGS_ENCRYPTION_KEY='+BACKUP_FIXTURE_KEY+'\n')
    const run=(name:string,environment:NodeJS.ProcessEnv,extra:string[]=[])=>spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),entry,'backup','--database',fixture.databasePath,'--storage-root',fixture.storageRoot,'--destination',join(fixture.root,name),...extra],{cwd:fixture.root,env:environment,encoding:'utf8',timeout:15000})
    const loaded=run('env-file',env)
    assert.equal(loaded.status,0,loaded.stderr)
    const wrong=run('process-wins',{...env,YANXING_SETTINGS_ENCRYPTION_KEY:'wrong-process-key'})
    assert.equal(wrong.status,1)
    const keyFile=join(fixture.root,'external-key')
    await writeFile(keyFile,BACKUP_FIXTURE_KEY)
    const explicit=run('key-file-wins',{...env,YANXING_SETTINGS_ENCRYPTION_KEY:'wrong-process-key'},['--key-file',keyFile])
    assert.equal(explicit.status,0,explicit.stderr)
    await rm(join(fixture.root,'.env.local'))
    await writeFile(join(fixture.runtimeRoot,'.settings-key'),BACKUP_FIXTURE_KEY)
    assert.equal(run('no-implicit-fallback',env).status,1)
  } finally {await fixture.dispose()}
})

test('CLI requires explicit paths and rejects --force', async () => {
  expectThrownCode(() => parseNativeBackupCli(['backup']), 'EXPLICIT_PATH_REQUIRED')
  expectThrownCode(() => parseNativeBackupCli(['backup', '--database', '/tmp/db.sqlite']), 'EXPLICIT_PATH_REQUIRED')
  expectThrownCode(() => parseNativeBackupCli(['backup', '--database', '/tmp/db.sqlite', '--storage-root', '/tmp/reports', '--destination', '/tmp/out', '--force', '1']), 'EXPLICIT_PATH_REQUIRED')
  const code = await runNativeBackupCli(['restore'])
  assert.equal(code, 1)
})

test('CLI rejects unknown, inapplicable, duplicate and empty flags', () => {
  const required = ['--database', '/tmp/db.sqlite', '--storage-root', '/tmp/reports', '--destination', '/tmp/out']
  expectThrownCode(() => parseNativeBackupCli(['backup', ...required, '--dry-run', 'true']), 'EXPLICIT_PATH_REQUIRED')
  expectThrownCode(() => parseNativeBackupCli(['backup', ...required, '--archive', '/tmp/archive']), 'EXPLICIT_PATH_REQUIRED')
  expectThrownCode(() => parseNativeBackupCli(['backup', '--database', '/tmp/db.sqlite', '--database', '/tmp/other.sqlite', '--storage-root', '/tmp/reports', '--destination', '/tmp/out']), 'EXPLICIT_PATH_REQUIRED')
  expectThrownCode(() => parseNativeBackupCli(['restore', '--archive', '/tmp/archive', '--database', '/tmp/db.sqlite', '--storage-root', '/tmp/reports', '--destination', '/tmp/out']), 'EXPLICIT_PATH_REQUIRED')
  expectThrownCode(() => parseNativeBackupCli(['backup', ...required, '--key-file', '']), 'EXPLICIT_PATH_REQUIRED')
  expectThrownCode(() => parseNativeBackupCli(['backup', ...required, '--key-file', '   ']), 'EXPLICIT_PATH_REQUIRED')
})

test('interrupted restore leaves a durable marker and default startup refuses without clearing the partial target', async () => {
  const fixture = await createNativeBackupFixture()
  try {
    const destination = join(fixture.root, 'archive')
    await backupNativeRuntime({
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
      destination,
    })
    fixture.database.close()
    await rm(fixture.runtimeRoot, { recursive: true, force: true })
    await assert.rejects(
      () => restoreNativeRuntime({
        archivePath: destination,
        databasePath: fixture.databasePath,
        storageRoot: fixture.storageRoot,
        publicationFault: {
          afterDestinationCreated: async () => {
            throw new RestorePublicationInterruptedError('destination-created')
          },
        },
      }),
      (error: unknown) => error instanceof RestorePublicationInterruptedError,
    )
    assert.equal(existsSync(fixture.runtimeRoot), true)
    assert.equal(existsSync(fixture.databasePath), false)
    assert.equal(incompleteRestoreMarkerPresent(fixture.runtimeRoot), true)
    await assert.rejects(runDatabaseOpen(fixture.databasePath), new RegExp(NATIVE_SCHEMA_PUBLIC_MESSAGES.RESTORE_INCOMPLETE))
    assert.equal(existsSync(fixture.runtimeRoot), true)
    assert.equal(existsSync(fixture.databasePath), false)
    assert.equal(existsSync(restoreIncompleteMarkerPath(fixture.runtimeRoot)), true)
    await expectCode(() => restoreNativeRuntime({
      archivePath: destination,
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
    }), 'TARGET_OCCUPIED')
    assert.equal(incompleteRestoreMarkerPresent(fixture.runtimeRoot), true)
    const failure = publicNativeSchemaFailure(new NativeSchemaError('RESTORE_INCOMPLETE'))
    assert.equal(failure.code, 'RESTORE_INCOMPLETE')
    assert.equal(failure.error, NATIVE_SCHEMA_PUBLIC_MESSAGES.RESTORE_INCOMPLETE)
  } finally {
    await fixture.dispose()
  }
})

test('interrupted restore after the first moved child still refuses startup and does not auto-clear', async () => {
  const fixture = await createNativeBackupFixture()
  try {
    const destination = join(fixture.root, 'archive')
    await backupNativeRuntime({
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
      destination,
    })
    fixture.database.close()
    await rm(fixture.runtimeRoot, { recursive: true, force: true })
    await assert.rejects(
      () => restoreNativeRuntime({
        archivePath: destination,
        databasePath: fixture.databasePath,
        storageRoot: fixture.storageRoot,
        publicationFault: {
          afterFirstChildMoved: async () => {
            throw new RestorePublicationInterruptedError('first-child-moved')
          },
        },
      }),
      (error: unknown) => error instanceof RestorePublicationInterruptedError,
    )
    assert.equal(existsSync(fixture.runtimeRoot), true)
    assert.equal(incompleteRestoreMarkerPresent(fixture.runtimeRoot), true)
    await assert.rejects(runDatabaseOpen(fixture.databasePath), new RegExp(NATIVE_SCHEMA_PUBLIC_MESSAGES.RESTORE_INCOMPLETE))
    assert.equal(existsSync(fixture.runtimeRoot), true)
    assert.equal(incompleteRestoreMarkerPresent(fixture.runtimeRoot), true)
  } finally {
    await fixture.dispose()
  }
})

test('restore rejects an incomplete archive that never published MANIFEST last', async () => {
  const fixture = await createNativeBackupFixture()
  try {
    const destination = join(fixture.root, 'archive')
    await assert.rejects(
      () => backupNativeRuntime({
        databasePath: fixture.databasePath,
        storageRoot: fixture.storageRoot,
        destination,
        publicationFault: {
          afterFirstChildMoved: async () => {
            throw new RestorePublicationInterruptedError('first-child-moved')
          },
        },
      }),
      (error: unknown) => error instanceof RestorePublicationInterruptedError,
    )
    assert.equal(existsSync(destination), true)
    assert.equal(existsSync(join(destination, 'MANIFEST.json')), false)
    fixture.database.close()
    await rm(fixture.runtimeRoot, { recursive: true, force: true })
    await expectCode(() => restoreNativeRuntime({
      archivePath: destination,
      databasePath: fixture.databasePath,
      storageRoot: fixture.storageRoot,
    }), 'ARCHIVE_INVALID')
    assert.equal(existsSync(fixture.runtimeRoot), false)
    assert.equal(existsSync(destination), true)
  } finally {
    await fixture.dispose()
  }
})

const databaseProcessPath = fileURLToPath(new URL('./fixtures/database-process.ts', import.meta.url))
const tsxLoader = import.meta.resolve('tsx')

function runDatabaseOpen(databasePath: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsxLoader, databaseProcessPath, 'database-open'], {
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
      else reject(new Error('database open exited with ' + code + ': ' + stderr))
    })
  })
}

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { createFakeNextDistProject, createFakeReleaseRoot } from './helpers/p5-release-acceptance.mjs'
import {
  FAKE_STABLE_MASTER_KEY,
  LEGACY_SCHEMA_MARKERS,
  NATIVE_SCHEMA_NAME,
  P5AcceptanceError,
  assertSuccessfulWorkerOutcome,
  buildIsolatedProcessEnv,
  closeProviderFixture,
  collectSecretValues,
  createIsolatedWorkspace,
  createSuccessDocuments,
  isPidAlive,
  parseArgs,
  readSchemaIdentity,
  recordReleaseIdentity,
  redactSecrets,
  reserveLoopbackPort,
  resolveCliPaths,
  resolveReleaseArtifacts,
  serializeAcceptanceResult,
  spawnManagedChild,
  startReleaseProviderFixture,
  stopManagedChildren,
  usage,
  waitForWebHealth,
  waitForWorkerReady,
  waitForWorkerHeartbeat,
  validReleaseAnalysisPayload,
  validReleaseInsightHtml,
} from '../scripts/p5-release-acceptance.mjs'
import {
  assertTaskProbePreserved,
  buildNativeBackupCliArgs,
  classifyNativeBackupFailure,
  inspectIsolatedQuiescence,
  parseBackupCliJson,
  preserveRuntimeRootAside,
  readPublishedRestoreProbe,
  resolveBackupCli,
  restoreIncompleteMarkerPath,
  summarizeTaskProbe,
} from '../scripts/p5-backup-restore.mjs'

const scriptPath = fileURLToPath(new URL('../scripts/p5-release-acceptance.mjs', import.meta.url))

async function withTempDir(prefix, fn) {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('usage names isolated release-root, compiled worker, and credential redaction', () => {
  const text = usage()
  assert.match(text, /--release-root/)
  assert.match(text, /--artifact-path/)
  assert.match(text, /server\.js/)
  assert.match(text, /\.runtime/)
  assert.match(text, /\.next-p5-qa/)
  assert.match(text, /loopback|127\.0\.0\.1|Loopback/)
  assert.match(text, /never appear/)
  assert.match(text, /--with-backup-restore/)
  assert.match(text, /NOT_QUIESCENT/)
  assert.doesNotMatch(text, /YANXING_SETTINGS_ENCRYPTION_KEY=/)
})

test('parseArgs requires explicit artifact flags and rejects unknown options', () => {
  assert.deepEqual(parseArgs(['--help']), { help: true, releaseRoot: undefined, artifactPath: undefined, withBackupRestore: false })
  assert.deepEqual(parseArgs(['--release-root', '/tmp/candidate']), {
    help: false,
    releaseRoot: '/tmp/candidate',
    artifactPath: undefined,
    withBackupRestore: false,
  })
  assert.deepEqual(parseArgs(['--artifact-path=.next-p5-qa', '--with-backup-restore']), {
    help: false,
    releaseRoot: undefined,
    artifactPath: '.next-p5-qa',
    withBackupRestore: true,
  })
  assert.throws(() => parseArgs(['--cleanup']), /未知参数/)
  assert.throws(() => parseArgs(['--release-root']), /缺少路径/)
})

test('resolveCliPaths prefers --release-root and rejects a missing path', () => {
  assert.throws(() => resolveCliPaths({ help: false }, {}), /必须通过/)
  assert.deepEqual(
    resolveCliPaths({ releaseRoot: undefined, artifactPath: undefined }, { YANXING_P5_ARTIFACT_PATH: '.next-p5-qa' }),
    { releaseRoot: undefined, artifactPath: '.next-p5-qa', withBackupRestore: false },
  )
  assert.deepEqual(
    resolveCliPaths(
      { releaseRoot: '/cand', artifactPath: '.next-p4-qa' },
      { YANXING_P5_RELEASE_ROOT: '/env-cand' },
    ),
    { releaseRoot: '/cand', artifactPath: '.next-p4-qa', withBackupRestore: false },
  )
  assert.equal(
    resolveCliPaths({ releaseRoot: '/cand' }, { YANXING_P5_WITH_BACKUP_RESTORE: 'true' }).withBackupRestore,
    true,
  )
})

test('resolveReleaseArtifacts reads standalone server.js, .next-p5-qa snapshot, and default Worker', async () => {
  await withTempDir('p5-artifacts-', async (root) => {
    await createFakeReleaseRoot(root, { buildId: 'build-standalone' })
    const artifacts = resolveReleaseArtifacts({ releaseRoot: root, projectRoot: root })
    assert.equal(artifacts.kind, 'standalone')
    assert.equal(artifacts.webKind, 'server.js')
    assert.equal(artifacts.nextDistDirName, '.next-p5-qa')
    assert.equal(artifacts.nextBuildId, 'build-standalone')
    assert.equal(artifacts.webCwd, root)
    assert.equal(artifacts.workerCwd, root)
    assert.match(artifacts.workerScript, /worker\/index\.mjs$/)
    const identity = await recordReleaseIdentity(artifacts)
    assert.equal(identity.nextBuildId, 'build-standalone')
    assert.equal(identity.hashes.worker.length, 64)
    assert.equal(identity.hashes.server.length, 64)
  })
})

test('resolveReleaseArtifacts falls back to next start for a plain production dist', async () => {
  await withTempDir('p5-nextdist-', async (root) => {
    const fake = await createFakeNextDistProject(root)
    const artifacts = resolveReleaseArtifacts({ artifactPath: fake.distDir, projectRoot: root })
    assert.equal(artifacts.kind, 'next-start')
    assert.equal(artifacts.webKind, 'next start')
    assert.equal(artifacts.nextBuildId, 'p4-fake-build-id')
    assert.match(artifacts.webScript, /next\/dist\/bin\/next$/)
    assert.deepEqual(artifacts.webArgs.slice(0, 3), ['start', '--hostname', '127.0.0.1'])
  })
})

test('resolveReleaseArtifacts uses nested standalone under a .next-p5-qa dist', async () => {
  await withTempDir('p5-nested-', async (root) => {
    const dist = path.join(root, '.next-p5-qa')
    await mkdir(dist, { recursive: true })
    await writeFile(path.join(dist, 'BUILD_ID'), 'nested-build\n')
    await writeFile(path.join(dist, 'required-server-files.json'), '{"config":{"distDir":".next-p5-qa"}}\n')
    await createFakeReleaseRoot(path.join(dist, 'standalone'), { buildId: 'nested-build' })
    const artifacts = resolveReleaseArtifacts({ artifactPath: dist, projectRoot: root })
    assert.equal(artifacts.kind, 'standalone')
    assert.equal(artifacts.webCwd, path.join(dist, 'standalone'))
    assert.equal(artifacts.nextBuildId, 'nested-build')
  })
})

test('isolated env uses a fake master key, loopback, and compiled runtime without paid keys', async () => {
  await withTempDir('p5-env-', async (root) => {
    const isolated = await createIsolatedWorkspace({ tmpdir: root })
    isolated.webPort = 34567
    const artifacts = {
      nextDistDirName: '.next-p5-qa',
    }
    const env = buildIsolatedProcessEnv({ isolated, artifacts })
    assert.equal(env.HOSTNAME, '127.0.0.1')
    assert.equal(env.PORT, '34567')
    assert.equal(env.YANXING_SETTINGS_ENCRYPTION_KEY, FAKE_STABLE_MASTER_KEY)
    assert.equal(env.YANXING_COMPILED_RUNTIME, '1')
    assert.equal(env.YANXING_CHAT_COMPLETIONS_API_KEY, '')
    assert.equal(env.YANXING_INSTANCE_TOKEN, isolated.instanceToken)
    assert.ok(env.YANXING_DATABASE_PATH.startsWith(isolated.root))
    assert.ok(env.YANXING_WORKER_HEARTBEAT_PATH.startsWith(isolated.root))
    assert.ok(env.YANXING_WORKER_READY_PATH.startsWith(isolated.root))
    assert.notEqual(env.YANXING_ADMIN_PASSWORD, FAKE_STABLE_MASTER_KEY)
    assert.equal(Object.hasOwn(env, 'YANXING_OPENAI_API_KEY'), false)
  })
})

test('redaction strips credentials from logs, manifests, and serialized results', () => {
  const isolated = {
    adminPassword: 'super-secret-admin-pass-123',
    masterKey: FAKE_STABLE_MASTER_KEY,
  }
  const secrets = collectSecretValues(isolated)
  const payload = {
    ok: true,
    password: isolated.adminPassword,
    nested: { apiKey: 'deployment-smoke-key', note: `key=${FAKE_STABLE_MASTER_KEY}` },
    logs: [`password=${isolated.adminPassword}`],
  }
  const serialized = serializeAcceptanceResult(payload, secrets)
  assert.doesNotMatch(serialized, /super-secret-admin-pass-123/)
  assert.doesNotMatch(serialized, /p5-release-acceptance-fake-stable-master-key/)
  assert.doesNotMatch(serialized, /deployment-smoke-key/)
  assert.match(serialized, /\[redacted\]/)
  assert.equal(redactSecrets(payload, secrets).password, '[redacted]')
})

test('schema identity rejects legacy tables and migrations', async () => {
  await withTempDir('p5-schema-', async (root) => {
    const nativePath = path.join(root, 'native.sqlite')
    const native = new DatabaseSync(nativePath)
    native.exec(`
      CREATE TABLE native_schema_identity (id INTEGER PRIMARY KEY, name TEXT, checksum TEXT, initialized_at TEXT);
      CREATE TABLE users (id TEXT);
      INSERT INTO native_schema_identity(id, name, checksum, initialized_at) VALUES (1, '${NATIVE_SCHEMA_NAME}', 'abc123', '2026-01-01T00:00:00.000Z');
    `)
    native.close()
    const identity = readSchemaIdentity(nativePath)
    assert.equal(identity.name, NATIVE_SCHEMA_NAME)
    assert.equal(identity.checksum, 'abc123')
    assert.deepEqual(identity.legacyTables, [])

    const legacyPath = path.join(root, 'legacy.sqlite')
    const legacy = new DatabaseSync(legacyPath)
    legacy.exec(`
      CREATE TABLE schema_migrations (id INTEGER);
      CREATE TABLE analysis_jobs (id TEXT);
      CREATE TABLE native_schema_identity (id INTEGER PRIMARY KEY, name TEXT, checksum TEXT, initialized_at TEXT);
      INSERT INTO native_schema_identity(id, name, checksum, initialized_at) VALUES (1, '${NATIVE_SCHEMA_NAME}', 'abc123', '2026-01-01T00:00:00.000Z');
    `)
    legacy.close()
    assert.throws(() => readSchemaIdentity(legacyPath), /遗留表|schema_migrations/)
    assert.ok(LEGACY_SCHEMA_MARKERS.includes('analysis_jobs'))
  })
})

test('success documents use previewable DOCX plus PDF bytes', () => {
  const documents = createSuccessDocuments('marker-1')
  assert.equal(documents.pdf.kind, 'PDF')
  assert.equal(documents.docx.kind, 'DOCX')
  assert.match(documents.pdf.fileName, /\.pdf$/)
  assert.match(documents.docx.fileName, /\.docx$/)
  assert.equal(documents.pdf.sha256.length, 64)
  assert.ok(documents.docx.bytes.includes(Buffer.from('_rels/.rels')))
})

test('provider fixture fails then returns complete analysis JSON and insight HTML', async () => {
  const fixture = await startReleaseProviderFixture({
    host: '127.0.0.1',
    mode: 'fail',
    failureMessage: 'expected-failure-token-xyz',
  })
  try {
    assert.equal(fixture.server.address().address, '127.0.0.1')
    assert.notEqual(fixture.server.address().address, '0.0.0.0')
    const fail = await fetch(`http://127.0.0.1:${fixture.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    })
    assert.equal(fail.status, 400)
    assert.equal((await fail.json()).error.message, 'expected-failure-token-xyz')

    fixture.setMode('succeed')
    const analysis = await fetch(`http://127.0.0.1:${fixture.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [], response_format: { type: 'json_object' } }),
    })
    assert.equal(analysis.status, 200)
    const analysisBody = await analysis.json()
    assert.equal(analysisBody.choices[0].finish_reason, 'stop')
    const payload = JSON.parse(analysisBody.choices[0].message.content)
    assert.equal(payload['综合评分'].研究价值, validReleaseAnalysisPayload()['综合评分'].研究价值)
    assert.equal(payload['词云'].length, 50)
    assert.equal(payload['报告详情'].章节[0].标题, '正文')
    assert.equal(payload['热力图'][0].章节, '正文')
    assert.ok(Array.isArray(payload['AI建议']))

    const insight = await fetch(`http://127.0.0.1:${fixture.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    })
    const insightBody = await insight.json()
    assert.equal(insightBody.choices[0].message.content, validReleaseInsightHtml())
  } finally {
    await closeProviderFixture(fixture)
  }
})

test('assertSuccessfulWorkerOutcome requires completed analysis, insight, snapshot, and html', () => {
  const ok = {
    analysisTask: { id: 'a1', status: 'completed', reportId: 'r1' },
    insightTask: { id: 'i1', status: 'completed' },
    detail: { id: 'r1', snapshot: { aiScore: { overall: 80 } }, insight: { html: '<p>ok</p>' } },
  }
  const outcome = assertSuccessfulWorkerOutcome(ok)
  assert.equal(outcome.status, 'completed')
  assert.equal(outcome.hasSnapshot, true)

  assert.throws(() => assertSuccessfulWorkerOutcome({
    ...ok,
    analysisTask: { ...ok.analysisTask, status: 'failed', errorCode: 'MODEL_EXECUTION_FAILED' },
  }), /期望 completed/)
  assert.throws(() => assertSuccessfulWorkerOutcome({
    ...ok,
    detail: { id: 'r1', insight: { html: '<p>ok</p>' } },
  }), /分析快照/)
  assert.throws(() => assertSuccessfulWorkerOutcome({
    analysisTask: { id: 'a1', status: 'failed', errorCode: 'Cannot find module parser' },
    insightTask: { id: 'i1', status: 'failed' },
    detail: ok.detail,
  }), /解析子进程失败/)
})

test('managed children are always killed in finally', async () => {
  const children = new Set()
  const logs = []
  const record = spawnManagedChild({
    name: 'hold',
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 10000)'],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
    children,
    logs,
    secrets: [],
  })
  assert.ok(isPidAlive(record.pid))
  try {
    throw new Error('force cleanup')
  } catch {
    await stopManagedChildren(children, { graceMs: 2_000 })
  }
  assert.equal(isPidAlive(record.pid), false)
  assert.equal(children.size, 0)
})

test('readiness waits promptly report a signalled child instead of timing out', async () => {
  const record = spawnManagedChild({
    name: 'signalled', command: process.execPath,
    args: ['-e', 'process.kill(process.pid, "SIGTERM")'],
    cwd: process.cwd(), env: {}, children: new Set(), logs: [], secrets: [],
  })
  await record.completion
  assert.equal(record.child.exitCode, null)
  assert.equal(record.child.signalCode, 'SIGTERM')
  const options = { child: record.child, timeoutMs: 500, pollMs: 10 }
  const started = Date.now()
  await assert.rejects(waitForWebHealth('http://127.0.0.1:1', options), /退出（SIGTERM）/)
  await assert.rejects(waitForWorkerReady({ ...options, readyPath: '/missing-p5-ready', instanceToken: 'test' }), /退出（SIGTERM）/)
  await assert.rejects(waitForWorkerHeartbeat('/missing-p5-heartbeat', options), /退出（SIGTERM）/)
  assert.ok(Date.now() - started < 500)
})

test('successful commands and graceful cleanup do not leave parent timeout timers alive', () => {
  for (const operation of [
    `await runForegroundCommand({ command: process.execPath, args: ['-e', ''], secrets: [], label: 'short', timeoutMs: 60_000 })`,
    `const children = new Set();
     spawnManagedChild({ name: 'hold', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], children, logs: [], secrets: [] });
     await stopManagedChildren(children, { graceMs: 60_000 })`,
  ]) {
    const code = `import { runForegroundCommand, spawnManagedChild, stopManagedChildren } from ${JSON.stringify(new URL('../scripts/p5-release-acceptance.mjs', import.meta.url).href)}; ${operation}`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 3_000 })
    assert.equal(result.error, undefined, result.error?.message)
    assert.equal(result.status, 0, result.stderr)
  }
})

test('CLI --help exits 0 and missing artifact path exits 2', () => {
  const help = spawnSync(process.execPath, [scriptPath, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /--release-root/)
  assert.match(help.stdout, /--with-backup-restore/)
  const missing = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', env: { ...process.env, YANXING_P5_RELEASE_ROOT: '', YANXING_P5_ARTIFACT_PATH: '' } })
  assert.equal(missing.status, 2)
  assert.match(`${missing.stdout}${missing.stderr}`, /--release-root|--artifact-path/)
  assert.doesNotMatch(`${missing.stdout}${missing.stderr}`, /p5-release-acceptance-fake-stable-master-key/)
})

test('CLI rejects a missing release-root without starting a server', async () => {
  await withTempDir('p5-missing-', async (root) => {
    const missing = spawnSync(process.execPath, [scriptPath, '--release-root', path.join(root, 'nope')], {
      encoding: 'utf8',
    })
    assert.equal(missing.status, 2)
    assert.match(`${missing.stdout}${missing.stderr}`, /server\.js|找不到/)
  })
})

test('reserveLoopbackPort binds 127.0.0.1', async () => {
  const port = await reserveLoopbackPort()
  assert.ok(Number.isInteger(port) && port > 0)
})

test('backup CLI resolution prefers compiled native-backup then tsx source', async () => {
  await withTempDir('p5-backup-cli-', async (root) => {
    await createFakeReleaseRoot(root, { includeBackupCli: true })
    const artifacts = resolveReleaseArtifacts({ releaseRoot: root, projectRoot: root })
    const compiled = resolveBackupCli({ artifacts, projectRoot: root })
    assert.equal(compiled.kind, 'compiled')
    assert.match(compiled.script, /native-backup\.mjs$/)
  })
  const projectRoot = fileURLToPath(new URL('..', import.meta.url))
  await withTempDir('p5-backup-source-', async (root) => {
    await createFakeReleaseRoot(root, { includeBackupCli: false })
    const artifacts = resolveReleaseArtifacts({ releaseRoot: root, projectRoot: root })
    const source = resolveBackupCli({ artifacts, projectRoot })
    assert.equal(source.kind, 'tsx-source')
    assert.match(source.script, /native-backup\.ts$/)
    assert.deepEqual(source.argsPrefix.slice(0, 2), ['--import', 'tsx'])
  })
  assert.throws(
    () => resolveBackupCli({ artifacts: { runtimeRoot: '/tmp/missing-runtime' }, projectRoot: '/tmp/missing-project' }),
    /找不到 native-backup CLI/,
  )
})

test('NOT_QUIESCENT and restore-incomplete failures are classified without faking expiry', () => {
  assert.equal(
    classifyNativeBackupFailure('存在活动任务、未完成上传或配额预留，拒绝在线备份；请停止 Web/Worker 后再试。'),
    'NOT_QUIESCENT',
  )
  assert.equal(classifyNativeBackupFailure('native-backup 失败（exit 1）：NOT_QUIESCENT'), 'NOT_QUIESCENT')
  assert.equal(classifyNativeBackupFailure('检测到未完成的原生恢复。当前进程拒绝打开或初始化数据库。'), 'RESTORE_INCOMPLETE')
  const parsed = parseBackupCliJson('noise\n{\n  "action": "backup",\n  "counts": { "files": 2 }\n}\n')
  assert.equal(parsed.action, 'backup')
  assert.equal(parsed.counts.files, 2)
})

test('restore probe preserves tasks and call identities while READY uploads stay visible', async () => {
  await withTempDir('p5-task-probe-', async (root) => {
    const databasePath = path.join(root, 'yanxing.sqlite')
    const database = new DatabaseSync(databasePath)
    database.exec(`CREATE TABLE native_schema_identity (name TEXT, checksum TEXT, initialized_at TEXT);
CREATE TABLE submission_task_calls (job_id TEXT, attempt INTEGER, provider TEXT, model TEXT, lease_token TEXT, state TEXT, started_at TEXT, completed_at TEXT);
CREATE TABLE submission_tasks (id TEXT, report_id TEXT, operation TEXT, generation INTEGER, status TEXT, error_code TEXT);
CREATE TABLE report_submissions (id TEXT);
CREATE TABLE report_uploads (status TEXT);
CREATE TABLE storage_reservations (state TEXT);
INSERT INTO native_schema_identity VALUES ('yanxing-native-p3', 'abc', '2026-01-01T00:00:00.000Z');
INSERT INTO submission_task_calls VALUES ('job-1', 1, 'chat_completions', 'model', 'lease-1', 'started', '2026-01-01', NULL);
INSERT INTO submission_task_calls VALUES ('job-2', 1, 'chat_completions', 'model', 'lease-2', 'completed', '2026-01-01', '2026-01-02');
INSERT INTO submission_tasks VALUES ('job-1', 'r1', 'analysis', 1, 'failed', 'AI_CALL_INCOMPLETE');
INSERT INTO submission_tasks VALUES ('job-2', 'r1', 'insight', 1, 'completed', NULL);
INSERT INTO report_submissions VALUES ('r1');
INSERT INTO report_uploads VALUES ('ready');
INSERT INTO storage_reservations VALUES ('released');`)
    database.close()
    assert.deepEqual(inspectIsolatedQuiescence(databasePath), {
      activeUploads: 1, activeTasks: 0, activeReservations: 0,
    })
    const probe = readPublishedRestoreProbe(databasePath)
    assert.deepEqual(summarizeTaskProbe(probe), { taskCount: 2, callCount: 2, incompleteCallCount: 1 })
    const copy = readPublishedRestoreProbe(databasePath)
    assert.doesNotThrow(() => assertTaskProbePreserved(probe, copy))
    for (const field of ['state', 'model', 'lease_token', 'attempt', 'completed_at']) {
      const changed = structuredClone(copy)
      changed.calls[0][field] = 'changed'
      assert.throws(() => assertTaskProbePreserved(probe, changed), /calls/)
    }
    const changed = structuredClone(copy)
    changed.tasks[0].generation = 2
    assert.throws(() => assertTaskProbePreserved(probe, changed), /tasks/)
    assert.throws(() => assertTaskProbePreserved(probe, { ...copy, calls: [] }), /calls/)
  })
})

test('runtime root is renamed aside and restore marker path is a sibling', async () => {
  await withTempDir('p5-rename-', async (root) => {
    const runtimeRoot = path.join(root, 'storage')
    await mkdir(path.join(runtimeRoot, 'reports'), { recursive: true })
    await writeFile(path.join(runtimeRoot, 'yanxing.sqlite'), 'db')
    const preserved = await preserveRuntimeRootAside(runtimeRoot)
    assert.equal(preserved, runtimeRoot + '-pre-restore')
    assert.equal(existsSync(runtimeRoot), false)
    assert.equal(existsSync(path.join(preserved, 'yanxing.sqlite')), true)
    const marker = restoreIncompleteMarkerPath(runtimeRoot)
    const sibling = restoreIncompleteMarkerPath(path.join(root, 'other-storage'))
    const expected = path.join(root, '.yanxing-restore-incomplete-' + createHash('sha256').update(runtimeRoot).digest('hex'))
    assert.equal(marker, expected)
    assert.match(path.basename(marker), /^\.yanxing-restore-incomplete-[0-9a-f]{64}$/)
    assert.equal(path.dirname(marker), root)
    assert.notEqual(marker, sibling)
    assert.notEqual(marker, path.join(root, '.yanxing-restore-incomplete'))
    assert.throws(() => restoreIncompleteMarkerPath('relative-storage'), /绝对运行根/)
  })
})

test('native-backup drill args never include --key-file or --force', () => {
  const layout = {
    databasePath: '/tmp/iso/storage/yanxing.sqlite',
    storageRoot: '/tmp/iso/storage/reports',
    runtimeRoot: '/tmp/iso/storage',
  }
  const archivePath = '/tmp/iso/native-backup-archive'
  const backupArgs = buildNativeBackupCliArgs('backup', layout, archivePath)
  const restoreArgs = buildNativeBackupCliArgs('restore', layout, archivePath)
  for (const args of [backupArgs, restoreArgs]) {
    assert.equal(args.includes('--key-file'), false)
    assert.equal(args.includes('--force'), false)
    assert.ok(args.every((value) => typeof value === 'string' && value.length > 0))
  }
  assert.deepEqual(backupArgs.slice(0, 2), ['--database', layout.databasePath])
  assert.deepEqual(restoreArgs.slice(0, 2), ['--archive', archivePath])
})

test('backup restore result redacts the fake master key', () => {
  const raw = {
    backupRestore: {
      ok: true,
      envHint: FAKE_STABLE_MASTER_KEY,
      reports: [{ id: 'r1', hasSnapshot: true }],
    },
  }
  const serialized = serializeAcceptanceResult(raw, [FAKE_STABLE_MASTER_KEY])
  assert.doesNotMatch(serialized, /p5-release-acceptance-fake-stable-master-key/)
  assert.match(serialized, /\[redacted\]/)
})


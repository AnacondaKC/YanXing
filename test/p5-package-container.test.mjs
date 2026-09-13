import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DOCKER_TIMEOUT_MS,
  P5_CONTAINER_HELP,
  formatDockerCommand,
  formatDockerFailure,
  hashDatabaseArtifact,
  parseP5ContainerArguments,
  redactDockerText,
  registerOwnedContainer,
  rememberSecret,
  resetRememberedSecrets,
  timeoutForDockerArgs,
} from '../scripts/p5-package-container.mjs'

test('docker failures redact encryption keys from args, stdout and stderr', () => {
  resetRememberedSecrets()
  try {
    const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    rememberSecret(secret)
    const args = [
      'run', '-d', '--name', 'yanxing-p5-qa-isolated-boot-1',
      '-e', 'YANXING_SETTINGS_ENCRYPTION_KEY=' + secret,
      'yanxing:p5-qa-isolated',
    ]
    const command = formatDockerCommand(args)
    assert.equal(command.includes(secret), false)
    assert.match(command, /YANXING_SETTINGS_ENCRYPTION_KEY=\[redacted\]/)
    const message = formatDockerFailure({
      args,
      status: 1,
      stdout: 'visible ' + secret,
      stderr: 'YANXING_SETTINGS_ENCRYPTION_KEY=' + secret + ' boom',
      timedOut: false,
    })
    assert.equal(message.includes(secret), false)
    assert.match(message, /YANXING_SETTINGS_ENCRYPTION_KEY=\[redacted\]/)
    assert.match(redactDockerText('YANXING_CHAT_COMPLETIONS_API_KEY=sk-live-secret-value'), /\[redacted\]/)
  } finally {
    resetRememberedSecrets()
  }
})

test('docker child commands have bounded timeouts', () => {
  assert.equal(timeoutForDockerArgs(['build', '-t', 'yanxing:p5-qa-isolated', '.']), DOCKER_TIMEOUT_MS.build)
  assert.equal(timeoutForDockerArgs(['run', '-d', 'yanxing:p5-qa-isolated']), DOCKER_TIMEOUT_MS.run)
  assert.equal(timeoutForDockerArgs(['exec', 'name', 'id']), DOCKER_TIMEOUT_MS.exec)
  assert.equal(timeoutForDockerArgs(['stop', '-t', '100', 'name']), DOCKER_TIMEOUT_MS.stop)
  assert.equal(DOCKER_TIMEOUT_MS.build > 0, true)
  assert.equal(DOCKER_TIMEOUT_MS.run > 0, true)
  assert.equal(DOCKER_TIMEOUT_MS.exec > 0, true)
  assert.equal(DOCKER_TIMEOUT_MS.stop > 100_000, true)
})

test('owned container names are claimed before a run attempt', () => {
  const createdContainers = []
  registerOwnedContainer(createdContainers, 'yanxing-p5-qa-isolated-boot-claimed')
  assert.deepEqual(createdContainers, ['yanxing-p5-qa-isolated-boot-claimed'])
  registerOwnedContainer(createdContainers, 'yanxing-p5-qa-isolated-boot-claimed')
  assert.equal(createdContainers.length, 1)
})

test('container CLI parses candidate root, image tag, report path and help', () => {
  assert.deepEqual(parseP5ContainerArguments(['--help']), { help: true })
  assert.match(P5_CONTAINER_HELP, /--candidate-root/)
  assert.match(P5_CONTAINER_HELP, /--image-tag/)
  assert.match(P5_CONTAINER_HELP, /--report-path/)
  assert.throws(() => parseP5ContainerArguments(['--image-tag', 'latest']), /must not be latest/)
  assert.throws(() => parseP5ContainerArguments(['--image-tag', 'yanxing:latest']), /must not be latest/)
  assert.throws(() => parseP5ContainerArguments(['--unknown']), /Unknown argument/)
  assert.deepEqual(
    parseP5ContainerArguments([
      '--candidate-root', '/tmp/p5-candidate',
      '--image-tag', 'yanxing:p5-qa-isolated-final',
      '--report-path', '/tmp/p5-report.json',
    ]),
    {
      help: false,
      candidateRoot: '/tmp/p5-candidate',
      imageTag: 'yanxing:p5-qa-isolated-final',
      reportPath: '/tmp/p5-report.json',
    },
  )
})

test('legacy database artifact hash covers sqlite and sidecar wal files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yanxing-p5-dbhash-'))
  try {
    const databasePath = path.join(root, 'yanxing.sqlite')
    await writeFile(databasePath, 'sqlite-bytes')
    const first = await hashDatabaseArtifact(databasePath)
    assert.equal(first.length, 64)
    assert.equal(await hashDatabaseArtifact(databasePath), first)
    await writeFile(databasePath + '-wal', 'wal')
    const withWal = await hashDatabaseArtifact(databasePath)
    assert.notEqual(withWal, first)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('P5 role pid listing injects host proc-role-scan without ancestor filtering', async () => {
  const source = await readFile(new URL('../scripts/p5-package-container.mjs', import.meta.url), 'utf8')
  assert.match(source, /proc-role-scan\.mjs/)
  assert.match(source, /'node', '--input-type=module', '-e', script/)
  const fn = source.slice(source.indexOf('async function listRolePids'), source.indexOf('function assertFreshBoot'))
  assert.match(fn, /listProcRoles\(\)/)
  assert.match(fn, /JSON\.stringify\(out\)/)
  assert.doesNotMatch(fn, /isUnderSupervisor|supervisorPids/)
})

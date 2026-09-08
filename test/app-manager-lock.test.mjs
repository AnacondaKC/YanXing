import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const managerPath = fileURLToPath(new URL('../scripts/app-manager.mjs', import.meta.url))
const sentinelName = '.keep-outer-sentinel'

async function withWorkspace(run) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'yanxing-lock-'))
  mkdirSync(path.join(cwd, 'storage'), { recursive: true })
  writeFileSync(path.join(cwd, sentinelName), 'outer')
  try {
    return await run(cwd, path.join(cwd, 'storage', '.yanxing-app.lock'))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

function runStatus(cwd) {
  return spawnSync(process.execPath, [managerPath, 'status'], { cwd, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'development' } })
}

function writeLock(lockPath, content) {
  writeFileSync(lockPath, content)
}

test('live lock owner is not stolen, including over-age locks', async () => {
  await withWorkspace((cwd, lockPath) => {
    const token = process.pid + ':live-lock'
    writeLock(lockPath, token)
    utimesSync(lockPath, new Date(Date.now() - 11 * 60 * 1000), new Date(Date.now() - 11 * 60 * 1000))
    const result = runStatus(cwd)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /已有另一个启动管理命令/)
    assert.equal(readFileSync(lockPath, 'utf8').trim(), token)
    assert.equal(readFileSync(path.join(cwd, sentinelName), 'utf8'), 'outer')
  })
})

test('dead lock owner can be reclaimed after identity recheck', async () => {
  await withWorkspace(async (cwd, lockPath) => {
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'])
    await new Promise((resolve) => dead.once('exit', resolve))
    writeLock(lockPath, dead.pid + ':dead-lock')
    const result = runStatus(cwd)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(requireExists(lockPath), false)
  })
})

function requireExists(lockPath) {
  try {
    readFileSync(lockPath)
    return true
  } catch {
    return false
  }
}

test('empty and unknown identity locks are not stolen', async () => {
  await withWorkspace((cwd, lockPath) => {
    writeLock(lockPath, '')
    const empty = runStatus(cwd)
    assert.notEqual(empty.status, 0)
    assert.equal(readFileSync(lockPath, 'utf8'), '')

    writeLock(lockPath, 'not-a-pid:unknown')
    const unknown = runStatus(cwd)
    assert.notEqual(unknown.status, 0)
    assert.equal(readFileSync(lockPath, 'utf8').trim(), 'not-a-pid:unknown')
  })
})

test('unreadable locks are not stolen', async () => {
  await withWorkspace((cwd, lockPath) => {
    writeLock(lockPath, process.pid + ':secret')
    chmodSync(lockPath, 0)
    try {
      const result = runStatus(cwd)
      assert.notEqual(result.status, 0)
    } finally {
      chmodSync(lockPath, 0o600)
    }
    assert.equal(readFileSync(lockPath, 'utf8').trim(), process.pid + ':secret')
  })
})

test('concurrent status commands do not steal a live lock', async () => {
  await withWorkspace(async (cwd, lockPath) => {
    writeLock(lockPath, process.pid + ':holder')
    const first = spawn(process.execPath, [managerPath, 'status'], { cwd, env: { ...process.env, NODE_ENV: 'development' } })
    const second = spawn(process.execPath, [managerPath, 'status'], { cwd, env: { ...process.env, NODE_ENV: 'development' } })
    const [firstCode, secondCode] = await Promise.all([
      new Promise((resolve) => first.once('close', resolve)),
      new Promise((resolve) => second.once('close', resolve)),
    ])
    assert.notEqual(firstCode, 0)
    assert.notEqual(secondCode, 0)
    assert.equal(readFileSync(lockPath, 'utf8').trim(), process.pid + ':holder')
  })
})

test('status does not delete a lock it does not own', async () => {
  await withWorkspace((cwd, lockPath) => {
    writeLock(lockPath, process.pid + ':status-hold')
    runStatus(cwd)
    assert.equal(readFileSync(lockPath, 'utf8').trim(), process.pid + ':status-hold')
  })
})

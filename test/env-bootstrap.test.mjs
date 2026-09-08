import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { peekAppMode, resolveStartupMode } from '../lib/config/load-env.mjs'

const tsxPath = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url))
const printConfigPath = fileURLToPath(new URL('./fixtures/print-runtime-config.ts', import.meta.url))
const managerPath = fileURLToPath(new URL('../scripts/app-manager.mjs', import.meta.url))
const migratePath = fileURLToPath(new URL('../scripts/migrate.ts', import.meta.url))

async function withEnvWorkspace(files, run) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'yanxing-env-'))
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(path.join(cwd, name), contents)
  }
  try {
    return await run(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

function printConfig(cwd, extraEnv = {}) {
  const env = { ...process.env }
  delete env.NODE_ENV
  delete env.YANXING_DATABASE_PATH
  delete env.YANXING_PORT
  delete env.YANXING_KNOWLEDGE_STORAGE_ROOT
  Object.assign(env, extraEnv)
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key]
  }
  const result = spawnSync(process.execPath, [tsxPath, printConfigPath], {
    cwd,
    encoding: 'utf8',
    env,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout + result.stderr, /secret-key|super-secret/)
  return JSON.parse(result.stdout)
}

test('resolveStartupMode prefers command flags, then existing app state, then NODE_ENV', async () => {
  await withEnvWorkspace({}, (cwd) => {
    assert.equal(resolveStartupMode({ args: ['restart'], env: { NODE_ENV: 'development' }, cwd }), 'development')
    assert.equal(resolveStartupMode({ args: ['restart', '--mode', 'production'], env: { NODE_ENV: 'development' }, cwd }), 'production')
    assert.equal(resolveStartupMode({ args: ['status'], env: { NODE_ENV: 'production' }, cwd }), 'production')
    assert.equal(resolveStartupMode({ args: ['status'], env: {}, cwd }), 'development')
  })
})

test('development, production and test env files load with Next priority and process env wins', async () => {
  await withEnvWorkspace({
    '.env': 'YANXING_DATABASE_PATH=from-default\nYANXING_PORT=3001\nYANXING_SETTINGS_ENCRYPTION_KEY=super-secret\n',
    '.env.development': 'YANXING_DATABASE_PATH=from-development\nYANXING_PORT=3002\n',
    '.env.development.local': 'YANXING_DATABASE_PATH=from-development-local\n',
    '.env.production': 'YANXING_DATABASE_PATH=from-production\nYANXING_PORT=3003\n',
    '.env.test': 'YANXING_DATABASE_PATH=from-test\nYANXING_PORT=3004\n',
    '.env.local': 'YANXING_PORT=3999\n',
  }, (cwd) => {
    const development = printConfig(cwd, { YANXING_LOAD_MODE: 'development', NODE_ENV: undefined })
    assert.equal(development.nodeEnv, 'development')
    assert.equal(development.databasePath, 'from-development-local')
    assert.equal(development.port, '3999')

    const production = printConfig(cwd, { YANXING_LOAD_MODE: 'production', NODE_ENV: undefined })
    assert.equal(production.nodeEnv, 'production')
    assert.equal(production.databasePath, 'from-production')
    assert.equal(production.port, '3999')

    const testing = printConfig(cwd, { YANXING_LOAD_MODE: 'test', NODE_ENV: undefined })
    assert.equal(testing.nodeEnv, 'test')
    assert.equal(testing.databasePath, 'from-test')
    assert.equal(testing.port, '3004')

    const processWins = printConfig(cwd, { YANXING_LOAD_MODE: 'development', YANXING_DATABASE_PATH: 'from-process' })
    assert.equal(processWins.databasePath, 'from-process')
  })
})

test('restart without --mode uses existing state mode before loading env files', async () => {
  await withEnvWorkspace({
    '.env.development': 'YANXING_PORT=4100\n',
    '.env.production': 'YANXING_PORT=4200\n',
  }, (cwd) => {
    mkdirSync(path.join(cwd, 'storage'), { recursive: true })
    writeFileSync(path.join(cwd, 'storage', '.yanxing-app.json'), JSON.stringify({ mode: 'production', startedAt: new Date().toISOString(), processes: {} }))
    assert.equal(peekAppMode(cwd), 'production')
    assert.equal(resolveStartupMode({ args: ['restart'], cwd, env: { NODE_ENV: 'development' } }), 'production')
    const loaded = printConfig(cwd, { NODE_ENV: undefined })
    assert.equal(loaded.nodeEnv, 'production')
    assert.equal(loaded.port, '4200')
  })
})

test('migrate and app-manager load env after resolving mode and keep runtime getters live', async () => {
  await withEnvWorkspace({
    '.env.development': 'YANXING_DATABASE_PATH=manager-dev.sqlite\nYANXING_PORT=4300\nYANXING_SETTINGS_ENCRYPTION_KEY=secret-key\n'
  }, (cwd) => {
    const manager = spawnSync(process.execPath, [managerPath, 'status'], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'development' },
    })
    assert.equal(manager.status, 0, manager.stderr)
    assert.doesNotMatch(manager.stdout + manager.stderr, /secret-key/)

    const migrate = spawnSync(process.execPath, [tsxPath, migratePath], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'development', YANXING_DATABASE_PATH: path.join(cwd, 'manager-dev.sqlite') },
    })
    assert.equal(migrate.status, 0, migrate.stderr)
    assert.match(migrate.stdout, /数据库迁移完成/)
  })
})

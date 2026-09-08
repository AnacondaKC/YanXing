import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const { loadEnvConfig } = createRequire(import.meta.url)('@next/env')

const quietLogger = {
  info() {},
  error() {},
}

export function peekAppMode(cwd = process.cwd()) {
  const statePath = path.join(cwd, 'storage', '.yanxing-app.json')
  if (!existsSync(statePath)) return undefined
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    if (state?.mode === 'production' || state?.mode === 'development') return state.mode
  } catch {
    return undefined
  }
  return undefined
}

export function resolveStartupMode({
  args = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  if (args.includes('--production') || args.includes('--mode=production')) return 'production'
  if (args.includes('--development') || args.includes('--mode=development')) return 'development'
  const modeIndex = args.indexOf('--mode')
  if (modeIndex >= 0) {
    const value = args[modeIndex + 1]
    if (value === 'development' || value === 'production' || value === 'test') return value
  }
  const stateMode = peekAppMode(cwd)
  if (stateMode) return stateMode
  if (env.NODE_ENV === 'production' || env.NODE_ENV === 'development' || env.NODE_ENV === 'test') {
    return env.NODE_ENV
  }
  return 'development'
}

/**
 * @param {{ dir?: string, mode?: 'development' | 'production' | 'test', forceReload?: boolean }} [input]
 * @returns {'development' | 'production' | 'test'}
 */
export function loadYanXingEnv({ dir = process.cwd(), mode, forceReload = false } = {}) {
  const resolvedMode = mode ?? resolveStartupMode({ cwd: dir })
  process.env.NODE_ENV = resolvedMode
  loadEnvConfig(dir, resolvedMode !== 'production', quietLogger, forceReload)
  return resolvedMode
}

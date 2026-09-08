export function peekAppMode(cwd?: string): 'development' | 'production' | undefined
export function resolveStartupMode(input?: {
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}): 'development' | 'production' | 'test'
export function loadYanXingEnv(input?: {
  dir?: string
  mode?: 'development' | 'production' | 'test'
  forceReload?: boolean
}): 'development' | 'production' | 'test'

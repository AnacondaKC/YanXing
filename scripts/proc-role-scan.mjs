import { readdirSync, readFileSync } from 'node:fs'

export const SUPERVISOR_ARGV = '/app/scripts/docker-supervisor.mjs'
export const WEB_ARGV = '/app/server.js'
export const WORKER_ARGV = '/app/.runtime/worker/index.mjs'
export const WEB_TITLE = /^next-server \(v[0-9]/

export function readProcArgv(pid) {
  return readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').filter(Boolean)
}

export function readProcPpid(pid) {
  const stat = readFileSync('/proc/' + pid + '/stat', 'utf8')
  const close = stat.lastIndexOf(')')
  if (close < 0) return 0
  return Number(stat.slice(close + 2).split(' ')[1]) || 0
}

export function isSupervisor(argv) {
  return argv.includes(SUPERVISOR_ARGV)
}

export function isWeb(argv) {
  return argv.includes(WEB_ARGV) || WEB_TITLE.test((argv[0] ?? '').trim())
}

export function isWorker(argv) {
  return argv.includes(WORKER_ARGV)
}

export function listProcRoles() {
  const self = process.pid
  const processes = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if (!Number.isInteger(pid) || pid <= 1 || pid === self) continue
    let argv
    try { argv = readProcArgv(pid) } catch { continue }
    let ppid = 0
    try { ppid = readProcPpid(pid) } catch { ppid = 0 }
    processes.push({
      pid,
      argv,
      ppid,
      supervisor: isSupervisor(argv),
      web: isWeb(argv),
      worker: isWorker(argv),
    })
  }
  return processes
}

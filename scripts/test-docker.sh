#!/bin/sh
# Destructive tests are confined to a unique Compose project and temporary env file.
set -eu
umask 077
command -v docker >/dev/null 2>&1 || { echo 'Docker is required for this test.' >&2; exit 1; }
docker compose version >/dev/null
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
workspace=$(mktemp -d)
project="yanxing-smoke-$(date +%s)-$$"
export YANXING_ENV_FILE="$workspace/environment"
export YANXING_IMAGE="${YANXING_TEST_IMAGE:-$project:local}"
export YANXING_HTTP_PORT=0
export REPORT_MAX_UPLOAD_BYTES=26214400
password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')
key=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
printf 'YANXING_SETTINGS_ENCRYPTION_KEY=%s\nYANXING_WORKER_CONCURRENCY=3\nYANXING_WORKER_MAX_ATTEMPTS=1\n' "$key" > "$YANXING_ENV_FILE"

WEB_ROLE=web
WORKER_ROLE=worker
WAIT_TIMEOUT_S=180
STOP_TIMEOUT_S=100
MIGRATE_WAIT_TIMEOUT_S=60
MIGRATE_PROBE_S=20
PROC_SCAN_JS=$(cat <<'EOF'
import { readdirSync, readFileSync } from "node:fs"
const role = process.env.YANXING_SMOKE_PROC_ROLE ?? ""
const action = process.env.YANXING_SMOKE_PROC_ACTION ?? "list"
const self = process.pid
const supervisorArgv = "/app/scripts/docker-supervisor.mjs"
const webArgv = "/app/server.js"
const workerArgv = "/app/.runtime/worker/index.mjs"
const webTitle = /^next-server \(v[0-9]/
const processes = new Map()

function readArgv(pid) {
  return readFileSync("/proc/" + pid + "/cmdline").toString("utf8").split("\0").filter(Boolean)
}

function readPpid(pid) {
  const stat = readFileSync("/proc/" + pid + "/stat", "utf8")
  const close = stat.lastIndexOf(")")
  if (close < 0) return 0
  return Number(stat.slice(close + 2).split(" ")[1]) || 0
}

function isWeb(argv) {
  if (argv.includes(webArgv)) return true
  return webTitle.test((argv[0] ?? "").trim())
}

function isWorker(argv) {
  return argv.includes(workerArgv)
}

function matchesRole(argv) {
  if (role === "web") return isWeb(argv)
  if (role === "worker") return isWorker(argv)
  return false
}

for (const entry of readdirSync("/proc")) {
  if (!/^\d+$/.test(entry)) continue
  const pid = Number(entry)
  if (!Number.isInteger(pid) || pid <= 1 || pid === self) continue
  let argv
  try { argv = readArgv(pid) } catch { continue }
  let ppid = 0
  try { ppid = readPpid(pid) } catch { ppid = 0 }
  processes.set(pid, { argv, ppid })
}

const supervisorPids = new Set()
for (const [pid, proc] of processes) {
  if (proc.argv.includes(supervisorArgv)) supervisorPids.add(pid)
}

function isUnderSupervisor(pid) {
  if (supervisorPids.size === 0) return true
  const seen = new Set()
  let current = pid
  while (current > 1 && !seen.has(current)) {
    seen.add(current)
    const ppid = processes.get(current)?.ppid ?? 0
    if (supervisorPids.has(ppid)) return true
    current = ppid
  }
  return false
}

const pids = []
for (const [pid, proc] of processes) {
  if (matchesRole(proc.argv) && isUnderSupervisor(pid)) pids.push(pid)
}
if (action === "kill") {
  if (pids.length === 0) {
    console.error("no process matching " + role)
    process.exit(1)
  }
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL") } catch {}
  }
}
process.stdout.write(pids.join("\n"))
if (pids.length) process.stdout.write("\n")
EOF
)

compose() {
  docker compose -p "$project" --env-file "$YANXING_ENV_FILE" -f "$root/compose.yaml" "$@"
}
cleanup() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then compose logs --no-color >&2 || true; fi
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  if [ -z "${YANXING_TEST_IMAGE:-}" ]; then
    docker image rm "$YANXING_IMAGE" >/dev/null 2>&1 || true
  fi
  rm -rf "$workspace"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

app_container_id() {
  compose ps -aq app | awk 'NR==1 { print; exit }'
}

running_app_ids() {
  compose ps --status running -q app
}

assert_single_running_app() {
  ids=$(running_app_ids)
  n=0
  if [ -n "$ids" ]; then
    n=$(printf '%s\n' "$ids" | grep -c .)
  fi
  [ "$n" -eq 1 ] || { echo "expected 1 running app container, got $n" >&2; exit 1; }
}

wait_healthy() {
  id=$1
  timeout_s=$2
  deadline=$(( $(date +%s) + timeout_s ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id" 2>/dev/null || true)
    if [ "$health" = healthy ]; then return 0; fi
    sleep 2
  done
  echo "timed out waiting for app health: $id" >&2
  docker inspect --format '{{json .State}}' "$id" >&2 || true
  return 1
}

wait_container_restart() {
  id=$1
  previous_count=$2
  previous_started=$3
  timeout_s=$4
  deadline=$(( $(date +%s) + timeout_s ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    count=$(docker inspect --format '{{.RestartCount}}' "$id" 2>/dev/null || true)
    started=$(docker inspect --format '{{.State.StartedAt}}' "$id" 2>/dev/null || true)
    if [ -n "$count" ] && [ "$count" -gt "$previous_count" ]; then return 0; fi
    if [ -n "$started" ] && [ "$started" != "$previous_started" ]; then return 0; fi
    sleep 1
  done
  echo 'app container did not exit and restart after a service process was killed' >&2
  docker inspect --format '{{json .State}}' "$id" >&2 || true
  return 1
}

scan_procs() {
  compose exec -T \
    -e YANXING_SMOKE_PROC_ROLE="$1" \
    -e YANXING_SMOKE_PROC_ACTION="${2:-list}" \
    app node --input-type=module -e "$PROC_SCAN_JS"
}

scan_procs_in_container() {
  timeout 8 docker exec \
    -e YANXING_SMOKE_PROC_ROLE="$2" \
    -e YANXING_SMOKE_PROC_ACTION=list \
    "$1" node --input-type=module -e "$PROC_SCAN_JS"
}

assert_app_services() {
  web=$(scan_procs "$WEB_ROLE" list)
  worker=$(scan_procs "$WORKER_ROLE" list)
  [ -n "$web" ] || { echo 'web process is not running in the app container' >&2; exit 1; }
  [ -n "$worker" ] || { echo 'worker process is not running in the app container' >&2; exit 1; }
}

assert_combined_health() {
  compose exec -T app node scripts/docker-healthcheck.mjs
}

run_deployment_smoke() {
  compose exec -T \
    -e YANXING_SMOKE_ALLOW_MUTATIONS=true \
    -e "YANXING_SMOKE_PASSWORD=$password" \
    app node scripts/deployment-smoke.mjs "$@"
}

recover_from_killed_service() {
  name=$1
  needle=$2
  id=$(app_container_id)
  [ -n "$id" ] || { echo 'app container is missing' >&2; exit 1; }
  count=$(docker inspect --format '{{.RestartCount}}' "$id")
  started=$(docker inspect --format '{{.State.StartedAt}}' "$id")
  pids=$(scan_procs "$needle" list)
  [ -n "$pids" ] || { echo "$name process is not running" >&2; exit 1; }
  scan_procs "$needle" kill || true
  wait_container_restart "$id" "$count" "$started" "$WAIT_TIMEOUT_S"
  wait_healthy "$id" "$WAIT_TIMEOUT_S"
  assert_single_running_app
  assert_app_services
  assert_combined_health
}

logs_show_migration_failure() {
  logs=$1
  printf '%s\n' "$logs" | grep -F '数据库迁移失败' >/dev/null && return 0
  printf '%s\n' "$logs" | grep -F 'checksum 不匹配' >/dev/null && return 0
  printf '%s\n' "$logs" | grep -F '迁移账本校验失败' >/dev/null && return 0
  return 1
}

assert_migration_blocked() {
  deadline=$(( $(date +%s) + MIGRATE_PROBE_S ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    id=$(app_container_id)
    health=
    status=
    if [ -n "$id" ]; then
      health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id" 2>/dev/null || true)
      status=$(docker inspect --format '{{.State.Status}}' "$id" 2>/dev/null || true)
    fi
    [ "$health" != healthy ] || { echo 'app became healthy despite migration failure' >&2; exit 1; }
    if [ -n "$id" ] && [ "$status" = running ]; then
      if timeout 8 docker exec "$id" node scripts/docker-healthcheck.mjs >/dev/null 2>&1; then
        echo 'combined healthcheck passed despite migration failure' >&2
        exit 1
      fi
      web=$(scan_procs_in_container "$id" "$WEB_ROLE" 2>/dev/null || true)
      worker=$(scan_procs_in_container "$id" "$WORKER_ROLE" 2>/dev/null || true)
      [ -z "$web" ] || { echo 'web started despite migration failure' >&2; exit 1; }
      [ -z "$worker" ] || { echo 'worker started despite migration failure' >&2; exit 1; }
    fi
    sleep 2
  done
  logs=$(compose logs --no-color app 2>/dev/null || true)
  if ! logs_show_migration_failure "$logs"; then
    echo 'migration failure was not recorded in app logs' >&2
    printf '%s\n' "$logs" >&2
    exit 1
  fi
}

compose config --quiet
if [ -z "${YANXING_TEST_IMAGE:-}" ]; then
  compose build app
else
  docker image inspect "$YANXING_IMAGE" >/dev/null
fi
compose up -d --wait --wait-timeout "$WAIT_TIMEOUT_S"
assert_single_running_app
assert_app_services
assert_combined_health
compose exec -T app node --input-type=module -e 'import { existsSync, statSync } from "node:fs"; if (process.getuid() === 0 || [".env", ".next/cache/webpack", "node_modules/typescript", "node_modules/tsx", "node_modules/esbuild", "lib/documents/pdf-parser-worker.ts"].some(existsSync)) process.exit(1); if (!["server.js", ".runtime/worker/index.mjs", ".runtime/lib/documents/pdf-parser-worker.mjs", ".runtime/lib/documents/docx-parser-worker.mjs"].every(existsSync)) process.exit(1); if ((statSync("storage/yanxing.sqlite").mode & 0o077) !== 0) process.exit(1)'
compose exec -T -e YANXING_SMOKE_ALLOW_MUTATIONS=true app node scripts/docker-security-smoke.mjs
compose run --rm -T --no-deps app storage:relocate --help
compose run --rm -T --no-deps app storage:reconcile --dry-run
compose run --rm -T --no-deps -e "YANXING_ADMIN_PASSWORD=$password" app user:create
run_deployment_smoke

# Recreate, not merely restart: all persistent state must survive a new container.
compose up -d --force-recreate --wait --wait-timeout "$WAIT_TIMEOUT_S"
assert_single_running_app
assert_app_services
assert_combined_health
run_deployment_smoke --verify

recover_from_killed_service web "$WEB_ROLE"
recover_from_killed_service worker "$WORKER_ROLE"

compose stop -t "$STOP_TIMEOUT_S" app
app_id=$(app_container_id)
[ -n "$app_id" ] || { echo 'stopped app container is missing' >&2; exit 1; }
exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$app_id")
[ "$exit_code" = 0 ] || { echo "app did not stop cleanly: $exit_code" >&2; exit 1; }

# Only this disposable database is corrupted to verify migration failure gating.
compose run --rm -T --no-deps app node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(process.env.YANXING_DATABASE_PATH); db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run("smoke-invalid-checksum"); db.close()'
if compose up -d --force-recreate --wait --wait-timeout "$MIGRATE_WAIT_TIMEOUT_S"; then
  echo 'A failed migration unexpectedly allowed deployment.' >&2
  exit 1
fi
assert_migration_blocked
printf 'Docker deployment smoke tests passed.\n'

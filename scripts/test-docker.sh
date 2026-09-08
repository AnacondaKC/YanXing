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
export YANXING_IMAGE="$project:local"
export YANXING_HTTP_PORT=0
export REPORT_MAX_UPLOAD_BYTES=26214400
password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')
key=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
printf 'YANXING_SETTINGS_ENCRYPTION_KEY=%s\nYANXING_WORKER_CONCURRENCY=3\nYANXING_WORKER_MAX_ATTEMPTS=1\n' "$key" > "$YANXING_ENV_FILE"

compose() {
  docker compose -p "$project" --env-file "$YANXING_ENV_FILE" -f "$root/compose.yaml" "$@"
}
cleanup() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then compose logs --no-color >&2 || true; fi
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  docker image rm "$YANXING_IMAGE" >/dev/null 2>&1 || true
  rm -rf "$workspace"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

compose config --quiet
compose build web
compose up -d --wait --wait-timeout 180
compose exec -T web node --input-type=module -e 'import { existsSync, statSync } from "node:fs"; if (process.getuid() === 0 || existsSync(".env") || existsSync("node_modules/typescript")) process.exit(1); if ((statSync("storage/yanxing.sqlite").mode & 0o077) !== 0) process.exit(1)'
compose run --rm -T --no-deps -e "YANXING_ADMIN_PASSWORD=$password" migrate user:create
compose exec -T \
  -e YANXING_SMOKE_ALLOW_MUTATIONS=true \
  -e YANXING_SMOKE_MODEL_HOST=web \
  -e "YANXING_SMOKE_PASSWORD=$password" \
  web node scripts/deployment-smoke.mjs

# Recreate, not merely restart: all persistent state must survive new containers.
compose up -d --force-recreate --scale worker=2 --wait --wait-timeout 180
compose exec -T \
  -e YANXING_SMOKE_ALLOW_MUTATIONS=true \
  -e YANXING_SMOKE_MODEL_HOST=web \
  -e "YANXING_SMOKE_PASSWORD=$password" \
  web node scripts/deployment-smoke.mjs --verify

# A fresh run with two consumers exercises same-host worker scaling as well.
compose exec -T \
  -e YANXING_SMOKE_ALLOW_MUTATIONS=true \
  -e YANXING_SMOKE_MODEL_HOST=web \
  -e "YANXING_SMOKE_PASSWORD=$password" \
  web node scripts/deployment-smoke.mjs
compose stop -t 90 worker
worker_ids=$(compose ps -aq worker)
for id in $worker_ids; do
  exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$id")
  [ "$exit_code" = 0 ] || { echo "Worker did not stop cleanly: $exit_code" >&2; exit 1; }
done
# Only this disposable database is corrupted to verify migration failure gating.
compose stop web
compose run --rm -T --no-deps migrate node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(process.env.YANXING_DATABASE_PATH); db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run("smoke-invalid-checksum"); db.close()'
if compose up -d --force-recreate --wait --wait-timeout 60; then
  echo 'A failed migration unexpectedly allowed deployment.' >&2
  exit 1
fi
[ -z "$(compose ps --status running -q web worker)" ] || { echo 'Services started despite migration failure.' >&2; exit 1; }
printf 'Docker deployment smoke tests passed.\n'

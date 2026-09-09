#!/bin/sh
set -eu
umask 077

# Validate the image's build-time upload boundary before starting any service.
node /app/scripts/docker-runtime-config.mjs

if [ "$#" -eq 0 ]; then
  exec node /app/scripts/docker-supervisor.mjs
fi

case "$1" in
  web|worker|all)
    printf '%s\n' "旧的 $1 服务模式已移除。请无参数启动单容器 supervisor。" >&2
    exit 1
    ;;
  migrate)
    shift
    exec node /app/.runtime/scripts/migrate.mjs --mode=production "$@"
    ;;
  user:create)
    shift
    exec node /app/.runtime/scripts/create-user.mjs --mode=production "$@"
    ;;
  storage:reconcile)
    shift
    exec node /app/.runtime/scripts/storage-maintenance.mjs --mode=production "$@"
    ;;
  storage:relocate)
    shift
    exec node /app/.runtime/scripts/relocate-storage.mjs "$@"
    ;;
  *)
    exec "$@"
    ;;
esac

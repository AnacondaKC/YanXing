#!/bin/sh
set -eu
umask 077

# Validate the image's build-time upload boundary before starting any service.
node /app/scripts/docker-runtime-config.mjs

if [ "$#" -eq 0 ]; then set -- web; fi

case "$1" in
  web)
    shift
    export HOSTNAME=0.0.0.0
    exec node /app/server.js "$@"
    ;;
  worker)
    shift
    exec node /app/.runtime/worker/index.mjs --mode=production "$@"
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

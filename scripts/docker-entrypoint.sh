#!/bin/sh
set -eu
umask 077

# Validate the image's build-time upload boundary before starting any service.
node /app/scripts/docker-runtime-config.mjs

if [ "$#" -eq 0 ]; then set -- web; fi

case "$1" in
  web)
    shift
    exec node /app/node_modules/next/dist/bin/next start --hostname 0.0.0.0 --port 3000 "$@"
    ;;
  worker)
    shift
    exec node --import tsx /app/worker/index.ts --mode=production "$@"
    ;;
  migrate)
    shift
    exec node --import tsx /app/scripts/migrate.ts --mode=production "$@"
    ;;
  user:create)
    shift
    exec node --import tsx /app/scripts/create-user.ts --mode=production "$@"
    ;;
  storage:reconcile)
    shift
    exec node --import tsx /app/scripts/storage-maintenance.ts --mode=production "$@"
    ;;
  storage:relocate)
    shift
    exec node --import tsx /app/scripts/relocate-storage.ts "$@"
    ;;
  *)
    exec "$@"
    ;;
esac

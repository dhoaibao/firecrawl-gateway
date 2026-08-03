#!/bin/sh
set -eu

run_as_gateway() {
  exec su -s /bin/sh gateway -c 'exec "$0" "$@"' "$@"
}

case "${1:-api}" in
  migrate|preflight)
    if [ -z "${MIGRATION_DATABASE_URL:-}" ]; then
      echo "MIGRATION_DATABASE_URL is required for the $1 command" >&2
      exit 2
    fi
    export DATABASE_URL="$MIGRATION_DATABASE_URL"
    command="${1:-migrate}"
    shift
    if [ "$command" = "preflight" ]; then
      run_as_gateway node apps/api/scripts/migration-preflight.cjs "$@"
    else
      run_as_gateway node apps/api/scripts/migrate.cjs deploy "$@"
    fi
    ;;
  api)
    shift
    run_as_gateway node apps/api/dist/main.js "$@"
    ;;
  worker)
    shift
    run_as_gateway node apps/api/dist/worker-main.js "$@"
    ;;
  *)
    # Preserve direct node commands for local diagnostics and image probes.
    run_as_gateway "$@"
    ;;
esac

#!/usr/bin/env bash
# Migration driver (adapted from boxel's packages/postgres/scripts/migrate-local.sh).
# Applies (or rolls back) BOTH migration phases:
#   migrations/          additive, backward-compatible changes
#   migrations-removal/  destructive changes (column/table drops, renames)
#
# A deployed environment runs the removal phase only after the previous code
# revision has stopped serving, so a drop never breaks running code. Locally
# and in CI there is no rolling deploy, so both phases run together: removal
# LAST on `up` and FIRST on `down`, which keeps the combined sequence a valid
# linear order.
#
# Usage: migrate.sh [up | down [count] | create <name> | create-removal <name> | redo ...]
#
# Connection: DATABASE_URL if set, otherwise the standard PG* variables
# (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, PGSSLMODE).
set -euo pipefail

cd "$(dirname "$0")/.."

# node-pg-migrate for one phase: mig <dir> <table> <action> [extra-args...]
mig() {
  ./node_modules/.bin/node-pg-migrate \
    --migrations-dir "$1" \
    --migrations-table "$2" \
    --no-check-order \
    --verbose=false \
    "${@:3}"
}

rollback_run() {
  [ "$2" -eq 0 ] && return 0
  if [ "$1" = removal ]; then
    mig migrations-removal migrations_removal down "$2"
  else
    mig migrations migrations down "$2"
  fi
}

action="${1:-up}"
shift || true

case "$action" in
  create)
    # Additive by default. Use create-removal for DROP / RENAME.
    mig migrations migrations create --migration-file-language ts "$@"
    ;;
  create-removal)
    mig migrations-removal migrations_removal create --migration-file-language ts "$@"
    ;;
  down)
    # Revert `count` migrations across the combined newest-first timeline of
    # both phases, reading both tracking tables as the source of truth.
    count="${1:-1}"
    applied_phases=$(node scripts/applied-migrations.ts "$count")
    phase="" run=0
    while read -r p; do
      [ -z "$p" ] && continue
      if [ -n "$phase" ] && [ "$p" != "$phase" ]; then
        rollback_run "$phase" "$run"
        run=0
      fi
      phase="$p"
      run=$((run + 1))
    done <<< "$applied_phases"
    rollback_run "$phase" "$run"
    ;;
  *)
    mig migrations migrations "$action" "$@"
    mig migrations-removal migrations_removal "$action" "$@"
    ;;
esac

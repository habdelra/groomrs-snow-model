---
name: db-migrations
description: Postgres schema changes in groomrs-snow-model with node-pg-migrate 9 — creating TypeScript migrations via mise, the two-phase additive (migrations/) vs removal (migrations-removal/) split borrowed from boxel, how the service auto-migrates and creates its database, and how connection settings stay RDS-ready. Use before creating, editing or reviewing any migration, adding a table (e.g. grooming reports, base-depth observations), or touching src/db.ts / scripts/migrate.sh.
---

# Database migrations

Postgres holds metadata (`jobs`, `model_runs`, `state_checkpoints`, `results`) and, later, observations such as grooming and base-depth reports. Model data stays in files under `DATA_DIR`. Don't put SMET, `.sno`, `.pro` or weather payloads in the database.

## Creating a migration

```sh
mise run migrate create add-grooming-reports          # additive → migrations/
mise run migrate create-removal drop-old-column       # destructive → migrations-removal/
mise run migrate                                      # ensure DB exists, apply both phases
mise run migrate down 1                               # revert the newest, across both phases
```

- Always create files through the task: it adds the timestamp prefix and the TypeScript template. Never hand-name a migration.
- Migrations are TypeScript (`export async function up(pgm: MigrationBuilder)`). node-pg-migrate 9 loads `.ts` directly; there is no compile step.
- Write a real `down` for additive migrations, and comment why each table or column exists.

## Two phases (same rule as boxel's packages/postgres)

| Directory             | Tracking table       | For                                                                                |
| --------------------- | -------------------- | ---------------------------------------------------------------------------------- |
| `migrations/`         | `migrations`         | additive, backward-compatible changes: create table, add column or index, backfill |
| `migrations-removal/` | `migrations_removal` | destructive changes: DROP, RENAME, tightening a constraint old code relies on      |

The question to ask: does `up()` remove or rename something the currently running code still reads? If yes, it belongs in `migrations-removal/`.

Locally and in CI both phases run together, additive first (`scripts/migrate.sh`, `migrateToLatest()` in `src/db.ts`). In a future rolling deploy, the removal phase runs only after the old revision stops serving.

Once a migration has been applied anywhere shared, never edit it; add a new one. The initial migration was edited during Stage 1 setup only because nothing had been deployed yet.

## How migrations run

- The service runs `ensureDatabaseExists()` and then `migrateToLatest()` at startup when `AUTO_MIGRATE` is true (the default), much as boxel's `PgAdapter` auto-migrates. Concurrent starters wait on node-pg-migrate's advisory lock (`advisoryLockMode: 'wait'`).
- `scripts/run-migrations.ts` migrates and exits.
- `scripts/applied-migrations.ts` backs `migrate down [n]`: it reads both tracking tables to find the newest n across phases.

## Connection settings (RDS-ready)

- Use only `DATABASE_URL`, or the standard `PG*` variables (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE`). node-postgres and the node-pg-migrate CLI both read them.
- `ensureDatabaseExists()` connects to the `postgres` maintenance database with the same settings. It doesn't `docker exec` into a container, so it works against RDS (given CREATE DATABASE rights).
- `.mise.toml` points host-side tools at the Compose Postgres on `127.0.0.1:5436`; the container uses `DATABASE_URL`.

## Gotchas

- `jsonb` **reorders object keys**. Never compare JSON read back from `jsonb` by `JSON.stringify` equality; use `canonicalJson()` in `src/jobs/queue.ts`. That bug once made every idempotent retry a 409.
- Timestamps are `timestamptz`; the API emits UTC ISO strings.

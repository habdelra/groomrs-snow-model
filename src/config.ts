import { resolve } from 'node:path';

// Service configuration, read once from the environment.
//
// Postgres connection: DATABASE_URL when set, otherwise node-postgres reads
// the standard PG* variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE,
// PGSSLMODE) itself. Nothing here assumes the database runs in Compose, so a
// managed Postgres (e.g. RDS with PGSSLMODE=require) is a configuration change.
export interface Config {
  port: number;
  host: string;
  dataDir: string;
  openMeteoUrl: string;
  databaseUrl: string | undefined;
  autoMigrate: boolean;
  snowpackBin: string;
  snowpackTimeoutMs: number;
  workerEnabled: boolean;
  workerPollMs: number;
  serviceVersion: string;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n))
    throw new Error(`expected an integer, got ${value}`);
  return n;
}

export const SERVICE_VERSION = '0.1.0';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: int(env.PORT, 8090),
    host: env.HOST ?? '127.0.0.1',
    dataDir: resolve(env.DATA_DIR ?? './data'),
    openMeteoUrl: (env.OPEN_METEO_URL ?? 'http://127.0.0.1:8080').replace(
      /\/$/,
      '',
    ),
    databaseUrl: env.DATABASE_URL || undefined,
    autoMigrate: bool(env.AUTO_MIGRATE, true),
    snowpackBin: env.SNOWPACK_BIN ?? 'snowpack',
    snowpackTimeoutMs: int(env.SNOWPACK_TIMEOUT_MS, 15 * 60 * 1000),
    workerEnabled: bool(env.WORKER_ENABLED, true),
    workerPollMs: int(env.WORKER_POLL_MS, 1000),
    serviceVersion: SERVICE_VERSION,
  };
}

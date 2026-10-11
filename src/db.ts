import { join } from 'node:path';
import { runner } from 'node-pg-migrate';
import { Client, Pool, type ClientConfig, type PoolClient } from 'pg';
import { ROOT } from './paths.ts';

// DATABASE_URL wins; otherwise node-postgres falls back to the PG* variables.
export function connectionConfig(
  env: NodeJS.ProcessEnv = process.env,
): ClientConfig {
  return env.DATABASE_URL ? { connectionString: env.DATABASE_URL } : {};
}

let pool: Pool | undefined;

export function getPool(): Pool {
  pool ??= new Pool({ ...connectionConfig(), max: 10 });
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

export async function withClient<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

// Applies both migration phases, additive then removal, the same order
// scripts/migrate.sh uses. Concurrent callers wait on node-pg-migrate's
// advisory lock rather than failing.
export async function migrateToLatest(opts: { log?: boolean } = {}) {
  const log = opts.log ? console.log : () => {};
  const phases = [
    { dir: 'migrations', table: 'migrations' },
    { dir: 'migrations-removal', table: 'migrations_removal' },
  ];
  for (const phase of phases) {
    await runner({
      databaseUrl: connectionConfig(),
      dir: join(ROOT, phase.dir),
      migrationsTable: phase.table,
      direction: 'up',
      checkOrder: false,
      advisoryLockMode: 'wait',
      log,
      verbose: false,
    });
  }
}

// The newest applied additive migration, for /health.
export async function migrationHead(): Promise<string | null> {
  return withClient(async (client) => {
    const { rows } = await client.query<{ name: string }>(
      'SELECT name FROM migrations ORDER BY run_on DESC, name DESC LIMIT 1',
    );
    return rows[0]?.name ?? null;
  });
}

// Creates the target database when it's missing, connecting to the
// `postgres` maintenance database with otherwise identical settings. Returns
// the name of the database it created, or null.
export async function ensureDatabaseExists(): Promise<string | null> {
  const database = new Client(connectionConfig()).database;
  if (!database) throw new Error('no target database configured');
  const url = process.env.DATABASE_URL;
  const maintenance = new Client(
    url
      ? {
          connectionString: Object.assign(new URL(url), {
            pathname: '/postgres',
          }).toString(),
        }
      : { database: 'postgres' },
  );
  await maintenance.connect();
  try {
    const { rowCount } = await maintenance.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [database],
    );
    if (rowCount) return null;
    await maintenance.query(
      `CREATE DATABASE "${database.replace(/"/g, '""')}"`,
    );
    return database;
  } finally {
    await maintenance.end();
  }
}

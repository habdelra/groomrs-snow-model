import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { JobStatus } from '../contract/v1.ts';
import { getPool, withClient } from '../db.ts';

export type JobKind = 'initialize' | 'refresh';

export interface Job {
  id: string;
  kind: JobKind;
  resortId: string;
  season: string;
  idempotencyKey: string;
  request: JobRequest;
  status: JobStatus;
  progress: Record<string, string>;
  error: { reason: string; message: string; details?: unknown } | null;
  resultId: string | null;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

// What the caller sent, plus defaults resolved when the job was created, so a
// retried attempt does the same work as the first one.
export interface JobRequest {
  input: Record<string, unknown>;
  asOf: string;
  spinupDays?: number;
  horizonHours?: number;
}

interface JobRow {
  id: string;
  kind: JobKind;
  resort_id: string;
  season: string;
  idempotency_key: string;
  request: JobRequest;
  status: JobStatus;
  progress: Record<string, string>;
  error: Job['error'];
  result_id: string | null;
  attempts: number;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

function toJob(r: JobRow): Job {
  return {
    id: r.id,
    kind: r.kind,
    resortId: r.resort_id,
    season: r.season,
    idempotencyKey: r.idempotency_key,
    request: r.request,
    status: r.status,
    progress: r.progress,
    error: r.error,
    resultId: r.result_id,
    attempts: r.attempts,
    createdAt: r.created_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

export class IdempotencyConflict extends Error {
  readonly existing: Job;
  constructor(existing: Job) {
    super(
      `idempotency key ${existing.idempotencyKey} was already used for a different request (job ${existing.id})`,
    );
    this.existing = existing;
  }
}

// JSON with object keys sorted, so a request read back from jsonb (which
// reorders keys) compares equal to the same request as sent.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
}

function sameRequest(
  job: Job,
  kind: JobKind,
  resortId: string,
  season: string,
  input: unknown,
) {
  return (
    job.kind === kind &&
    job.resortId === resortId &&
    job.season === season &&
    canonicalJson(job.request.input) === canonicalJson(input)
  );
}

// Creates a job, or returns the one already created under the same
// idempotency key. Reusing a key for a different request is a conflict.
export async function createJob(opts: {
  kind: JobKind;
  resortId: string;
  season: string;
  idempotencyKey: string;
  request: JobRequest;
}): Promise<{ job: Job; created: boolean }> {
  return withClient(async (client) => {
    const { rows } = await client.query<JobRow>(
      `INSERT INTO jobs (id, kind, resort_id, season, idempotency_key, request)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        randomUUID(),
        opts.kind,
        opts.resortId,
        opts.season,
        opts.idempotencyKey,
        JSON.stringify(opts.request),
      ],
    );
    if (rows[0]) return { job: toJob(rows[0]), created: true };
    const existing = await getJobByKey(client, opts.idempotencyKey);
    if (!existing)
      throw new Error(`job for key ${opts.idempotencyKey} vanished`);
    if (
      !sameRequest(
        existing,
        opts.kind,
        opts.resortId,
        opts.season,
        opts.request.input,
      )
    ) {
      throw new IdempotencyConflict(existing);
    }
    return { job: existing, created: false };
  });
}

async function getJobByKey(
  client: PoolClient,
  key: string,
): Promise<Job | undefined> {
  const { rows } = await client.query<JobRow>(
    'SELECT * FROM jobs WHERE idempotency_key = $1',
    [key],
  );
  return rows[0] && toJob(rows[0]);
}

export async function getJob(id: string): Promise<Job | undefined> {
  const { rows } = await getPool().query<JobRow>(
    'SELECT * FROM jobs WHERE id = $1',
    [id],
  );
  return rows[0] && toJob(rows[0]);
}

const MAX_ATTEMPTS = 3;

// Claims the oldest runnable job: a queued one, or a running one whose
// worker stopped renewing its lease (it crashed or was restarted). Jobs run
// one at a time per worker, which also keeps two jobs from advancing the
// same resort's state at once.
export async function claimNext(
  leaseSeconds: number,
): Promise<Job | undefined> {
  const pool = getPool();
  await pool.query(
    `UPDATE jobs SET status = 'failed', finished_at = now(), lease_expires_at = NULL,
       error = jsonb_build_object('reason', 'max_attempts',
         'message', format('job did not finish after %s attempts', $1::int))
     WHERE status = 'running' AND lease_expires_at < now() AND attempts >= $1`,
    [MAX_ATTEMPTS],
  );
  const { rows } = await pool.query<JobRow>(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1,
       started_at = coalesce(started_at, now()),
       lease_expires_at = now() + make_interval(secs => $1)
     WHERE id = (
       SELECT id FROM jobs
       WHERE status = 'queued' OR (status = 'running' AND lease_expires_at < now())
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1)
     RETURNING *`,
    [leaseSeconds],
  );
  return rows[0] && toJob(rows[0]);
}

export async function renewLease(
  id: string,
  leaseSeconds: number,
): Promise<void> {
  await getPool().query(
    `UPDATE jobs SET lease_expires_at = now() + make_interval(secs => $2)
     WHERE id = $1 AND status = 'running'`,
    [id, leaseSeconds],
  );
}

export async function setProgress(
  id: string,
  progress: Record<string, string>,
): Promise<void> {
  await getPool().query('UPDATE jobs SET progress = $2 WHERE id = $1', [
    id,
    JSON.stringify(progress),
  ]);
}

export async function finishJob(
  id: string,
  status: Extract<JobStatus, 'complete' | 'blocked' | 'failed'>,
  opts: { error?: Job['error']; resultId?: string } = {},
): Promise<void> {
  await getPool().query(
    `UPDATE jobs SET status = $2, error = $3, result_id = $4, finished_at = now(),
       lease_expires_at = NULL
     WHERE id = $1`,
    [
      id,
      status,
      opts.error ? JSON.stringify(opts.error) : null,
      opts.resultId ?? null,
    ],
  );
}

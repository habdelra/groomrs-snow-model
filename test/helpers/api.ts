import assert from 'node:assert/strict';
import pg from 'pg';

// Integration tests talk to a running stack (`mise run stack:up`).
export const BASE_URL = (
  process.env.SNOW_MODEL_URL ?? 'http://127.0.0.1:8090'
).replace(/\/$/, '');

// Idempotency keys are unique per test process, so reruns against the same
// database create fresh jobs.
export const RUN_NONCE = `${Date.now().toString(36)}-${process.pid}`;

export async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: init.method ?? 'GET',
    headers:
      init.body === undefined ? {} : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON (native files)
  }
  return { status: res.status, body: body as T, headers: res.headers };
}

let healthy: Promise<void> | undefined;

// Waits for /health, failing with a pointer at how to start the stack.
export function requireStack(timeoutMs = 120_000): Promise<void> {
  healthy ??= (async () => {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${BASE_URL}/health`);
        if (res.ok) return;
        last = `${res.status} ${await res.text()}`;
      } catch (err) {
        last = (err as Error).message;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(
      `snow-model stack is not healthy at ${BASE_URL} (${last}). Start it with \`mise run stack:up\`.`,
    );
  })();
  return healthy;
}

export interface JobView {
  id: string;
  status: string;
  progress: Record<string, string>;
  error: { reason: string; message: string } | null;
  resultId: string | null;
}

export async function waitForJob(
  jobId: string,
  timeoutMs = 10 * 60_000,
): Promise<JobView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { status, body } = await api<JobView>(`/v1/jobs/${jobId}`);
    assert.equal(status, 200);
    if (body.status !== 'queued' && body.status !== 'running') return body;
    if (Date.now() > deadline)
      throw new Error(`job ${jobId} still ${body.status}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function expectComplete(jobId: string): Promise<JobView> {
  const job = await waitForJob(jobId);
  assert.equal(
    job.status,
    'complete',
    `job ${jobId}: ${JSON.stringify(job.error)}`,
  );
  return job;
}

// Direct database access, for asserting what the service recorded. Uses the
// same PG* / DATABASE_URL settings as the service's host-side tooling.
export async function dbQuery<T extends pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client(
    process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : {},
  );
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

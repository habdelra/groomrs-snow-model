import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.ts';
import {
  contractJsonSchema,
  InitializeRequest,
  RefreshRequest,
  SCHEMA_VERSION,
  type ResultDocument,
} from '../contract/v1.ts';
import { getPool, migrationHead } from '../db.ts';
import {
  createJob,
  getJob,
  IdempotencyConflict,
  type Job,
  type JobKind,
} from '../jobs/queue.ts';
import type { Resort, ResortRegistry } from '../resorts/registry.ts';
import {
  addHours,
  isValidSeason,
  seasonFor,
  startOfUtcDay,
} from '../season.ts';
import type { OpenMeteoClient } from '../weather/open-meteo.ts';

export interface ApiDeps {
  config: Config;
  registry: ResortRegistry;
  openMeteo: OpenMeteoClient;
  snowpackVersion: string | null;
  onJobCreated: () => void;
}

const MAX_WEATHER_WINDOW_HOURS = 31 * 24;

function problem(
  reply: FastifyReply,
  status: number,
  error: string,
  message: string,
  details?: unknown,
) {
  return reply
    .code(status)
    .send({ error, message, ...(details === undefined ? {} : { details }) });
}

function resortView(r: Resort) {
  return {
    id: r.id,
    name: r.name,
    location: r.location,
    hemisphere: r.hemisphere,
    elevationsM: r.elevationsM,
    season: r.season,
    weather: r.weather,
    points: r.points.map((p) => ({ id: p.id, elevationM: p.elevationM })),
    configVersion: r.configVersion,
    sources: r.sources,
  };
}

function jobView(job: Job) {
  return {
    id: job.id,
    kind: job.kind,
    resortId: job.resortId,
    season: job.season,
    status: job.status,
    progress: job.progress,
    error: job.error,
    resultId: job.resultId,
    attempts: job.attempts,
    asOf: job.request.asOf,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

// "2025-26" in a URL path is the season "2025/26".
function seasonFromPath(s: string): string {
  return /^\d{4}-\d{2}$/.test(s) ? s.replace('-', '/') : s;
}

export async function registerRoutes(app: FastifyInstance, deps: ApiDeps) {
  const { registry, openMeteo } = deps;

  app.get('/health/live', async () => ({ ok: true }));

  app.get('/health', async (_req, reply) => {
    const [openMeteoReachable, db] = await Promise.all([
      openMeteo.ping(),
      migrationHead().then(
        (head) => ({ reachable: true, migrationHead: head }),
        () => ({ reachable: false, migrationHead: null }),
      ),
    ]);
    const ok =
      openMeteoReachable && db.reachable && deps.snowpackVersion !== null;
    return reply.code(ok ? 200 : 503).send({
      ok,
      schemaVersion: SCHEMA_VERSION,
      serviceVersion: deps.config.serviceVersion,
      snowpackVersion: deps.snowpackVersion,
      openMeteo: {
        reachable: openMeteoReachable,
        url: deps.config.openMeteoUrl,
      },
      database: db,
    });
  });

  app.get('/v1/schema', async () => contractJsonSchema());

  app.get('/v1/resorts', async () => ({
    resorts: registry.all().map(resortView),
  }));

  app.get<{ Params: { id: string } }>('/v1/resorts/:id', async (req, reply) => {
    const resort = registry.get(req.params.id);
    if (!resort)
      return problem(reply, 404, 'not_found', `no resort ${req.params.id}`);
    return resortView(resort);
  });

  // Normalized hourly weather for one model point, metric. Synchronous and
  // bounded; backed by the same cache the model runs use.
  app.get<{
    Params: { id: string };
    Querystring: { point?: string; start?: string; end?: string };
  }>('/v1/resorts/:id/weather', async (req, reply) => {
    const resort = registry.get(req.params.id);
    if (!resort)
      return problem(reply, 404, 'not_found', `no resort ${req.params.id}`);
    const point = resort.points.find(
      (p) => p.id === (req.query.point ?? resort.points[0]?.id),
    );
    if (!point) {
      return problem(
        reply,
        400,
        'bad_request',
        `point must be one of ${resort.points.map((p) => p.id).join(', ')}`,
      );
    }
    const start = req.query.start
      ? new Date(req.query.start)
      : startOfUtcDay(new Date());
    const end = req.query.end ? new Date(req.query.end) : addHours(start, 72);
    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      end < start
    ) {
      return problem(
        reply,
        400,
        'bad_request',
        'start and end must be ISO times with start <= end',
      );
    }
    if (
      (end.getTime() - start.getTime()) / 3_600_000 >
      MAX_WEATHER_WINDOW_HOURS
    ) {
      return problem(
        reply,
        400,
        'bad_request',
        `window is limited to ${MAX_WEATHER_WINDOW_HOURS} hours`,
      );
    }
    try {
      const series = await openMeteo.hourly(
        resort,
        point,
        startOfHour(start),
        startOfHour(end),
      );
      return {
        resortId: resort.id,
        point: { id: point.id, elevationM: point.elevationM },
        provider: series.provider,
        model: series.model,
        retrievedAt: series.retrievedAt,
        hours: series.hours,
      };
    } catch (err) {
      return problem(reply, 502, 'weather_unavailable', (err as Error).message);
    }
  });

  async function enqueue(
    reply: FastifyReply,
    kind: JobKind,
    resort: Resort,
    season: string,
    idempotencyKey: string,
    input: unknown,
    request: { asOf: string; spinupDays?: number; horizonHours?: number },
  ) {
    try {
      const { job, created } = await createJob({
        kind,
        resortId: resort.id,
        season,
        idempotencyKey,
        request: { input: input as Record<string, unknown>, ...request },
      });
      if (created) deps.onJobCreated();
      return reply
        .code(created ? 202 : 200)
        .header('location', `/v1/jobs/${job.id}`)
        .send({ jobId: job.id, created, job: jobView(job) });
    } catch (err) {
      if (err instanceof IdempotencyConflict) {
        return problem(reply, 409, 'idempotency_conflict', err.message, {
          jobId: err.existing.id,
        });
      }
      throw err;
    }
  }

  function resolveAsOf(asOf: string | undefined): Date | string {
    const now = new Date();
    const at = asOf ? new Date(asOf) : now;
    if (at > now) return 'asOf must not be in the future';
    return at;
  }

  app.post<{ Params: { id: string; season: string } }>(
    '/v1/resorts/:id/seasons/:season/initialize',
    async (req, reply) => {
      const resort = registry.get(req.params.id);
      if (!resort)
        return problem(reply, 404, 'not_found', `no resort ${req.params.id}`);
      const season = seasonFromPath(req.params.season);
      if (!isValidSeason(resort.hemisphere, season)) {
        return problem(
          reply,
          400,
          'bad_request',
          `season ${season} is not a ${resort.hemisphere}ern season id (use ${resort.hemisphere === 'north' ? '2025-26' : '2026'})`,
        );
      }
      const parsed = InitializeRequest.safeParse(req.body ?? {});
      if (!parsed.success)
        return problem(
          reply,
          400,
          'bad_request',
          z.prettifyError(parsed.error),
        );
      const asOf = resolveAsOf(parsed.data.asOf);
      if (typeof asOf === 'string')
        return problem(reply, 400, 'bad_request', asOf);
      if (seasonFor(resort.hemisphere, asOf) !== season) {
        return problem(
          reply,
          400,
          'bad_request',
          `asOf ${asOf.toISOString()} is not in season ${season}`,
        );
      }
      return enqueue(
        reply,
        'initialize',
        resort,
        season,
        parsed.data.idempotencyKey,
        req.body,
        {
          asOf: asOf.toISOString(),
          ...(parsed.data.spinupDays
            ? { spinupDays: parsed.data.spinupDays }
            : {}),
        },
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/resorts/:id/refresh',
    async (req, reply) => {
      const resort = registry.get(req.params.id);
      if (!resort)
        return problem(reply, 404, 'not_found', `no resort ${req.params.id}`);
      const parsed = RefreshRequest.safeParse(req.body ?? {});
      if (!parsed.success)
        return problem(
          reply,
          400,
          'bad_request',
          z.prettifyError(parsed.error),
        );
      const asOf = resolveAsOf(parsed.data.asOf);
      if (typeof asOf === 'string')
        return problem(reply, 400, 'bad_request', asOf);
      return enqueue(
        reply,
        'refresh',
        resort,
        seasonFor(resort.hemisphere, asOf),
        parsed.data.idempotencyKey,
        req.body,
        { asOf: asOf.toISOString(), horizonHours: parsed.data.horizonHours },
      );
    },
  );

  app.get<{ Params: { id: string } }>('/v1/jobs/:id', async (req, reply) => {
    const job = z.string().uuid().safeParse(req.params.id).success
      ? await getJob(req.params.id)
      : undefined;
    if (!job)
      return problem(reply, 404, 'not_found', `no job ${req.params.id}`);
    return jobView(job);
  });

  // `profileDepthCm` keeps only profile layers whose top lies within that
  // depth of the snow surface; full profiles can run to megabytes.
  async function sendResult(
    reply: FastifyReply,
    path: string | undefined,
    profileDepthCm: string | undefined,
  ) {
    if (!path) return problem(reply, 404, 'not_found', 'no such result');
    const text = await readFile(path, 'utf8');
    if (profileDepthCm === undefined)
      return reply.type('application/json').send(text);
    const depth = Number(profileDepthCm);
    if (!Number.isFinite(depth) || depth < 0) {
      return problem(
        reply,
        400,
        'bad_request',
        'profileDepthCm must be a non-negative number',
      );
    }
    const doc = JSON.parse(text) as ResultDocument;
    for (const point of doc.points) {
      for (const profile of point.profiles) {
        profile.layers = profile.layers.filter((l) => l.depthCm <= depth);
      }
    }
    return doc;
  }

  app.get<{ Params: { id: string }; Querystring: { profileDepthCm?: string } }>(
    '/v1/resorts/:id/results/latest',
    async (req, reply) => {
      const { rows } = await getPool().query<{ document_path: string }>(
        'SELECT document_path FROM results WHERE resort_id = $1 ORDER BY created_at DESC LIMIT 1',
        [req.params.id],
      );
      return sendResult(
        reply,
        rows[0]?.document_path,
        req.query.profileDepthCm,
      );
    },
  );

  app.get<{ Params: { id: string }; Querystring: { profileDepthCm?: string } }>(
    '/v1/results/:id',
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        return problem(reply, 404, 'not_found', 'no such result');
      }
      const { rows } = await getPool().query<{ document_path: string }>(
        'SELECT document_path FROM results WHERE id = $1',
        [req.params.id],
      );
      return sendResult(
        reply,
        rows[0]?.document_path,
        req.query.profileDepthCm,
      );
    },
  );

  // Native SNOWPACK/SMET files from a run directory (io.ini, input/…, output/…).
  app.get<{ Params: { runId: string; '*': string } }>(
    '/v1/runs/:runId/files/*',
    async (req, reply) => {
      const { runId } = req.params;
      if (!z.string().uuid().safeParse(runId).success) {
        return problem(reply, 404, 'not_found', 'no such run');
      }
      const runDir = join(deps.config.dataDir, 'runs', runId);
      const path = normalize(join(runDir, req.params['*']));
      if (!path.startsWith(runDir + sep))
        return problem(reply, 404, 'not_found', 'no such file');
      try {
        if (!(await stat(path)).isFile()) throw new Error('not a file');
      } catch {
        return problem(reply, 404, 'not_found', 'no such file');
      }
      return reply
        .type('text/plain; charset=utf-8')
        .send(createReadStream(path));
    },
  );
}

function startOfHour(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000);
}

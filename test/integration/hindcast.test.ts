import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import {
  api,
  dbQuery,
  expectComplete,
  requireStack,
  RUN_NONCE,
  waitForJob,
} from '../helpers/api.ts';

before(() => requireStack());

interface ResultDoc {
  schemaVersion: string;
  resort: { id: string; configVersion: string };
  season: string;
  window: { from: string; to: string };
  provenance: {
    weatherModel: string;
    weatherKind: string;
    snowpackVersion: string;
  };
  points: Array<{
    id: string;
    state: {
      lineageId: string;
      checkpointValidTime: string;
      snowDepthCm: number;
    };
    forcing: Array<{ time: string; airTempC: number | null }>;
    met: Array<{
      time: string;
      snowDepthCm: number | null;
      surfaceTempC: number | null;
    }>;
    profiles: Array<{
      time: string;
      layers: Array<{ depthCm: number; densityKgM3: number | null }>;
    }>;
    files: { runId: string; names: string[] };
  }>;
  dataGaps: unknown[];
}

// Spin up last winter from 30 days before each resort's typical opening,
// then refresh two days later: the refresh first advances the saved state
// with past weather, then runs a 48 h "forecast" over archived weather.
const CASES = [
  { resortId: 'blue-mountain-pa', points: ['base', 'summit'] },
  { resortId: 'vail-co', points: ['base', 'mid', 'summit'] },
];

for (const { resortId, points } of CASES) {
  describe(`${resortId} hindcast, 2025/26`, () => {
    const initBody = {
      idempotencyKey: `it-${RUN_NONCE}-${resortId}-init`,
      asOf: '2026-02-01T12:00:00Z',
      spinupDays: 30,
    };
    let initJobId = '';

    test(
      'initialize spins up every point',
      { timeout: 10 * 60_000 },
      async () => {
        const { status, body } = await api<{ jobId: string; created: boolean }>(
          `/v1/resorts/${resortId}/seasons/2025-26/initialize`,
          { method: 'POST', body: initBody },
        );
        assert.equal(status, 202);
        assert.equal(body.created, true);
        initJobId = body.jobId;
        const job = await expectComplete(initJobId);
        assert.deepEqual(Object.keys(job.progress).sort(), [...points].sort());
        const checkpoints = await dbQuery<{
          point_id: string;
          snow_depth_cm: number;
        }>(
          `SELECT sc.point_id, sc.snow_depth_cm FROM state_checkpoints sc
         JOIN model_runs mr ON mr.id = sc.produced_by_run_id WHERE mr.job_id = $1`,
          [initJobId],
        );
        assert.equal(checkpoints.length, points.length);
      },
    );

    test('the same idempotency key returns the same job without new runs', async () => {
      const before = await dbQuery<{ n: string }>(
        'SELECT count(*) AS n FROM model_runs WHERE job_id = $1',
        [initJobId],
      );
      const again = await api<{ jobId: string; created: boolean }>(
        `/v1/resorts/${resortId}/seasons/2025-26/initialize`,
        { method: 'POST', body: initBody },
      );
      assert.equal(again.status, 200);
      assert.equal(again.body.jobId, initJobId);
      assert.equal(again.body.created, false);
      const after = await dbQuery<{ n: string }>(
        'SELECT count(*) AS n FROM model_runs WHERE job_id = $1',
        [initJobId],
      );
      assert.equal(after[0]!.n, before[0]!.n);

      const conflict = await api(
        `/v1/resorts/${resortId}/seasons/2025-26/initialize`,
        {
          method: 'POST',
          body: { ...initBody, spinupDays: 31 },
        },
      );
      assert.equal(conflict.status, 409);
    });

    test(
      'refresh advances the state and returns raw snowpack data',
      { timeout: 10 * 60_000 },
      async () => {
        const { status, body } = await api<{ jobId: string }>(
          `/v1/resorts/${resortId}/refresh`,
          {
            method: 'POST',
            body: {
              idempotencyKey: `it-${RUN_NONCE}-${resortId}-refresh`,
              asOf: '2026-02-03T06:00:00Z',
              horizonHours: 48,
            },
          },
        );
        assert.equal(status, 202);
        const job = await expectComplete(body.jobId);
        assert.ok(job.resultId);

        const runs = await dbQuery<{ point_id: string; kind: string }>(
          'SELECT point_id, kind FROM model_runs WHERE job_id = $1 ORDER BY point_id, kind',
          [body.jobId],
        );
        assert.deepEqual(
          runs.map((r) => `${r.point_id}:${r.kind}`),
          [...points].sort().flatMap((p) => [`${p}:advance`, `${p}:forecast`]),
        );

        const result = await api<ResultDoc>(`/v1/results/${job.resultId}`);
        assert.equal(result.status, 200);
        const doc = result.body;
        assert.equal(doc.schemaVersion, 'groomrs-snow-model/v1');
        assert.equal(doc.resort.id, resortId);
        assert.equal(doc.season, '2025/26');
        assert.deepEqual(doc.window, {
          from: '2026-02-03T00:00:00.000Z',
          to: '2026-02-05T00:00:00.000Z',
        });
        assert.equal(doc.provenance.weatherModel, 'ecmwf_ifs025');
        assert.equal(doc.provenance.weatherKind, 'archived');
        assert.equal(doc.provenance.snowpackVersion, '3.7.0');
        assert.deepEqual(doc.dataGaps, []);
        assert.deepEqual(
          doc.points.map((p) => p.id),
          points,
        );
        for (const p of doc.points) {
          assert.equal(p.state.lineageId, initJobId);
          assert.equal(p.state.checkpointValidTime, '2026-02-03T00:00:00.000Z');
          assert.equal(p.forcing.length, 49);
          assert.equal(p.met.length, 49);
          assert.equal(p.met[0]!.time, doc.window.from);
          assert.equal(p.met.at(-1)!.time, doc.window.to);
          assert.ok(p.forcing.every((h) => h.airTempC !== null));
          assert.ok(
            p.met.every((h) => h.snowDepthCm !== null && h.snowDepthCm >= 0),
          );
          assert.equal(p.profiles.length, 17);
        }
        const summit = doc.points.find((p) => p.id === 'summit')!;
        assert.ok(
          summit.state.snowDepthCm > 0,
          'the summit has snow in early February',
        );
        assert.ok(summit.profiles[0]!.layers.length > 0);
        assert.ok(summit.met.every((h) => h.surfaceTempC! <= 0.001));

        // Native SNOWPACK output is downloadable.
        const pro = await api<string>(
          `/v1/runs/${summit.files.runId}/files/output/SUMMIT_run.pro`,
        );
        assert.equal(pro.status, 200);
        assert.match(pro.body, /\[DATA\]/);
        assert.equal(
          (await api(`/v1/runs/${summit.files.runId}/files/../../x`)).status,
          404,
        );

        // Profiles can be trimmed to the near-surface layers.
        const trimmed = await api<ResultDoc>(
          `/v1/results/${job.resultId}?profileDepthCm=10`,
        );
        for (const p of trimmed.body.points) {
          for (const prof of p.profiles)
            assert.ok(prof.layers.every((l) => l.depthCm <= 10));
        }
        assert.equal(
          (await api<ResultDoc>(`/v1/resorts/${resortId}/results/latest`))
            .status,
          200,
        );
      },
    );
  });
}

// Regression: a 5-day spin-up leaves Blue Mountain's summit with ~1 cm of
// snow under very dry air on 2025-12-01, which made SNOWPACK diverge
// ("Temperature out of bound") with the MO_HOLTSLAG stability scheme.
test(
  'a thin early-season snowpack under dry air runs to completion',
  { timeout: 10 * 60_000 },
  async () => {
    const { body } = await api<{ jobId: string }>(
      '/v1/resorts/blue-mountain-pa/seasons/2025-26/initialize',
      {
        method: 'POST',
        body: {
          idempotencyKey: `it-${RUN_NONCE}-thin-snow`,
          asOf: '2026-02-01T12:00:00Z',
          spinupDays: 5,
        },
      },
    );
    await expectComplete(body.jobId);
  },
);

test('refresh of a season that was never initialized is blocked', async () => {
  const { body } = await api<{ jobId: string }>(
    '/v1/resorts/blue-mountain-pa/refresh',
    {
      method: 'POST',
      body: {
        idempotencyKey: `it-${RUN_NONCE}-uninitialized`,
        asOf: '2025-01-15T00:00:00Z',
        horizonHours: 24,
      },
    },
  );
  const job = await waitForJob(body.jobId);
  assert.equal(job.status, 'blocked');
  assert.equal(job.error?.reason, 'not_initialized');
});

test('requests are validated', async () => {
  const bad = [
    ['/v1/resorts/vail-co/seasons/2026/initialize', { idempotencyKey: 'x' }],
    ['/v1/resorts/vail-co/seasons/2025-26/initialize', {}],
    [
      '/v1/resorts/vail-co/seasons/2025-26/initialize',
      {
        idempotencyKey: `it-${RUN_NONCE}-wrong-season`,
        asOf: '2026-08-01T00:00:00Z',
      },
    ],
    ['/v1/resorts/vail-co/refresh', { idempotencyKey: 'x', horizonHours: 500 }],
    [
      '/v1/resorts/vail-co/refresh',
      { idempotencyKey: 'x', asOf: '2999-01-01T00:00:00Z' },
    ],
  ] as const;
  for (const [path, body] of bad) {
    const res = await api(path, { method: 'POST', body });
    assert.equal(
      res.status,
      400,
      `${path} ${JSON.stringify(body)} → ${res.status}`,
    );
  }
  assert.equal(
    (
      await api('/v1/resorts/nowhere/refresh', {
        method: 'POST',
        body: { idempotencyKey: 'x' },
      })
    ).status,
    404,
  );
});

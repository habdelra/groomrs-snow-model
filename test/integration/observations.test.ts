import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import {
  api,
  dbQuery,
  expectComplete,
  requireStack,
  RUN_NONCE,
} from '../helpers/api.ts';

before(() => requireStack());

const RESORT = 'blue-mountain-pa';

interface ManagedPoint {
  naturalSnowDepthCm: number;
  appliedFrom: string;
  groomedNights: Array<{
    time: string;
    basis: string;
    observationKey: string | null;
  }>;
  forecast: {
    today: {
      status: string;
      time: string | null;
      observationKey: string | null;
    };
    laterNights: string;
    snowmaking: {
      mode: string;
      nights: Array<{ day: string; hours: number; from: string; to: string }>;
      utilisation: number | null;
      recentColdHours: number;
      recentMachineSnowHours: number;
      depthPerHourCm: number | null;
      reason: string;
    };
  };
  technicalSnow: Array<{ day: string; hours: number; basis: string[] }>;
  baseDepth: Array<{
    observationKey: string;
    comparedAt: string;
    reportedCm: number;
    modelledBeforeCm: number;
    modelledAfterCm: number;
    addedHours: number;
    removedHours: number;
    residualCm: number;
    note: string | null;
  }>;
}

interface RunFiles {
  runId: string;
  from: string;
  to: string;
  names: string[];
}

interface ResultDoc {
  scenario: string;
  window: { from: string; to: string };
  provenance: {
    observationsThrough?: string | null;
    managedRulesVersion?: string;
  };
  points: Array<{
    id: string;
    state: { snowDepthCm: number; checkpointValidTime: string };
    met: Array<{ time: string; snowDepthCm: number | null }>;
    profiles: Array<{
      layers: Array<{ grainTypePrimary: string | null; densityKgM3: number }>;
    }>;
    files: { runId: string; names: string[]; runs: RunFiles[] };
    managed?: ManagedPoint;
  }>;
}

// The last timestamp in a SMET file's data section.
function lastSmetTime(smet: string): string {
  const rows = smet.slice(smet.indexOf('[DATA]')).trim().split('\n');
  return rows.at(-1)!.split(/\s+/)[0]!;
}

interface BatchResponse {
  batchId: string;
  through: string;
  counts: { accepted: number; amended: number; unchanged: number };
  results: Array<{ key: string; outcome: string; revision: number }>;
  earliestAffected: string | null;
}

// Observation keys are the same on every run, so the first batch puts the
// stored records back to this starting set whatever an earlier run left
// behind. Only the batch idempotency keys carry the run nonce.
const KEY = {
  groomed: 'it/grooming/bm-summit/2026-02-02',
  unknown: 'it/grooming/bm-summit/2026-02-03',
  snowmaking: 'it/snowmaking/bm-summit/2026-02-01',
  noDepth: 'it/base_depth/resort/2026-02-02',
  depth: 'it/base_depth/resort/2026-02-03',
  later: 'it/base_depth/resort/2026-02-04',
  lastNight: 'it/grooming/bm-summit/2026-02-05',
};

const summitCam = { elevationM: 470, source: 'webcam' as const };

function startingSet() {
  return [
    {
      kind: 'grooming',
      key: KEY.groomed,
      skiDay: '2026-02-02',
      status: 'groomed',
      validFrom: '2026-02-02T10:20:00Z',
      observedAt: '2026-02-02T10:20:00Z',
      ...summitCam,
    },
    {
      // A camera that could not tell. It must not read as "not groomed".
      kind: 'grooming',
      key: KEY.unknown,
      skiDay: '2026-02-03',
      status: 'unknown',
      validFrom: '2026-02-03T14:00:00Z',
      observedAt: '2026-02-03T14:00:00Z',
      ...summitCam,
    },
    {
      kind: 'snowmaking',
      key: KEY.snowmaking,
      skiDay: '2026-02-01',
      status: 'observed',
      validFrom: '2026-02-01T01:00:00Z',
      validTo: '2026-02-01T09:00:00Z',
      positiveSamples: 5,
      samples: 9,
      observedAt: '2026-02-01T09:00:00Z',
      ...summitCam,
    },
    {
      // A report with no depth on it is an observation too.
      kind: 'base_depth',
      key: KEY.noDepth,
      skiDay: '2026-02-02',
      status: 'not_reported',
      location: 'resort',
      validFrom: '2026-02-02T11:30:00Z',
      observedAt: '2026-02-02T12:00:00Z',
      source: 'resort-website',
    },
    {
      // Far more than the natural snowpack holds: the gap is machine snow.
      kind: 'base_depth',
      key: KEY.depth,
      skiDay: '2026-02-03',
      status: 'reported',
      depthCm: 120,
      location: 'resort',
      validFrom: '2026-02-03T11:30:00Z',
      observedAt: '2026-02-03T12:00:00Z',
      source: 'resort-website',
    },
    {
      // Seen on the morning the forecast is made, after its window starts.
      kind: 'grooming',
      key: KEY.lastNight,
      skiDay: '2026-02-05',
      status: 'groomed',
      validFrom: '2026-02-05T08:30:00Z',
      observedAt: '2026-02-05T08:30:00Z',
      ...summitCam,
    },
    {
      kind: 'base_depth',
      key: KEY.later,
      skiDay: '2026-02-04',
      status: 'unavailable',
      location: 'resort',
      validFrom: '2026-02-04T11:30:00Z',
      observedAt: '2026-02-04T12:00:00Z',
      source: 'resort-website',
    },
  ];
}

async function refresh(tag: string, extra: Record<string, unknown> = {}) {
  const { status, body } = await api<{ jobId: string }>(
    `/v1/resorts/${RESORT}/refresh`,
    {
      method: 'POST',
      body: {
        idempotencyKey: `it-${RUN_NONCE}-obs-${tag}`,
        asOf: '2026-02-05T06:00:00Z',
        horizonHours: 48,
        ...extra,
      },
    },
  );
  assert.equal(status, 202);
  const job = await expectComplete(body.jobId);
  const result = await api<ResultDoc>(
    `/v1/results/${job.resultId}?profileDepthCm=10`,
  );
  assert.equal(result.status, 200);
  const runs = await dbQuery<{
    point_id: string;
    kind: string;
    valid_from: Date;
  }>(
    'SELECT point_id, kind, valid_from FROM model_runs WHERE job_id = $1 ORDER BY valid_from',
    [body.jobId],
  );
  return { doc: result.body, runs };
}

describe('observations and the managed snowpack', () => {
  const batch = {
    idempotencyKey: `it-${RUN_NONCE}-obs-batch`,
    through: '2026-02-05T00:00:00Z',
    observations: startingSet(),
  };
  let first: BatchResponse;

  test('a fresh spin-up to build on', { timeout: 10 * 60_000 }, async () => {
    const { body } = await api<{ jobId: string }>(
      `/v1/resorts/${RESORT}/seasons/2025-26/initialize`,
      {
        method: 'POST',
        body: {
          idempotencyKey: `it-${RUN_NONCE}-obs-init`,
          asOf: '2026-02-01T12:00:00Z',
          spinupDays: 30,
        },
      },
    );
    await expectComplete(body.jobId);
  });

  test('a batch is validated before anything is stored', async () => {
    const path = `/v1/resorts/${RESORT}/observations`;
    assert.equal(
      (
        await api('/v1/resorts/nowhere/observations', {
          method: 'POST',
          body: batch,
        })
      ).status,
      404,
    );
    const twice = await api(path, {
      method: 'POST',
      body: {
        ...batch,
        idempotencyKey: `it-${RUN_NONCE}-obs-dup`,
        observations: [batch.observations[0], batch.observations[0]],
      },
    });
    assert.equal(twice.status, 400);
    const noDepth = await api(path, {
      method: 'POST',
      body: {
        ...batch,
        idempotencyKey: `it-${RUN_NONCE}-obs-nodepth`,
        observations: [{ ...batch.observations[4], depthCm: undefined }],
      },
    });
    assert.equal(noDepth.status, 400);
    const imperial = await api(path, {
      method: 'POST',
      body: {
        ...batch,
        idempotencyKey: `it-${RUN_NONCE}-obs-status`,
        observations: [{ ...batch.observations[0], status: 'confirmed' }],
      },
    });
    assert.equal(imperial.status, 400);
  });

  test('a batch is stored once, and a retry returns the same answer', async () => {
    const path = `/v1/resorts/${RESORT}/observations`;
    const stored = await api<BatchResponse>(path, {
      method: 'POST',
      body: batch,
    });
    assert.equal(stored.status, 201);
    first = stored.body;
    assert.equal(first.results.length, 7);
    const { accepted, amended, unchanged } = first.counts;
    assert.equal(accepted + amended + unchanged, 7);
    assert.equal(first.through, '2026-02-05T00:00:00.000Z');

    const rows = async () =>
      (
        await dbQuery<{ n: string }>(
          "SELECT count(*) AS n FROM observations WHERE resort_id = $1 AND key LIKE 'it/%'",
          [RESORT],
        )
      )[0]!.n;
    const before = await rows();
    const again = await api<BatchResponse>(path, {
      method: 'POST',
      body: batch,
    });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, first);
    assert.equal(await rows(), before);

    // The same records under a new batch key change nothing.
    const resent = await api<BatchResponse>(path, {
      method: 'POST',
      body: { ...batch, idempotencyKey: `it-${RUN_NONCE}-obs-resend` },
    });
    assert.equal(resent.status, 201);
    assert.equal(resent.body.counts.unchanged, 7);
    assert.equal(resent.body.earliestAffected, null);
    assert.equal(await rows(), before);

    const conflict = await api(path, {
      method: 'POST',
      body: { ...batch, through: '2026-02-06T00:00:00Z' },
    });
    assert.equal(conflict.status, 409);
  });

  test('latest says what the service holds, including "nothing seen"', async () => {
    const { status, body } = await api<{
      through: string;
      lastChangedAt: string | null;
      latest: Record<
        string,
        {
          key: string;
          status: string;
          revision: number;
          validFrom: string;
        } | null
      >;
      counts: Record<string, number>;
    }>(`/v1/resorts/${RESORT}/observations/latest`);
    assert.equal(status, 200);
    assert.ok(body.through >= '2026-02-05T00:00:00.000Z');
    assert.ok(body.lastChangedAt);
    // The latest record per kind is at least as late as this suite's own.
    // Other tools leave observations for this resort too (the analysis
    // examples do), so the exact record is not asserted.
    assert.ok(body.latest.base_depth && body.latest.grooming);
    assert.ok(body.latest.base_depth.validFrom >= '2026-02-04T11:30:00Z');
    assert.ok(body.latest.grooming.validFrom >= '2026-02-05T08:30:00Z');
    assert.equal(body.latest.snowmaking?.revision !== undefined, true);
    assert.ok(body.counts.grooming! >= 2);

    const listed = await api<{ observations: Array<{ key: string }> }>(
      `/v1/resorts/${RESORT}/observations?kind=base_depth&from=2026-02-02T00:00:00Z&to=2026-02-04T00:00:00Z`,
    );
    const keys = listed.body.observations.map((o) => o.key);
    assert.ok(keys.includes(KEY.depth) && keys.includes(KEY.noDepth));
  });

  let reused: ResultDoc;

  test(
    'refresh applies grooming and reads the base-depth gap as machine snow',
    { timeout: 10 * 60_000 },
    async () => {
      // No scenario given: the resort has observations, so it is managed.
      const { doc } = await refresh('managed');
      reused = doc;
      assert.equal(doc.scenario, 'managed');
      assert.ok(doc.provenance.observationsThrough);
      assert.match(doc.provenance.managedRulesVersion ?? '', /^managed\//);
      assert.deepEqual(
        doc.points.map((p) => p.id),
        ['base', 'summit'],
      );
      for (const p of doc.points) {
        const m = p.managed;
        assert.ok(m, `${p.id} carries what was applied`);
        assert.equal(m.appliedFrom, '2026-02-01T00:00:00.000Z');
        assert.equal(p.state.checkpointValidTime, '2026-02-05T00:00:00.000Z');

        // The reading from the morning of 3 Feb is compared at the end of
        // that UTC day.
        const reading = m.baseDepth.find((b) => b.observationKey === KEY.depth);
        assert.ok(reading, `${p.id} answered the base-depth reading`);
        assert.equal(reading.comparedAt, '2026-02-04T00:00:00.000Z');
        assert.equal(reading.reportedCm, 120);
        assert.ok(reading.modelledBeforeCm < 120);
        assert.ok(reading.addedHours > 0, 'machine snow was added');
        assert.equal(reading.removedHours, 0);
        assert.ok(reading.modelledAfterCm > reading.modelledBeforeCm + 5);
        // A share of the gap is closed, never the whole of it at once.
        assert.ok(reading.modelledAfterCm < 120);
        assert.ok(
          Math.abs(reading.residualCm - (120 - reading.modelledAfterCm)) < 0.2,
        );
        // The report with no depth on it asked for nothing.
        assert.ok(!m.baseDepth.some((b) => b.observationKey === KEY.noDepth));

        assert.ok(m.technicalSnow.some((t) => t.basis.includes('base_depth')));
        assert.ok(
          p.state.snowDepthCm > m.naturalSnowDepthCm + 5,
          `${p.id}: the managed pack is deeper than the natural one`,
        );
        // SNOWPACK's machine-snow layers come back as their own class.
        assert.ok(
          p.profiles.some((prof) =>
            prof.layers.some((l) => l.grainTypePrimary === 'MM'),
          ),
        );

        // The forecast is two runs, the first UTC day and the rest, and
        // `files` names both, each with its own span.
        const { runs } = p.files;
        assert.deepEqual(
          runs.map((r) => [r.from, r.to]),
          [
            [doc.window.from, '2026-02-06T00:00:00.000Z'],
            ['2026-02-06T00:00:00.000Z', doc.window.to],
          ],
        );
        assert.notEqual(runs[0]!.runId, runs[1]!.runId);
        assert.equal(p.files.runId, runs[0]!.runId);
        assert.deepEqual(p.files.names, runs[0]!.names);
        const POINT = p.id.toUpperCase();
        for (const run of runs) {
          assert.ok(run.names.includes(`output/${POINT}_run.smet`));
          const smet = await api<string>(
            `/v1/runs/${run.runId}/files/output/${POINT}_run.smet`,
          );
          assert.equal(smet.status, 200);
          // SMET times are UTC (tz = 0), written without a zone.
          assert.equal(
            lastSmetTime(smet.body).slice(0, 16),
            run.to.slice(0, 16),
            `${p.id}: run ${run.runId} ends at ${run.to}`,
          );
        }
      }

      const summit = doc.points.find((p) => p.id === 'summit')!.managed!;
      const base = doc.points.find((p) => p.id === 'base')!.managed!;
      // The groomer was seen at 10:20 from the summit camera.
      assert.deepEqual(summit.groomedNights, [
        {
          time: '2026-02-02T11:00:00.000Z',
          basis: 'observed',
          observationKey: KEY.groomed,
          source: 'webcam',
        },
      ]);
      assert.deepEqual(base.groomedNights, []);
      // Last night's pass falls inside the forecast window (it starts at
      // 00:00 UTC), and is applied to the forecast's first day.
      assert.deepEqual(summit.forecast.today, {
        status: 'observed',
        time: '2026-02-05T09:00:00.000Z',
        observationKey: KEY.lastNight,
        source: 'webcam',
      });
      assert.equal(summit.forecast.laterNights, 'none');
      // No snowmaking is assumed ahead unless the request asks for it.
      assert.equal(summit.forecast.snowmaking.mode, 'none');
      assert.equal(summit.forecast.snowmaking.reason, 'not_requested');
      assert.deepEqual(summit.forecast.snowmaking.nights, []);
      assert.equal(base.forecast.today.status, 'none');
    },
  );

  test(
    'a second refresh reuses every saved day',
    { timeout: 10 * 60_000 },
    async () => {
      const { doc, runs } = await refresh('again');
      assert.deepEqual(runs.map((r) => `${r.point_id}:${r.kind}`).sort(), [
        // The forecast's first day runs on its own, then the rest.
        'base:forecast',
        'base:forecast',
        'summit:forecast',
        'summit:forecast',
      ]);
      for (const p of doc.points) {
        const earlier = reused.points.find((q) => q.id === p.id)!;
        assert.equal(p.state.snowDepthCm, earlier.state.snowDepthCm);
        assert.deepEqual(p.managed, earlier.managed);
      }
    },
  );

  test(
    'a natural refresh is still available and ignores observations',
    { timeout: 10 * 60_000 },
    async () => {
      const { doc } = await refresh('natural', { scenario: 'natural' });
      assert.equal(doc.scenario, 'natural');
      for (const p of doc.points) {
        assert.equal(p.managed, undefined);
        // A natural forecast is one run over the whole window.
        assert.deepEqual(p.files.runs, [
          {
            runId: p.files.runId,
            from: doc.window.from,
            to: doc.window.to,
            names: p.files.names,
          },
        ]);
        const managed = reused.points.find((q) => q.id === p.id)!;
        assert.equal(p.state.snowDepthCm, managed.managed!.naturalSnowDepthCm);
      }
    },
  );

  test(
    'amending a past day re-runs from that day only',
    { timeout: 10 * 60_000 },
    async () => {
      // Staff log that the groomer was out on the 3rd after all.
      const amended = await api<BatchResponse>(
        `/v1/resorts/${RESORT}/observations`,
        {
          method: 'POST',
          body: {
            idempotencyKey: `it-${RUN_NONCE}-obs-amend`,
            through: '2026-02-05T00:00:00Z',
            observations: [
              {
                kind: 'grooming',
                key: KEY.unknown,
                skiDay: '2026-02-03',
                status: 'groomed',
                validFrom: '2026-02-03T09:40:00Z',
                observedAt: '2026-02-03T09:40:00Z',
                elevationM: 470,
                source: 'human',
                note: 'Patrol confirmed the upper runs were groomed.',
              },
            ],
          },
        },
      );
      assert.equal(amended.status, 201);
      assert.deepEqual(amended.body.counts, {
        accepted: 0,
        amended: 1,
        unchanged: 0,
      });
      assert.equal(amended.body.earliestAffected, '2026-02-03T09:40:00.000Z');
      const revision = amended.body.results[0]!.revision;
      assert.ok(revision >= 2);

      // Both revisions are kept.
      const history = await api<{
        observations: Array<{ key: string; revision: number; status: string }>;
      }>(`/v1/resorts/${RESORT}/observations?kind=grooming&revisions=all`);
      const revisions = history.body.observations
        .filter((o) => o.key === KEY.unknown)
        .sort((x, y) => x.revision - y.revision);
      assert.ok(revisions.length >= 2);
      assert.equal(revisions.at(-1)!.status, 'groomed');
      assert.equal(revisions.at(-1)!.revision, revision);

      const { doc, runs } = await refresh('amended');
      const advances = runs.filter((r) => r.kind === 'advance');
      // Only the summit saw the groomer, so only its days run again, and
      // none before the amended day.
      assert.ok(advances.length > 0);
      for (const r of advances) {
        assert.equal(r.point_id, 'summit');
        assert.ok(r.valid_from.toISOString() >= '2026-02-03T00:00:00.000Z');
      }
      const summit = doc.points.find((p) => p.id === 'summit')!.managed!;
      assert.deepEqual(
        summit.groomedNights.map((g) => g.time),
        ['2026-02-02T11:00:00.000Z', '2026-02-03T10:00:00.000Z'],
      );
      // The forecast is one unbroken series across its two runs.
      const times = doc.points
        .find((p) => p.id === 'summit')!
        .met.map((m) => m.time);
      assert.equal(times.length, 49);
      assert.equal(new Set(times).size, 49);
      assert.equal(times[0], '2026-02-05T00:00:00.000Z');
      assert.equal(times.at(-1), '2026-02-07T00:00:00.000Z');
      const base = doc.points.find((p) => p.id === 'base')!;
      assert.deepEqual(
        base.managed,
        reused.points.find((p) => p.id === 'base')!.managed,
      );
    },
  );

  test(
    'snowmaking ahead is predicted from what the resort has been doing',
    { timeout: 10 * 60_000 },
    async () => {
      const plain = (await refresh('before-prediction')).doc;
      const { doc } = await refresh('predicted', {
        snowmakingForecast: 'predicted',
      });
      for (const p of doc.points) {
        const sm = p.managed!.forecast.snowmaking;
        assert.equal(sm.mode, 'predicted');
        // The base-depth reading put machine snow on the last days' cold
        // hours, so there is recent production to go on.
        assert.equal(sm.reason, 'recent_production');
        assert.ok(sm.recentMachineSnowHours > 0);
        assert.ok(sm.recentColdHours >= sm.recentMachineSnowHours);
        assert.ok(sm.utilisation! > 0 && sm.utilisation! <= 0.6);
        assert.ok(sm.depthPerHourCm! >= 0);
        // Every predicted night falls inside the forecast window.
        for (const n of sm.nights) {
          assert.ok(n.hours > 0);
          assert.ok(n.from >= '2026-02-05T00:00:00.000Z');
          assert.ok(n.to <= '2026-02-07T00:00:00.000Z');
        }
        // The past is untouched: the same state to forecast from.
        const before = plain.points.find((q) => q.id === p.id)!;
        assert.equal(p.state.snowDepthCm, before.state.snowDepthCm);
        // Where snow is predicted, the forecast ends deeper than without it.
        if (sm.nights.length) {
          assert.ok(
            p.met.at(-1)!.snowDepthCm! > before.met.at(-1)!.snowDepthCm!,
            `${p.id}: predicted machine snow adds depth over the forecast`,
          );
        }
      }
      // The data has cold nights in early February, so something is predicted.
      assert.ok(
        doc.points.some((p) => p.managed!.forecast.snowmaking.nights.length),
      );
    },
  );

  test(
    'a later, lower reading takes machine snow back',
    { timeout: 10 * 60_000 },
    async () => {
      const before = (await refresh('before-lower')).doc;
      // The next day's report can be read after all, and is far lower.
      const sent = await api<BatchResponse>(
        `/v1/resorts/${RESORT}/observations`,
        {
          method: 'POST',
          body: {
            idempotencyKey: `it-${RUN_NONCE}-obs-lower`,
            through: '2026-02-05T00:00:00Z',
            observations: [
              {
                kind: 'base_depth',
                key: KEY.later,
                skiDay: '2026-02-04',
                status: 'reported',
                depthCm: 20,
                location: 'resort',
                validFrom: '2026-02-04T11:30:00Z',
                observedAt: '2026-02-04T12:00:00Z',
                source: 'human',
              },
            ],
          },
        },
      );
      assert.equal(sent.body.counts.amended, 1);
      const { doc } = await refresh('lower');
      for (const p of doc.points) {
        const reading = p.managed!.baseDepth.find(
          (b) => b.observationKey === KEY.later,
        );
        assert.ok(reading, `${p.id} answered the lower reading`);
        assert.equal(reading.comparedAt, '2026-02-05T00:00:00.000Z');
        assert.ok(reading.modelledBeforeCm > 20 + 5);
        assert.ok(reading.removedHours > 0, 'machine snow was taken back');
        assert.equal(reading.addedHours, 0);
        assert.ok(reading.modelledAfterCm < reading.modelledBeforeCm);
        const earlier = before.points.find((q) => q.id === p.id)!;
        assert.ok(p.state.snowDepthCm < earlier.state.snowDepthCm);
        // The pack never goes below what the weather alone left.
        assert.ok(p.state.snowDepthCm >= p.managed!.naturalSnowDepthCm - 0.5);
      }
    },
  );
});

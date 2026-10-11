import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import {
  api,
  expectComplete,
  requireStack,
  RUN_NONCE,
} from '../helpers/api.ts';

before(() => requireStack());

// El Colorado's season is the calendar year, so "now" is always inside one:
// spin up from the typical opening minus 75 days to today, then forecast.
test(
  'el-colorado-cl: current season through a real forecast',
  { timeout: 15 * 60_000 },
  async () => {
    const season = String(new Date().getUTCFullYear());
    const init = await api<{ jobId: string }>(
      `/v1/resorts/el-colorado-cl/seasons/${season}/initialize`,
      { method: 'POST', body: { idempotencyKey: `it-${RUN_NONCE}-elc-init` } },
    );
    assert.equal(init.status, 202, JSON.stringify(init.body));
    await expectComplete(init.body.jobId);

    const refresh = await api<{ jobId: string }>(
      '/v1/resorts/el-colorado-cl/refresh',
      {
        method: 'POST',
        body: {
          idempotencyKey: `it-${RUN_NONCE}-elc-refresh`,
          horizonHours: 72,
        },
      },
    );
    assert.equal(refresh.status, 202);
    const job = await expectComplete(refresh.body.jobId);

    const { body: doc } = await api<{
      season: string;
      provenance: { weatherKind: string };
      points: Array<{
        id: string;
        forcing: Array<{ airTempC: number | null }>;
        met: Array<{ snowDepthCm: number | null }>;
        profiles: unknown[];
      }>;
    }>(`/v1/results/${job.resultId}`);
    assert.equal(doc.season, season);
    assert.notEqual(doc.provenance.weatherKind, 'archived');
    assert.deepEqual(
      doc.points.map((p) => p.id),
      ['base', 'mid', 'summit'],
    );
    for (const p of doc.points) {
      assert.equal(p.met.length, 73);
      assert.ok(p.forcing.every((h) => h.airTempC !== null));
      assert.ok(p.met.every((h) => h.snowDepthCm !== null));
      assert.ok(p.profiles.length > 0);
    }
  },
);

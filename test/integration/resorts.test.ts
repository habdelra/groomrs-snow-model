import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { api, requireStack } from '../helpers/api.ts';

before(() => requireStack());

interface ResortView {
  id: string;
  hemisphere: string;
  points: Array<{ id: string; elevationM: number }>;
  configVersion: string;
}

test('lists the seed resorts with their model points', async () => {
  const { status, body } = await api<{ resorts: ResortView[] }>('/v1/resorts');
  assert.equal(status, 200);
  const points = Object.fromEntries(
    body.resorts.map((r) => [r.id, r.points.map((p) => p.id)]),
  );
  assert.deepEqual(points, {
    'blue-mountain-pa': ['base', 'summit'],
    'el-colorado-cl': ['base', 'mid', 'summit'],
    'vail-co': ['base', 'mid', 'summit'],
  });
  for (const r of body.resorts) assert.match(r.configVersion, /^[0-9a-f]{12}$/);
});

test('a single resort, and a 404 for an unknown one', async () => {
  const vail = await api<ResortView>('/v1/resorts/vail-co');
  assert.equal(vail.status, 200);
  assert.equal(vail.body.hemisphere, 'north');
  assert.deepEqual(
    vail.body.points.map((p) => p.elevationM),
    [2475, 3001, 3527],
  );
  assert.equal((await api('/v1/resorts/nowhere')).status, 404);
});

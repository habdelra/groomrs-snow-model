import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { api, requireStack } from '../helpers/api.ts';

before(() => requireStack());

test('health reports SNOWPACK, Open-Meteo and the migrated database', async () => {
  const { status, body } = await api<{
    ok: boolean;
    snowpackVersion: string;
    openMeteo: { reachable: boolean };
    database: { reachable: boolean; migrationHead: string | null };
  }>('/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.snowpackVersion, '3.7.0');
  assert.equal(body.openMeteo.reachable, true);
  assert.equal(body.database.reachable, true);
  assert.match(body.database.migrationHead ?? '', /initial-jobs-and-runs/);
});

test('the contract schema is published', async () => {
  const { status, body } = await api<{
    schemaVersion: string;
    resultDocument: object;
  }>('/v1/schema');
  assert.equal(status, 200);
  assert.equal(body.schemaVersion, 'groomrs-snow-model/v1');
  assert.ok(body.resultDocument);
});

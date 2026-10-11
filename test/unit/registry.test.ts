import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from '../../src/paths.ts';
import {
  modelPoints,
  parseResort,
  ResortRegistry,
} from '../../src/resorts/registry.ts';
import { readIniTemplate } from '../../src/snowpack/config.ts';

test('point count follows vertical drop', () => {
  assert.deepEqual(
    modelPoints(1000, 1250).map((p) => p.id),
    ['mid'],
  );
  assert.deepEqual(
    modelPoints(140, 470).map((p) => p.id),
    ['base', 'summit'],
  );
  assert.deepEqual(modelPoints(2475, 3527), [
    { id: 'base', elevationM: 2475 },
    { id: 'mid', elevationM: 3001 },
    { id: 'summit', elevationM: 3527 },
  ]);
});

test('seed resorts load with the expected points', () => {
  const registry = ResortRegistry.load(
    join(ROOT, 'config', 'resorts'),
    readIniTemplate(),
  );
  const counts = Object.fromEntries(
    registry.all().map((r) => [r.id, r.points.length]),
  );
  assert.deepEqual(counts, {
    'blue-mountain-pa': 2,
    'el-colorado-cl': 3,
    'vail-co': 3,
  });
  assert.equal(registry.get('el-colorado-cl')?.hemisphere, 'south');
});

const yaml = `
id: test-resort
name: Test
location: { country: US, region: X, latitude: 40, longitude: -75, timezone: America/New_York }
hemisphere: north
elevationsM: { base: 100, summit: 500 }
season: { typicalOpening: '12-01', typicalClosing: '03-31', spinupDays: 60 }
weather: { provider: open-meteo, model: ecmwf_ifs025 }
`;

test('configVersion changes with the config and with the ini template', () => {
  const a = parseResort(yaml, 'ini-a');
  assert.equal(parseResort(yaml, 'ini-a').configVersion, a.configVersion);
  assert.notEqual(parseResort(yaml, 'ini-b').configVersion, a.configVersion);
  assert.notEqual(
    parseResort(yaml.replace('summit: 500', 'summit: 600'), 'ini-a')
      .configVersion,
    a.configVersion,
  );
});

test('invalid configs are rejected', () => {
  assert.throws(() => parseResort(yaml.replace('summit: 500', 'summit: 50')));
  assert.throws(() =>
    parseResort(yaml.replace('hemisphere: north', 'hemisphere: east')),
  );
});

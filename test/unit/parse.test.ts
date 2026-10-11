import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseMet,
  parsePro,
  parseSmet,
  smetColumn,
} from '../../src/snowpack/parse.ts';
import { fixture } from '../helpers/fixtures.ts';

// Fixtures are real SNOWPACK 3.7.0 output for Vail's base point, forecast
// run starting 2026-02-01 from a spin-up checkpoint.

test('SMET reader applies units_offset and units_multiplier', () => {
  const smet = parseSmet(fixture('vail-base-run.smet'));
  assert.equal(smet.header.station_id, 'BASE');
  // TA is written in °C with a 273.15 offset → K; HS_mod in cm × 0.01 → m.
  const ta = smetColumn(smet, 'TA')[0]!;
  const hs = smetColumn(smet, 'HS_mod')[0]!;
  assert.ok(ta > 250 && ta < 290, `TA ${ta} should be kelvin`);
  assert.ok(hs > 0.1 && hs < 2, `HS ${hs} should be metres`);
});

test('parseMet maps SNOWPACK output to metric contract fields', () => {
  const met = parseMet(fixture('vail-base-run.smet'));
  assert.equal(met.length, 25);
  const first = met[0]!;
  assert.equal(first.time, '2026-02-01T00:00:00.000Z');
  assert.equal(first.snowDepthCm, 37.313);
  assert.equal(first.sweMm, 97.822);
  assert.equal(first.airTempC, -0.6);
  assert.equal(first.relativeHumidityPct, 68);
  assert.equal(first.surfaceTempC, -9.608);
  assert.equal(first.skierPenetrationCm, 15.9);
  assert.equal(first.newSnow24hCm, 0);
  assert.ok(
    first.incomingLongwaveWm2! > 150 && first.incomingLongwaveWm2! < 400,
  );
  for (const h of met) {
    assert.ok(h.snowDepthCm! >= 0);
    assert.ok(h.albedoFraction! > 0 && h.albedoFraction! <= 1);
  }
});

test('parsePro returns surface-first layers that stack to the snow depth', () => {
  const profiles = parsePro(fixture('vail-base-run.pro'));
  assert.equal(profiles.length, 2);
  const p = profiles[0]!;
  assert.equal(p.time, '2026-02-01T00:00:00.000Z');
  assert.ok(p.layers.length > 10);
  const top = p.layers[0]!;
  assert.equal(top.depthCm, 0);
  assert.equal(top.topHeightCm, p.snowDepthCm);
  const bottom = p.layers.at(-1)!;
  assert.equal(bottom.topHeightCm, bottom.thicknessCm);
  const total = p.layers.reduce((sum, l) => sum + l.thicknessCm, 0);
  assert.ok(
    Math.abs(total - p.snowDepthCm) < 0.05,
    `layers sum to ${total}, depth ${p.snowDepthCm}`,
  );
  for (const l of p.layers) {
    assert.ok(l.densityKgM3! > 20 && l.densityKgM3! < 917);
    assert.ok(l.temperatureC! <= 0);
    assert.ok(l.handHardnessIndex! >= 1 && l.handHardnessIndex! <= 6);
    assert.ok(l.grainTypePrimary, 'every snow layer has a grain class');
  }
});

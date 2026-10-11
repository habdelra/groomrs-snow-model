import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  conv,
  cToKelvin,
  fractionToPct,
  kelvinToC,
  metresToCm,
  metresToMm,
  pctToFraction,
  pctToOktas,
  snowfallCmToMmWe,
} from '../../src/units.ts';

test('temperature converts between kelvin and celsius', () => {
  assert.equal(kelvinToC(273.15), 0);
  assert.equal(cToKelvin(-10), 263.15);
  assert.equal(conv(kelvinToC(cToKelvin(-3.7)), undefined, 3), -3.7);
});

test('lengths, fractions and cloud cover', () => {
  assert.equal(metresToCm(0.373), 37.3);
  assert.equal(metresToMm(0.0005), 0.5);
  assert.equal(fractionToPct(0.68), 68);
  assert.equal(pctToFraction(68), 0.68);
  assert.equal(pctToOktas(100), 8);
  assert.equal(pctToOktas(50), 4);
});

test('snowfall depth to water equivalent scales with new-snow density', () => {
  // 1 cm of 100 kg/m³ snow is 1 mm of water.
  assert.equal(snowfallCmToMmWe(1, 100), 1);
  assert.equal(snowfallCmToMmWe(10, 50), 5);
});

test('conv passes nulls through and rounds', () => {
  assert.equal(conv(null, kelvinToC), null);
  assert.equal(conv(undefined), null);
  assert.equal(conv(Number.NaN), null);
  assert.equal(
    conv(1.23456, (n) => n, 2),
    1.23,
  );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseResort } from '../../src/resorts/registry.ts';
import { parseSmet, smetColumn } from '../../src/snowpack/parse.ts';
import type { HourlyWeather } from '../../src/weather/open-meteo.ts';
import { precipitationPhase, toSmet } from '../../src/weather/smet.ts';

const resort = parseResort(`
id: test-resort
name: Test
location: { country: US, region: X, latitude: 40.5, longitude: -75.25, timezone: America/New_York }
hemisphere: north
elevationsM: { base: 100, summit: 500 }
season: { typicalOpening: '12-01', typicalClosing: '03-31', spinupDays: 60 }
weather: { provider: open-meteo, model: ecmwf_ifs025 }
`);
const point = resort.points[0]!;

function hour(overrides: Partial<HourlyWeather>): HourlyWeather {
  return {
    time: '2026-01-15T00:00:00.000Z',
    airTempC: -5,
    relativeHumidityPct: 85,
    windSpeedMs: 2.5,
    windDirectionDeg: 270,
    shortwaveWm2: 0,
    precipitationMm: 0,
    rainMm: 0,
    snowfallCm: 0,
    cloudCoverPct: 50,
    surfacePressureHpa: 900,
    ...overrides,
  };
}

test('precipitation phase is the liquid share, null when dry or unknown', () => {
  assert.equal(precipitationPhase(hour({ precipitationMm: 0 })), null);
  assert.equal(
    precipitationPhase(hour({ precipitationMm: 2, rainMm: 2, snowfallCm: 0 })),
    1,
  );
  assert.equal(
    precipitationPhase(hour({ precipitationMm: 2, rainMm: 0, snowfallCm: 2 })),
    0,
  );
  // 1 mm rain + 1 cm snow (1 mm w.e. at 100 kg/m³) → half liquid.
  assert.equal(
    precipitationPhase(hour({ precipitationMm: 2, rainMm: 1, snowfallCm: 1 })),
    0.5,
  );
  assert.equal(
    precipitationPhase(hour({ precipitationMm: 2, rainMm: null })),
    null,
  );
});

test('toSmet writes SNOWPACK SI units and round-trips through the reader', () => {
  const text = toSmet(resort, point, [
    hour({}),
    hour({
      time: '2026-01-15T01:00:00.000Z',
      airTempC: null,
      precipitationMm: 1.5,
      rainMm: 0,
      snowfallCm: 1.5,
    }),
  ]);
  assert.match(text, /station_id {3}= BASE/);
  assert.match(text, /altitude {5}= 100/);
  assert.match(text, /fields {7}= timestamp TA RH VW DW ISWR PSUM PSUM_PH CLD/);
  const smet = parseSmet(text);
  assert.equal(smet.rows.length, 2);
  assert.equal(smet.rows[0]!.time.toISOString(), '2026-01-15T00:00:00.000Z');
  assert.deepEqual(smetColumn(smet, 'TA'), [268.15, null]);
  assert.deepEqual(smetColumn(smet, 'RH'), [0.85, 0.85]);
  assert.deepEqual(smetColumn(smet, 'PSUM'), [0, 1.5]);
  assert.deepEqual(smetColumn(smet, 'PSUM_PH'), [null, 0]);
  assert.deepEqual(smetColumn(smet, 'CLD'), [4, 4]);
});

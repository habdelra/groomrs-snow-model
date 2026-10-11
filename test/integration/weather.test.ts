import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { api, requireStack } from '../helpers/api.ts';

before(() => requireStack());

interface Hour {
  time: string;
  airTempC: number | null;
  relativeHumidityPct: number | null;
  windSpeedMs: number | null;
  windDirectionDeg: number | null;
  shortwaveWm2: number | null;
  precipitationMm: number | null;
  cloudCoverPct: number | null;
}
interface WeatherView {
  model: string;
  point: { id: string; elevationM: number };
  hours: Hour[];
}

const REQUIRED = [
  'airTempC',
  'relativeHumidityPct',
  'windSpeedMs',
  'windDirectionDeg',
  'shortwaveWm2',
  'precipitationMm',
  'cloudCoverPct',
] as const;

// A window in each resort's last winter, so the data is archived and stable.
const WINTER: Record<string, [string, string]> = {
  'blue-mountain-pa': ['2026-01-20T00:00:00Z', '2026-01-21T23:00:00Z'],
  'vail-co': ['2026-01-20T00:00:00Z', '2026-01-21T23:00:00Z'],
  'el-colorado-cl': ['2026-07-20T00:00:00Z', '2026-07-21T23:00:00Z'],
};

function assertPlausible(h: Hour, where: string) {
  for (const key of REQUIRED)
    assert.notEqual(h[key], null, `${where} ${h.time} ${key} is null`);
  assert.ok(
    h.airTempC! > -50 && h.airTempC! < 45,
    `${where} airTempC ${h.airTempC}`,
  );
  assert.ok(h.relativeHumidityPct! >= 0 && h.relativeHumidityPct! <= 100);
  assert.ok(h.windSpeedMs! >= 0 && h.windSpeedMs! < 80);
  assert.ok(h.shortwaveWm2! >= 0 && h.shortwaveWm2! < 1400);
  assert.ok(h.precipitationMm! >= 0);
  assert.ok(h.cloudCoverPct! >= 0 && h.cloudCoverPct! <= 100);
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

for (const [resortId, [start, end]] of Object.entries(WINTER)) {
  test(`${resortId}: real hourly weather at every point, colder at the summit`, async () => {
    const resort = await api<{ points: Array<{ id: string }> }>(
      `/v1/resorts/${resortId}`,
    );
    const temps: Record<string, number> = {};
    for (const { id } of resort.body.points) {
      const { status, body } = await api<WeatherView>(
        `/v1/resorts/${resortId}/weather?point=${id}&start=${start}&end=${end}`,
      );
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.model, 'ecmwf_ifs025');
      assert.equal(body.hours.length, 48);
      body.hours.forEach((h) => assertPlausible(h, `${resortId}/${id}`));
      temps[id] = mean(body.hours.map((h) => h.airTempC!));
    }
    assert.ok(
      temps.summit! < temps.base!,
      `summit ${temps.summit} should be colder than base ${temps.base}`,
    );
  });
}

test('the forecast for the coming days is available', async () => {
  const start = new Date();
  start.setUTCMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 72 * 3_600_000);
  const { status, body } = await api<WeatherView>(
    `/v1/resorts/vail-co/weather?point=summit&start=${start.toISOString()}&end=${end.toISOString()}`,
  );
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.hours.length, 73);
  body.hours.forEach((h) => assertPlausible(h, 'vail-co/summit forecast'));
});

test('weather requests are bounded and validated', async () => {
  assert.equal(
    (await api('/v1/resorts/vail-co/weather?point=nope')).status,
    400,
  );
  assert.equal(
    (
      await api(
        '/v1/resorts/vail-co/weather?start=2026-01-01T00:00:00Z&end=2026-03-01T00:00:00Z',
      )
    ).status,
    400,
  );
});

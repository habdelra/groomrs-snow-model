import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { parseResort } from '../../src/resorts/registry.ts';
import {
  monthsBetween,
  OpenMeteoClient,
} from '../../src/weather/open-meteo.ts';

const resort = parseResort(`
id: t
name: T
location: { country: US, region: X, latitude: 40, longitude: -75, timezone: UTC }
hemisphere: north
elevationsM: { base: 100, summit: 500 }
season: { typicalOpening: '12-01', typicalClosing: '03-31', spinupDays: 60 }
weather: { provider: open-meteo, model: ecmwf_ifs025 }
`);
const point = resort.points[0]!;

// A stand-in for the Open-Meteo HTTP API that answers any start/end range
// with one value per hour, and records the requests it saw.
function fakeOpenMeteo() {
  const requests: URL[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input));
    requests.push(url);
    const start = Date.parse(`${url.searchParams.get('start_date')}T00:00:00Z`);
    const end = Date.parse(`${url.searchParams.get('end_date')}T23:00:00Z`);
    const time: string[] = [];
    for (let t = start; t <= end; t += 3_600_000)
      time.push(new Date(t).toISOString().slice(0, 16));
    const col = (v: number | null) => time.map(() => v);
    return new Response(
      JSON.stringify({
        hourly: {
          time,
          temperature_2m: col(-3),
          relative_humidity_2m: col(80),
          wind_speed_10m: col(2),
          wind_direction_10m: col(180),
          shortwave_radiation: col(0),
          precipitation: col(0.2),
          rain: col(0),
          snowfall: col(0.2),
          cloud_cover: col(100),
          surface_pressure: col(null),
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return { requests, fetchImpl };
}

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'snow-model-test-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test('monthsBetween covers every month a range touches', () => {
  assert.deepEqual(
    monthsBetween(
      new Date('2025-12-31T23:00:00Z'),
      new Date('2026-02-01T00:00:00Z'),
    ).map((d) => d.toISOString().slice(0, 7)),
    ['2025-12', '2026-01', '2026-02'],
  );
});

test('hourly assembles a contiguous metric series from monthly chunks', async () => {
  const fake = fakeOpenMeteo();
  const client = new OpenMeteoClient({
    baseUrl: 'http://open-meteo.test',
    dataDir,
    now: () => new Date('2026-10-11T12:00:00Z'),
    fetchImpl: fake.fetchImpl,
  });
  const series = await client.hourly(
    resort,
    point,
    new Date('2026-01-31T22:00:00Z'),
    new Date('2026-02-01T02:00:00Z'),
  );
  assert.equal(series.hours.length, 5);
  assert.equal(series.hours[0]!.time, '2026-01-31T22:00:00.000Z');
  assert.equal(series.hours[0]!.airTempC, -3);
  assert.equal(series.hours[0]!.surfacePressureHpa, null);
  assert.equal(fake.requests.length, 2);
  const q = fake.requests[0]!.searchParams;
  assert.equal(q.get('elevation'), '100');
  assert.equal(q.get('models'), 'ecmwf_ifs025');
  assert.equal(q.get('wind_speed_unit'), 'ms');
  assert.equal(q.get('timezone'), 'UTC');
  assert.ok(series.sources.every((s) => s.archived));
});

test('archived months are served from the cache without refetching', async () => {
  const fake = fakeOpenMeteo();
  const opts = {
    baseUrl: 'http://open-meteo.test',
    dataDir,
    now: () => new Date('2026-10-11T12:00:00Z'),
    fetchImpl: fake.fetchImpl,
  };
  const range = [
    new Date('2026-01-10T00:00:00Z'),
    new Date('2026-01-11T00:00:00Z'),
  ] as const;
  await new OpenMeteoClient(opts).hourly(resort, point, ...range);
  await new OpenMeteoClient(opts).hourly(resort, point, ...range);
  assert.equal(fake.requests.length, 1);
});

test('the current month is refetched once the TTL lapses', async () => {
  const fake = fakeOpenMeteo();
  let now = new Date('2026-10-11T12:00:00Z');
  const client = new OpenMeteoClient({
    baseUrl: 'http://open-meteo.test',
    dataDir,
    ttlMinutes: 60,
    now: () => now,
    fetchImpl: fake.fetchImpl,
  });
  const range = [
    new Date('2026-10-11T00:00:00Z'),
    new Date('2026-10-12T00:00:00Z'),
  ] as const;
  await client.hourly(resort, point, ...range);
  now = new Date('2026-10-11T12:30:00Z');
  await client.hourly(resort, point, ...range);
  assert.equal(fake.requests.length, 1);
  now = new Date('2026-10-11T13:30:00Z');
  await client.hourly(resort, point, ...range);
  assert.equal(fake.requests.length, 2);
  // The current month is requested only as far as the forecast reaches.
  assert.equal(fake.requests[0]!.searchParams.get('end_date'), '2026-10-25');
});

test('a window beyond the forecast reach is refused', async () => {
  const client = new OpenMeteoClient({
    baseUrl: 'http://open-meteo.test',
    dataDir,
    now: () => new Date('2026-10-11T12:00:00Z'),
    fetchImpl: fakeOpenMeteo().fetchImpl,
  });
  await assert.rejects(
    client.hourly(
      resort,
      point,
      new Date('2026-10-11T00:00:00Z'),
      new Date('2026-11-30T00:00:00Z'),
    ),
    /forecast only reaches/,
  );
});

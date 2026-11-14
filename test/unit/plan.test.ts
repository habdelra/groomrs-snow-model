import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Observation } from '../../src/contract/v1.ts';
import {
  appliesToPoint,
  chainHash,
  chainSeed,
  chooseHoursToAdd,
  chooseHoursToRemove,
  defaultGroomingHourUtc,
  groomingForDay,
  MAX_TECH_HOURS_PER_DAY,
  observedTechHours,
  predictSnowmaking,
  SNOWMAKING_MAX_WET_BULB_C,
  snowmakingHours,
  techHoursForDay,
  utcOffsetHours,
  wetBulbC,
  type DayPlan,
} from '../../src/observations/plan.ts';
import type { StoredObservation } from '../../src/observations/store.ts';
import { parseResort } from '../../src/resorts/registry.ts';
import type { HourlyWeather } from '../../src/weather/open-meteo.ts';

// Two points: base 100 m and summit 500 m.
const resort = parseResort(`
id: test-resort
name: Test
location: { country: US, region: X, latitude: 40.5, longitude: -75.25, timezone: America/New_York }
hemisphere: north
elevationsM: { base: 100, summit: 500 }
season: { typicalOpening: '12-01', typicalClosing: '03-31', spinupDays: 60 }
weather: { provider: open-meteo, model: ecmwf_ifs025 }
`);
const base = resort.points[0]!;
const summit = resort.points[1]!;
const day = new Date('2026-01-16T00:00:00Z');

function stored(payload: Observation): StoredObservation {
  return {
    id: payload.key,
    resortId: resort.id,
    season: '2025/26',
    kind: payload.kind,
    key: payload.key,
    revision: 1,
    status: payload.status,
    skiDay: payload.skiDay,
    validFrom: new Date(payload.validFrom),
    validTo: new Date(payload.validTo ?? payload.validFrom),
    source: payload.source,
    payload,
    observedAt: new Date(payload.observedAt),
    receivedAt: new Date(payload.observedAt),
  };
}

function grooming(
  status: 'groomed' | 'not_groomed' | 'unknown',
  at: string,
  extra: Partial<Observation> = {},
): StoredObservation {
  return stored({
    kind: 'grooming',
    key: `grooming/${at}/${status}`,
    skiDay: at.slice(0, 10),
    status,
    validFrom: at,
    observedAt: at,
    source: 'webcam',
    ...extra,
  } as Observation);
}

function weatherHour(time: string, airTempC: number): HourlyWeather {
  return {
    time,
    airTempC,
    relativeHumidityPct: 60,
    windSpeedMs: 2,
    windDirectionDeg: 270,
    shortwaveWm2: 0,
    precipitationMm: 0,
    rainMm: 0,
    snowfallCm: 0,
    cloudCoverPct: 50,
    surfacePressureHpa: 1000,
  };
}

test('wet-bulb is below air temperature in dry air and close to it when saturated', () => {
  assert.ok(wetBulbC(-5, 40) < -7);
  assert.ok(Math.abs(wetBulbC(-5, 100) - -5) < 0.6);
  // The textbook check for the formula: 20 degC at 50% is about 13.7 degC.
  assert.ok(Math.abs(wetBulbC(20, 50) - 13.7) < 0.2);
});

test('only hours cold enough to make snow are snowmaking hours', () => {
  const cold = snowmakingHours([
    weatherHour('2026-01-16T00:00:00.000Z', -8),
    weatherHour('2026-01-16T01:00:00.000Z', 2),
    { ...weatherHour('2026-01-16T02:00:00.000Z', -8), airTempC: null },
  ]);
  assert.deepEqual([...cold.keys()], ['2026-01-16T00:00:00.000Z']);
  assert.ok(cold.get('2026-01-16T00:00:00.000Z')! <= SNOWMAKING_MAX_WET_BULB_C);
});

test('an observation applies to the nearest point, or to all when it names none', () => {
  assert.equal(appliesToPoint(resort, summit, { elevationM: 470 }), true);
  assert.equal(appliesToPoint(resort, base, { elevationM: 470 }), false);
  assert.equal(appliesToPoint(resort, base, { location: 'base' }), true);
  assert.equal(appliesToPoint(resort, summit, { location: 'base' }), false);
  assert.equal(appliesToPoint(resort, base, { location: 'resort' }), true);
  assert.equal(appliesToPoint(resort, summit, { location: 'resort' }), true);
  assert.equal(appliesToPoint(resort, base, {}), true);
  // A named location wins over an elevation sent with it.
  assert.equal(
    appliesToPoint(resort, base, { location: 'summit', elevationM: 100 }),
    false,
  );
});

test('a sighting grooms on the first whole hour after it', () => {
  const plan = groomingForDay(
    resort,
    summit,
    day,
    [grooming('groomed', '2026-01-16T10:20:00Z')],
    'none',
  );
  assert.deepEqual(plan, {
    hourUtc: 11,
    basis: 'observed',
    observationKey: 'grooming/2026-01-16T10:20:00Z/groomed',
    source: 'webcam',
  });
});

test('the grooming hour stays inside the hours SNOWPACK can fire on', () => {
  const early = groomingForDay(
    resort,
    summit,
    day,
    [grooming('groomed', '2026-01-16T00:00:00Z')],
    'none',
  );
  assert.equal(early?.hourUtc, 1);
  const late = groomingForDay(
    resort,
    summit,
    day,
    [grooming('groomed', '2026-01-16T23:40:00Z')],
    'none',
  );
  assert.equal(late?.hourUtc, 23);
});

test('a watched night with no groomer turns grooming off, even with a nightly default', () => {
  assert.equal(
    groomingForDay(
      resort,
      summit,
      day,
      [grooming('not_groomed', '2026-01-16T12:00:00Z')],
      'nightly',
    ),
    null,
  );
});

test('unknown is never read as not groomed: it falls back to the default', () => {
  const unknown = [grooming('unknown', '2026-01-16T12:00:00Z')];
  assert.equal(groomingForDay(resort, summit, day, unknown, 'none'), null);
  const nightly = groomingForDay(resort, summit, day, unknown, 'nightly');
  assert.equal(nightly?.basis, 'default');
  assert.equal(nightly?.observationKey, null);
});

test('grooming seen at another point or on another day does not apply', () => {
  const seen = [
    grooming('groomed', '2026-01-16T10:20:00Z', { elevationM: 470 }),
  ];
  assert.equal(groomingForDay(resort, base, day, seen, 'none'), null);
  assert.equal(
    groomingForDay(
      resort,
      summit,
      new Date('2026-01-17T00:00:00Z'),
      seen,
      'none',
    ),
    null,
  );
});

test('the default overnight pass is 04:00 resort time, in UTC', () => {
  assert.equal(utcOffsetHours('America/New_York', day), -5);
  assert.equal(defaultGroomingHourUtc(resort, day), 9);
  // Daylight time moves it an hour.
  assert.equal(
    defaultGroomingHourUtc(resort, new Date('2026-04-01T00:00:00Z')),
    8,
  );
});

test('a snowmaking sighting turns on one cold hour in four inside its window', () => {
  const hours = Array.from({ length: 12 }, (_, i) =>
    weatherHour(
      new Date(day.getTime() + i * 3_600_000).toISOString(),
      i === 2 ? 3 : -8,
    ),
  );
  const cold = snowmakingHours(hours);
  const seen = stored({
    kind: 'snowmaking',
    key: 'snowmaking/1',
    skiDay: '2026-01-16',
    status: 'observed',
    validFrom: '2026-01-16T00:30:00Z',
    validTo: '2026-01-16T09:10:00Z',
    observedAt: '2026-01-16T09:10:00Z',
    source: 'webcam',
  });
  // Cold hours in the window are 01, 03..09 (02 is too warm); every fourth.
  assert.deepEqual(
    [...observedTechHours(resort, summit, [seen], cold)],
    ['2026-01-16T01:00:00.000Z', '2026-01-16T06:00:00.000Z'],
  );
  const dark = stored({
    ...seen.payload,
    status: 'not_observed',
  } as Observation);
  assert.equal(observedTechHours(resort, summit, [dark], cold).size, 0);
});

test('added hours prefer sightings, then the coldest, and skip hours in use', () => {
  const cold = new Map([
    ['2026-01-16T01:00:00.000Z', -6],
    ['2026-01-16T02:00:00.000Z', -12],
    ['2026-01-16T03:00:00.000Z', -9],
    ['2026-01-16T04:00:00.000Z', -4],
    ['2026-01-18T04:00:00.000Z', -20],
  ]);
  const window = {
    from: new Date('2026-01-16T00:00:00Z'),
    to: new Date('2026-01-17T00:00:00Z'),
  };
  const chosen = chooseHoursToAdd(
    3,
    window,
    cold,
    new Set(['2026-01-16T04:00:00.000Z']),
    new Set(['2026-01-16T02:00:00.000Z']),
  );
  // 04:00 was sighted; 02:00 is taken; 18 Jan is outside the window.
  assert.deepEqual(chosen, [
    '2026-01-16T01:00:00.000Z',
    '2026-01-16T03:00:00.000Z',
    '2026-01-16T04:00:00.000Z',
  ]);
});

test('no day takes more machine-snow hours than its cap', () => {
  const cold = new Map<string, number>();
  for (let i = 0; i < 24; i++)
    cold.set(new Date(day.getTime() + i * 3_600_000).toISOString(), -10);
  const chosen = chooseHoursToAdd(
    30,
    { from: day, to: new Date('2026-01-17T00:00:00Z') },
    cold,
    new Set(),
    new Set(),
  );
  assert.equal(chosen.length, MAX_TECH_HOURS_PER_DAY);
});

test('hours are taken back most recent first, inside the window only', () => {
  const inUse = new Set([
    '2026-01-14T03:00:00.000Z',
    '2026-01-16T03:00:00.000Z',
    '2026-01-16T05:00:00.000Z',
    '2026-01-16T07:00:00.000Z',
  ]);
  assert.deepEqual(
    chooseHoursToRemove(
      2,
      { from: day, to: new Date('2026-01-17T00:00:00Z') },
      inUse,
    ),
    ['2026-01-16T05:00:00.000Z', '2026-01-16T07:00:00.000Z'],
  );
});

test("a day's run carries on-hours at both of its ends", () => {
  const all = new Set([
    '2026-01-16T00:00:00.000Z',
    '2026-01-16T05:00:00.000Z',
    '2026-01-17T00:00:00.000Z',
    '2026-01-17T01:00:00.000Z',
  ]);
  assert.deepEqual(techHoursForDay(day, all), [
    '2026-01-16T00:00:00.000Z',
    '2026-01-16T05:00:00.000Z',
    '2026-01-17T00:00:00.000Z',
  ]);
});

test('the chain hash changes with any managed input and with where it started', () => {
  const plan: DayPlan = {
    day: day.toISOString(),
    grooming: {
      hourUtc: 11,
      basis: 'observed',
      observationKey: 'k',
      source: 'webcam',
    },
    techHours: ['2026-01-16T05:00:00.000Z'],
  };
  const seed = chainSeed('checkpoint-a');
  const h = chainHash(seed, plan);
  assert.equal(chainHash(seed, { ...plan }), h);
  assert.notEqual(chainHash(seed, { ...plan, grooming: null }), h);
  assert.notEqual(
    chainHash(seed, {
      ...plan,
      grooming: { ...plan.grooming!, hourUtc: 12 },
    }),
    h,
  );
  assert.notEqual(chainHash(seed, { ...plan, techHours: [] }), h);
  assert.notEqual(chainHash(chainSeed('checkpoint-b'), plan), h);
  // Which observation asked for the pass does not change the snow.
  assert.equal(
    chainHash(seed, {
      ...plan,
      grooming: { ...plan.grooming!, observationKey: 'other' },
    }),
    h,
  );
});

function coldHours(
  fromIso: string,
  count: number,
  tw = -8,
): Map<string, number> {
  const out = new Map<string, number>();
  const start = Date.parse(fromIso);
  for (let i = 0; i < count; i++)
    out.set(new Date(start + i * 3_600_000).toISOString(), tw - (i % 5));
  return out;
}

test('snowmaking ahead follows the share of recent cold the resort used', () => {
  const target = new Date('2026-01-16T00:00:00Z');
  // 40 cold hours in the last days, snow made in 10 of them: a quarter.
  const pastCold = coldHours('2026-01-13T00:00:00.000Z', 40);
  const pastMachineSnow = new Set([...pastCold.keys()].slice(0, 10));
  const futureCold = new Map([
    ...coldHours('2026-01-16T00:00:00.000Z', 12),
    ...coldHours('2026-01-17T02:00:00.000Z', 4),
  ]);
  const p = predictSnowmaking({
    target,
    pastCold,
    pastMachineSnow,
    futureCold,
  });
  assert.equal(p.reason, 'recent_production');
  assert.equal(p.utilisation, 0.25);
  assert.equal(p.recentColdHours, 40);
  assert.equal(p.recentMachineSnowHours, 10);
  // A quarter of 12 cold hours on the 16th, a quarter of 4 on the 17th.
  assert.equal(p.hours.filter((h) => h.startsWith('2026-01-16')).length, 3);
  assert.equal(p.hours.filter((h) => h.startsWith('2026-01-17')).length, 1);
  // Every predicted hour is one of the cold hours ahead.
  assert.ok(p.hours.every((h) => futureCold.has(h)));
});

test('predicted hours are scaled by what a recent hour left on the ground', () => {
  const target = new Date('2026-01-16T00:00:00Z');
  const pastCold = coldHours('2026-01-13T00:00:00.000Z', 40);
  const pastMachineSnow = new Set([...pastCold.keys()].slice(0, 20));
  // Half of 16 cold hours a day for three days: 24 hours unscaled.
  const futureCold = new Map([
    ...coldHours('2026-01-16T00:00:00.000Z', 16),
    ...coldHours('2026-01-17T00:00:00.000Z', 16),
    ...coldHours('2026-01-18T00:00:00.000Z', 16),
  ]);
  const opts = { target, pastCold, pastMachineSnow, futureCold };
  assert.equal(predictSnowmaking(opts).hours.length, 24);
  // 20 recent hours left 15 cm: 0.75 cm an hour, a quarter of what a cold
  // hour makes, so a quarter of the hours. Fractions carry between days.
  const scaled = predictSnowmaking({ ...opts, machineSnowDepthCm: 15 });
  assert.equal(scaled.depthPerHourCm, 0.75);
  assert.equal(scaled.hours.length, 6);
  // Machine snow that melted away still leaves a little ahead, never none.
  const melted = predictSnowmaking({ ...opts, machineSnowDepthCm: -3 });
  assert.equal(melted.depthPerHourCm, 0);
  assert.equal(melted.hours.length, 2);
});

test('a resort not seen making snow lately gets none ahead', () => {
  const target = new Date('2026-01-16T00:00:00Z');
  const pastCold = coldHours('2026-01-13T00:00:00.000Z', 40);
  const futureCold = coldHours('2026-01-16T00:00:00.000Z', 12);
  const none = predictSnowmaking({
    target,
    pastCold,
    pastMachineSnow: new Set(),
    futureCold,
  });
  assert.deepEqual(none.hours, []);
  assert.equal(none.reason, 'none_recently');
  // Snow made a month ago says nothing about this week.
  const old = predictSnowmaking({
    target,
    pastCold,
    pastMachineSnow: new Set(['2025-12-10T03:00:00.000Z']),
    futureCold,
  });
  assert.equal(old.reason, 'none_recently');
});

test('too few cold hours behind it, and nothing is predicted', () => {
  const target = new Date('2026-01-16T00:00:00Z');
  const pastCold = coldHours('2026-01-15T00:00:00.000Z', 5);
  const p = predictSnowmaking({
    target,
    pastCold,
    pastMachineSnow: new Set([...pastCold.keys()]),
    futureCold: coldHours('2026-01-16T00:00:00.000Z', 12),
  });
  assert.deepEqual(p.hours, []);
  assert.equal(p.utilisation, null);
  assert.equal(p.reason, 'too_few_cold_hours');
});

test('predicted snowmaking never uses more than the share guns can run', () => {
  const target = new Date('2026-01-16T00:00:00Z');
  const pastCold = coldHours('2026-01-13T00:00:00.000Z', 40);
  const p = predictSnowmaking({
    target,
    pastCold,
    pastMachineSnow: new Set(pastCold.keys()),
    futureCold: coldHours('2026-01-16T00:00:00.000Z', 20),
  });
  assert.equal(p.utilisation, 0.6);
  assert.equal(p.hours.length, 12);
});

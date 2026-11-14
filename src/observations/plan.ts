import { createHash } from 'node:crypto';
import type { ModelPoint, Resort } from '../resorts/registry.ts';
import type { HourlyWeather } from '../weather/open-meteo.ts';
import type { StoredObservation } from './store.ts';

// Turns stored observations into what SNOWPACK is given for each UTC day at
// one model point: whether to groom and at what hour, and which hours get
// machine snow. Pure functions; the managed chain (src/jobs/managed.ts) runs
// them.

// Changes whenever a rule below changes what a given set of observations
// produces, so states built under older rules are not reused.
export const MANAGED_RULES_VERSION = 'managed/1';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// --- Machine snow -----------------------------------------------------------
//
// SNOWPACK makes technical snow on any step where the forcing column
// PSUM_TECH is positive. Measured on 3.7.0 (see the snowpack-runtime skill):
// an "on" hour is four 15-minute steps of TECH_MM_PER_STEP, and adds roughly
// 3 cm of snow at a wet-bulb of -10 degC. Amounts under about 0.6 mm per step
// are dropped by SNOWPACK, so the unit of control here is whole hours, not
// millimetres.
export const TECH_MM_PER_STEP = 1.0;
// Rough depth one on-hour adds, used only for the first guess of how many
// hours close a gap. The chain measures the real effect and adjusts.
export const TECH_CM_PER_HOUR_GUESS = 3.0;
// Guns need a cold wet-bulb. SNOWPACK itself has no such limit, so hours
// warmer than this never get machine snow.
export const SNOWMAKING_MAX_WET_BULB_C = -2.5;
// Of the cold hours inside an observed snowmaking window, one in this many is
// on. An observation says guns ran, never how much they made; base depth is
// what corrects the amount.
export const OBSERVED_SNOWMAKING_EVERY_NTH_HOUR = 4;

// --- Base depth -------------------------------------------------------------
//
// Share of the gap between reported and modelled depth closed per reading. A
// resort's figure is rough, so repeated readings close the gap over days.
export const BASE_DEPTH_GAIN = 0.5;
// Gaps smaller than this are left alone: a report in whole inches is no finer
// than about 2.5 cm.
export const BASE_DEPTH_TOLERANCE_CM = 5;
// How far back machine snow may be placed to explain a reading.
export const BASE_DEPTH_WINDOW_DAYS = 14;
// Machine-snow hours a single day may carry.
export const MAX_TECH_HOURS_PER_DAY = 14;
// The least a predicted hour count is scaled down to.
export const SNOWMAKING_MIN_HOUR_SCALE = 0.1;

// --- Predicted snowmaking ---------------------------------------------------
//
// Nobody has observed the nights ahead. What the resort has been doing is the
// evidence for what it will do: of the hours cold enough to make snow over
// the last weeks, the share it used. That share is applied to the cold hours
// the forecast holds. A resort that has stopped making snow drops to zero by
// itself, and a resort never seen to make any gets none.
export const SNOWMAKING_LOOKBACK_DAYS = 14;
// Guns never run every cold hour: wind, water and crews limit it.
export const SNOWMAKING_MAX_UTILISATION = 0.6;
// With fewer cold hours than this behind it, a share says too little.
export const SNOWMAKING_MIN_COLD_HOURS = 12;

// --- Grooming ---------------------------------------------------------------
//
// SNOWPACK grooms on the step that lands exactly on GROOMING_HOUR:00, and a
// run started at 00:00 skips its first step, so hour 0 is never used.
export const MIN_GROOMING_HOUR = 1;
export const MAX_GROOMING_HOUR = 23;
// The hour (resort-local) a usual overnight pass is assumed to finish.
export const DEFAULT_GROOMING_LOCAL_HOUR = 4;

export function hourIso(d: Date | number): string {
  const t = typeof d === 'number' ? d : d.getTime();
  return new Date(Math.floor(t / HOUR_MS) * HOUR_MS).toISOString();
}

export function dayIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Wet-bulb temperature from air temperature and relative humidity (Stull
// 2011), good to a few tenths of a degree in the range guns operate in.
export function wetBulbC(
  airTempC: number,
  relativeHumidityPct: number,
): number {
  const rh = Math.min(100, Math.max(1, relativeHumidityPct));
  return (
    airTempC * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
    Math.atan(airTempC + rh) -
    Math.atan(rh - 1.676331) +
    0.00391838 * rh ** 1.5 * Math.atan(0.023101 * rh) -
    4.686035
  );
}

// Hours cold enough to make snow, with their wet-bulb temperature.
export function snowmakingHours(weather: HourlyWeather[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const h of weather) {
    if (h.airTempC === null || h.relativeHumidityPct === null) continue;
    const tw = wetBulbC(h.airTempC, h.relativeHumidityPct);
    if (tw <= SNOWMAKING_MAX_WET_BULB_C) out.set(h.time, tw);
  }
  return out;
}

// Whether an observation says something about this model point. A named
// location or an elevation picks the nearest point; an observation with
// neither, or one for the resort as a whole, applies to every point.
export function appliesToPoint(
  resort: Resort,
  point: ModelPoint,
  obs: { location?: string | undefined; elevationM?: number | undefined },
): boolean {
  let elevation: number | undefined = obs.elevationM;
  if (obs.location && obs.location !== 'resort') {
    const named = resort.points.find((p) => p.id === obs.location);
    if (named) return named.id === point.id;
    const { base, summit } = resort.elevationsM;
    elevation =
      obs.location === 'base'
        ? base
        : obs.location === 'summit'
          ? summit
          : (base + summit) / 2;
  }
  if (elevation === undefined) return true;
  const nearest = resort.points.reduce((best, p) =>
    Math.abs(p.elevationM - elevation) < Math.abs(best.elevationM - elevation)
      ? p
      : best,
  );
  return nearest.id === point.id;
}

// The UTC offset of a time zone at an instant, in hours.
export function utcOffsetHours(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(at);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
  );
  return Math.round((asUtc - at.getTime()) / 60_000) / 60;
}

function clampGroomingHour(hour: number): number {
  return Math.min(MAX_GROOMING_HOUR, Math.max(MIN_GROOMING_HOUR, hour));
}

// The UTC hour a usual overnight pass falls on for a given UTC day.
export function defaultGroomingHourUtc(resort: Resort, day: Date): number {
  const offset = utcOffsetHours(resort.location.timezone, day);
  const hour = (((DEFAULT_GROOMING_LOCAL_HOUR - offset) % 24) + 24) % 24;
  return clampGroomingHour(Math.round(hour));
}

export interface GroomingPlan {
  hourUtc: number;
  basis: 'observed' | 'default';
  observationKey: string | null;
  // Who saw it: a webcam or a person. Null for an assumed pass.
  source: string | null;
}

export interface DayPlan {
  // 00:00 UTC of the day this plan covers.
  day: string;
  grooming: GroomingPlan | null;
  // Hours (ISO, on the hour) with machine snow, from this day's 00:00 through
  // the next day's 00:00 inclusive: a run reads forcing at both ends.
  techHours: string[];
}

// Grooming for one UTC day. A sighting sets the hour; a watched night with no
// groomer turns it off; anything else falls back to the caller's default.
export function groomingForDay(
  resort: Resort,
  point: ModelPoint,
  day: Date,
  observations: StoredObservation[],
  groomingDefault: 'none' | 'nightly',
): GroomingPlan | null {
  const start = day.getTime();
  const end = start + DAY_MS;
  const today = observations.filter(
    (o) =>
      o.kind === 'grooming' &&
      o.validFrom.getTime() >= start &&
      o.validFrom.getTime() < end &&
      appliesToPoint(resort, point, o.payload),
  );
  const groomed = today.filter((o) => o.status === 'groomed');
  if (groomed.length) {
    // The pass is applied on the first whole hour after the last sighting.
    const last = groomed.reduce((a, b) => (b.validFrom > a.validFrom ? b : a));
    const hour = Math.ceil((last.validFrom.getTime() - start) / HOUR_MS);
    return {
      hourUtc: clampGroomingHour(hour),
      basis: 'observed',
      observationKey: last.key,
      source: last.source,
    };
  }
  if (today.some((o) => o.status === 'not_groomed')) return null;
  if (groomingDefault === 'nightly') {
    return {
      hourUtc: defaultGroomingHourUtc(resort, day),
      basis: 'default',
      observationKey: null,
      source: null,
    };
  }
  return null;
}

// Whether someone watched this point on this UTC day and saw no groomer.
export function sawNoGroomer(
  resort: Resort,
  point: ModelPoint,
  day: Date,
  observations: StoredObservation[],
): boolean {
  const start = day.getTime();
  return observations.some(
    (o) =>
      o.kind === 'grooming' &&
      o.status === 'not_groomed' &&
      o.validFrom.getTime() >= start &&
      o.validFrom.getTime() < start + DAY_MS &&
      appliesToPoint(resort, point, o.payload),
  );
}

// Machine-snow hours implied by snowmaking sightings alone: one cold hour in
// every few inside each window where guns were seen.
export function observedTechHours(
  resort: Resort,
  point: ModelPoint,
  observations: StoredObservation[],
  cold: Map<string, number>,
): Set<string> {
  const out = new Set<string>();
  for (const o of observations) {
    if (o.kind !== 'snowmaking' || o.status !== 'observed') continue;
    if (!appliesToPoint(resort, point, o.payload)) continue;
    let n = 0;
    for (
      let t = Math.ceil(o.validFrom.getTime() / HOUR_MS) * HOUR_MS;
      t <= o.validTo.getTime();
      t += HOUR_MS
    ) {
      const iso = new Date(t).toISOString();
      if (!cold.has(iso)) continue;
      if (n % OBSERVED_SNOWMAKING_EVERY_NTH_HOUR === 0) out.add(iso);
      n++;
    }
  }
  return out;
}

// Cold hours inside any window where guns were seen, used to prefer those
// hours when base depth asks for more machine snow.
export function sightedHours(
  resort: Resort,
  point: ModelPoint,
  observations: StoredObservation[],
): Set<string> {
  const out = new Set<string>();
  for (const o of observations) {
    if (o.kind !== 'snowmaking' || o.status !== 'observed') continue;
    if (!appliesToPoint(resort, point, o.payload)) continue;
    for (
      let t = Math.ceil(o.validFrom.getTime() / HOUR_MS) * HOUR_MS;
      t <= o.validTo.getTime();
      t += HOUR_MS
    )
      out.add(new Date(t).toISOString());
  }
  return out;
}

// Picks the hours to add machine snow in, to explain a base-depth reading:
// hours where guns were seen first, then the coldest, never more than a
// day's cap on any one day and never an hour already in use.
export function chooseHoursToAdd(
  count: number,
  window: { from: Date; to: Date },
  cold: Map<string, number>,
  sighted: Set<string>,
  inUse: Set<string>,
): string[] {
  const perDay = new Map<string, number>();
  for (const h of inUse) {
    const d = h.slice(0, 10);
    perDay.set(d, (perDay.get(d) ?? 0) + 1);
  }
  const candidates = [...cold.entries()]
    .filter(([iso]) => {
      const t = Date.parse(iso);
      return (
        t >= window.from.getTime() && t < window.to.getTime() && !inUse.has(iso)
      );
    })
    .sort(([a, twA], [b, twB]) => {
      const sa = sighted.has(a) ? 0 : 1;
      const sb = sighted.has(b) ? 0 : 1;
      return sa - sb || twA - twB || (a < b ? -1 : 1);
    });
  const chosen: string[] = [];
  for (const [iso] of candidates) {
    if (chosen.length >= count) break;
    const d = iso.slice(0, 10);
    const used = perDay.get(d) ?? 0;
    if (used >= MAX_TECH_HOURS_PER_DAY) continue;
    perDay.set(d, used + 1);
    chosen.push(iso);
  }
  return chosen.sort();
}

// Picks machine-snow hours to take back when the model is deeper than the
// resort reports: the most recent in the window first.
export function chooseHoursToRemove(
  count: number,
  window: { from: Date; to: Date },
  inUse: Set<string>,
): string[] {
  return [...inUse]
    .filter((iso) => {
      const t = Date.parse(iso);
      return t >= window.from.getTime() && t < window.to.getTime();
    })
    .sort()
    .reverse()
    .slice(0, count)
    .sort();
}

export interface SnowmakingPrediction {
  hours: string[];
  // Share of recent cold hours the resort made snow in; null when there is
  // too little to go on.
  utilisation: number | null;
  recentColdHours: number;
  recentMachineSnowHours: number;
  // Depth one recent machine-snow hour left on the ground; null when unknown.
  depthPerHourCm: number | null;
  reason: 'recent_production' | 'none_recently' | 'too_few_cold_hours';
}

// Machine-snow hours to expect over the forecast, from how much of the recent
// cold the resort used: on each forecast day, that share of its cold hours,
// coldest first.
//
// The coldest hours make far more snow than the hours the past was fitted
// with, so the count is scaled by what a recent hour actually left on the
// ground (`machineSnowDepthCm` over the recent hours) against what a cold
// hour makes. Without that the forecast outgrows the resort's own record
// several times over.
export function predictSnowmaking(opts: {
  target: Date;
  pastCold: Map<string, number>;
  pastMachineSnow: ReadonlySet<string>;
  futureCold: Map<string, number>;
  // Managed depth less natural depth at the start of the forecast.
  machineSnowDepthCm?: number;
}): SnowmakingPrediction {
  const from = opts.target.getTime() - SNOWMAKING_LOOKBACK_DAYS * DAY_MS;
  const recent = (iso: string) => {
    const t = Date.parse(iso);
    return t >= from && t < opts.target.getTime();
  };
  const recentColdHours = [...opts.pastCold.keys()].filter(recent).length;
  const recentMachineSnowHours = [...opts.pastMachineSnow].filter(
    recent,
  ).length;
  const depthPerHourCm =
    opts.machineSnowDepthCm == null || recentMachineSnowHours === 0
      ? null
      : Math.round(
          (Math.max(0, opts.machineSnowDepthCm) / recentMachineSnowHours) * 100,
        ) / 100;
  const base = {
    hours: [],
    recentColdHours,
    recentMachineSnowHours,
    depthPerHourCm,
  };
  if (recentMachineSnowHours === 0)
    return { ...base, utilisation: 0, reason: 'none_recently' };
  if (recentColdHours < SNOWMAKING_MIN_COLD_HOURS)
    return { ...base, utilisation: null, reason: 'too_few_cold_hours' };
  const utilisation = Math.min(
    SNOWMAKING_MAX_UTILISATION,
    recentMachineSnowHours / recentColdHours,
  );
  const byDay = new Map<string, Array<[string, number]>>();
  for (const [iso, tw] of opts.futureCold) {
    if (Date.parse(iso) < opts.target.getTime()) continue;
    const day = iso.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), [iso, tw]]);
  }
  const scale =
    depthPerHourCm == null
      ? 1
      : Math.min(
          1,
          Math.max(
            SNOWMAKING_MIN_HOUR_SCALE,
            depthPerHourCm / TECH_CM_PER_HOUR_GUESS,
          ),
        );
  const hours: string[] = [];
  // Fractions of an hour carry to the next day, so a small daily share still
  // adds up over the week.
  let carry = 0;
  for (const day of [...byDay.keys()].sort()) {
    const cold = byDay.get(day)!;
    const want = utilisation * cold.length * scale + carry;
    const count = Math.min(MAX_TECH_HOURS_PER_DAY, Math.floor(want + 1e-9));
    carry = want - count;
    cold
      .sort(([a, twA], [b, twB]) => twA - twB || (a < b ? -1 : 1))
      .slice(0, count)
      .forEach(([iso]) => hours.push(iso));
  }
  return {
    ...base,
    hours: hours.sort(),
    utilisation: Math.round(utilisation * 100) / 100,
    reason: 'recent_production',
  };
}

// The machine-snow hours a day's run needs: every on-hour from its 00:00
// through the next 00:00 inclusive.
export function techHoursForDay(day: Date, all: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i <= 24; i++) {
    const iso = new Date(day.getTime() + i * HOUR_MS).toISOString();
    if (all.has(iso)) out.push(iso);
  }
  return out;
}

// Chains a day's plan onto the hash of everything before it. Two states with
// the same hash were built from the same managed inputs.
export function chainHash(previous: string, plan: DayPlan): string {
  return createHash('sha256')
    .update(previous)
    .update(
      JSON.stringify([
        plan.day,
        plan.grooming ? [plan.grooming.hourUtc, plan.grooming.basis] : null,
        plan.techHours,
      ]),
    )
    .digest('hex')
    .slice(0, 24);
}

export function chainSeed(startCheckpointId: string): string {
  return `${MANAGED_RULES_VERSION}:${startCheckpointId}`;
}

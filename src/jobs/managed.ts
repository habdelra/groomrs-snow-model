import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ManagedPoint } from '../contract/v1.ts';
import { withClient } from '../db.ts';
import {
  BASE_DEPTH_GAIN,
  BASE_DEPTH_TOLERANCE_CM,
  BASE_DEPTH_WINDOW_DAYS,
  chainHash,
  chainSeed,
  chooseHoursToAdd,
  chooseHoursToRemove,
  dayIso,
  groomingForDay,
  observedTechHours,
  sightedHours,
  snowmakingHours,
  TECH_CM_PER_HOUR_GUESS,
  TECH_MM_PER_STEP,
  techHoursForDay,
  appliesToPoint,
  type DayPlan,
} from '../observations/plan.ts';
import type { StoredObservation } from '../observations/store.ts';
import type { ModelPoint, Resort } from '../resorts/registry.ts';
import { addDays, startOfUtcDay } from '../season.ts';
import type { PointRunResult } from '../snowpack/point-run.ts';
import type { HourlyWeather } from '../weather/open-meteo.ts';

// The managed chain: a point's snowpack advanced one UTC day at a time, each
// day's SNOWPACK run given that day's grooming and machine snow. It starts
// from the season's spin-up state and saves a state at every day boundary.
//
// Each saved state carries a hash of every managed input up to its time. To
// reach a day, the chain reuses the newest saved state whose hash matches the
// inputs as they stand now and runs forward from there. An amended
// observation changes the hash from its day on, so those days run again and
// nothing has to be invalidated by hand.

const DAY_MS = 86_400_000;
// Trial runs allowed when sizing the machine snow that answers one reading.
const MAX_TRIALS = 4;
// A trial within this of the wanted change is good enough.
const TRIAL_TOLERANCE_CM = 2;

export interface Checkpoint {
  id: string;
  lineageId: string;
  validTime: Date;
  snoPath: string;
  snowDepthCm: number;
}

// What the chain needs from the model that owns it.
export interface ManagedHost {
  // The spin-up state the lineage starts from.
  startCheckpoint(point: ModelPoint): Promise<Checkpoint | undefined>;
  // One day's SNOWPACK run from a saved state.
  runDay(
    point: ModelPoint,
    from: Date,
    initialSno: string,
    plan: DayPlan,
  ): Promise<PointRunResult>;
  // Saves the state a day's run ended in.
  saveManaged(
    point: ModelPoint,
    from: Date,
    to: Date,
    run: PointRunResult,
    input: Checkpoint,
    inputsHash: string,
  ): Promise<Checkpoint>;
  weather(point: ModelPoint, from: Date, to: Date): Promise<HourlyWeather[]>;
}

interface Resolution {
  observationKey: string;
  comparedAt: string;
  reportedCm: number;
  modelledBeforeCm: number;
  modelledAfterCm: number;
  addHours: string[];
  removeHours: string[];
  residualCm: number;
  note: string | null;
}

export interface ManagedOutcome {
  checkpoint: Checkpoint;
  applied: Omit<ManagedPoint, 'naturalSnowDepthCm' | 'forecast'>;
  // What a snowmaking prediction needs: the hours cold enough to make snow
  // up to the target, and the machine-snow hours the chain ended up with.
  coldHours: Map<string, number>;
  machineSnowHours: Set<string>;
}

function ceilUtcDay(d: Date): Date {
  const start = startOfUtcDay(d);
  return start.getTime() === d.getTime() ? start : addDays(start, 1);
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export async function advanceManaged(
  host: ManagedHost,
  opts: {
    resort: Resort;
    point: ModelPoint;
    lineageId: string;
    target: Date;
    observations: StoredObservation[];
    groomingDefault: 'none' | 'nightly';
  },
): Promise<ManagedOutcome | undefined> {
  const { resort, point, lineageId, target, observations } = opts;
  const start = await host.startCheckpoint(point);
  if (!start) return undefined;
  const t0 = start.validTime;
  const days = Math.max(
    0,
    Math.round((target.getTime() - t0.getTime()) / DAY_MS),
  );
  const dayStart = (i: number) => new Date(t0.getTime() + i * DAY_MS);

  const weather = days > 0 ? await host.weather(point, t0, target) : [];
  const cold = snowmakingHours(weather);
  const sighted = sightedHours(resort, point, observations);
  const observedTech = observedTechHours(resort, point, observations, cold);
  // Every machine-snow hour currently planned. Resolutions add to and take
  // from it as readings are worked through.
  const tech = new Set(observedTech);

  const planFor = (i: number, hours: Set<string>): DayPlan => ({
    day: dayStart(i).toISOString(),
    grooming: groomingForDay(
      resort,
      point,
      dayStart(i),
      observations,
      opts.groomingDefault,
    ),
    techHours: techHoursForDay(dayStart(i), hours),
  });

  // Saved managed states for this point, by valid time and inputs hash.
  const saved = new Map<string, Checkpoint>();
  await withClient(async (c) => {
    const { rows } = await c.query<{
      id: string;
      valid_time: Date;
      sno_path: string;
      snow_depth_cm: number;
      inputs_hash: string;
    }>(
      `SELECT id, valid_time, sno_path, snow_depth_cm, inputs_hash FROM state_checkpoints
       WHERE lineage_id = $1 AND point_id = $2 AND scenario = 'managed'
         AND valid_time > $3 AND valid_time <= $4`,
      [lineageId, point.id, t0, target],
    );
    for (const r of rows) {
      saved.set(`${r.valid_time.toISOString()}|${r.inputs_hash}`, {
        id: r.id,
        lineageId,
        validTime: r.valid_time,
        snoPath: r.sno_path,
        snowDepthCm: r.snow_depth_cm,
      });
    }
  });

  // The state at the end of day `through` (exclusive index: 0 is t0 itself)
  // under the given machine-snow hours, running whatever days are missing.
  const stateAt = async (
    dayCount: number,
    hours: Set<string>,
  ): Promise<{ checkpoint: Checkpoint; hash: string }> => {
    const plans: DayPlan[] = [];
    const hashes: string[] = [];
    let h = chainSeed(start.id);
    for (let i = 0; i < dayCount; i++) {
      const plan = planFor(i, hours);
      h = chainHash(h, plan);
      plans.push(plan);
      hashes.push(h);
    }
    let from = 0;
    let checkpoint = start;
    for (let i = dayCount - 1; i >= 0; i--) {
      const hit = saved.get(`${dayStart(i + 1).toISOString()}|${hashes[i]}`);
      if (hit) {
        from = i + 1;
        checkpoint = hit;
        break;
      }
    }
    for (let i = from; i < dayCount; i++) {
      const run = await host.runDay(
        point,
        dayStart(i),
        await readFile(checkpoint.snoPath, 'utf8'),
        plans[i]!,
      );
      checkpoint = await host.saveManaged(
        point,
        dayStart(i),
        dayStart(i + 1),
        run,
        checkpoint,
        hashes[i]!,
      );
      saved.set(`${dayStart(i + 1).toISOString()}|${hashes[i]}`, checkpoint);
    }
    return {
      checkpoint,
      hash: dayCount ? hashes[dayCount - 1]! : chainSeed(start.id),
    };
  };

  // Base-depth readings for this point, each compared at the end of the UTC
  // day it was reported in, or at the target when that day is not over yet.
  const readings = observations
    .filter(
      (o) =>
        o.kind === 'base_depth' &&
        o.status === 'reported' &&
        o.payload.kind === 'base_depth' &&
        o.payload.depthCm !== undefined &&
        o.validFrom > t0 &&
        o.validFrom.getTime() < target.getTime() + DAY_MS &&
        appliesToPoint(resort, point, o.payload),
    )
    .map((o) => {
      const end = ceilUtcDay(o.validFrom);
      return { obs: o, compareAt: end > target ? target : end };
    })
    .filter((r) => r.compareAt > t0)
    .sort(
      (a, b) =>
        a.compareAt.getTime() - b.compareAt.getTime() ||
        a.obs.validFrom.getTime() - b.obs.validFrom.getTime(),
    );

  const resolutions: Resolution[] = [];
  const fromBaseDepth = new Set<string>();
  let previousCompare: Date | null = null;
  for (const { obs, compareAt } of readings) {
    const reportedCm = (obs.payload as { depthCm: number }).depthCm;
    const dayCount = Math.round((compareAt.getTime() - t0.getTime()) / DAY_MS);
    const window = {
      from: new Date(
        Math.max(
          t0.getTime(),
          previousCompare?.getTime() ?? 0,
          compareAt.getTime() - BASE_DEPTH_WINDOW_DAYS * DAY_MS,
        ),
      ),
      to: compareAt,
    };
    previousCompare = compareAt;
    // Snow is only added after the previous reading, which has already been
    // answered. Taking snow back may reach machine snow an earlier reading
    // asked for: a later, lower figure is the better evidence.
    const removalWindow = {
      from: new Date(
        Math.max(
          t0.getTime(),
          compareAt.getTime() - BASE_DEPTH_WINDOW_DAYS * DAY_MS,
        ),
      ),
      to: compareAt,
    };

    const before = await stateAt(dayCount, tech);
    const basisHash = createHash('sha256')
      .update(`${before.hash}|${obs.id}`)
      .digest('hex')
      .slice(0, 24);
    let resolution = await loadResolution(
      lineageId,
      point.id,
      obs.id,
      basisHash,
    );
    if (!resolution) {
      resolution = await resolve({
        obsKey: obs.key,
        reportedCm,
        compareAt,
        window,
        removalWindow,
        modelledBeforeCm: before.checkpoint.snowDepthCm,
        tech,
        cold,
        sighted,
        depthWith: async (hours) =>
          (await stateAt(dayCount, hours)).checkpoint.snowDepthCm,
      });
      await saveResolution(
        lineageId,
        resort.id,
        point.id,
        obs.id,
        basisHash,
        resolution,
      );
    }
    for (const h of resolution.addHours) {
      tech.add(h);
      fromBaseDepth.add(h);
    }
    for (const h of resolution.removeHours) tech.delete(h);
    resolutions.push(resolution);
  }

  const final = await stateAt(days, tech);

  const groomedNights: ManagedPoint['groomedNights'] = [];
  const technicalSnow: ManagedPoint['technicalSnow'] = [];
  for (let i = 0; i < days; i++) {
    const plan = planFor(i, tech);
    if (plan.grooming) {
      groomedNights.push({
        time: new Date(
          dayStart(i).getTime() + plan.grooming.hourUtc * 3_600_000,
        ).toISOString(),
        basis: plan.grooming.basis,
        observationKey: plan.grooming.observationKey,
        source: plan.grooming.source,
      });
    }
    const day = dayIso(dayStart(i));
    const hours = [...tech].filter((h) => h.startsWith(day));
    if (hours.length) {
      const basis = new Set<'observed' | 'base_depth'>();
      for (const h of hours)
        basis.add(fromBaseDepth.has(h) ? 'base_depth' : 'observed');
      technicalSnow.push({
        day,
        hours: hours.length,
        basis: [...basis].sort(),
      });
    }
  }

  return {
    checkpoint: final.checkpoint,
    coldHours: cold,
    machineSnowHours: tech,
    applied: {
      appliedFrom: t0.toISOString(),
      groomedNights,
      technicalSnow,
      baseDepth: resolutions.map((r) => ({
        observationKey: r.observationKey,
        comparedAt: r.comparedAt,
        reportedCm: r.reportedCm,
        modelledBeforeCm: r.modelledBeforeCm,
        modelledAfterCm: r.modelledAfterCm,
        addedHours: r.addHours.length,
        removedHours: r.removeHours.length,
        residualCm: r.residualCm,
        note: r.note,
      })),
    },
  };
}

// Works out the machine snow that answers one base-depth reading. The gap
// between the resort's figure and the model is read as machine snow the model
// has not accounted for (or has over-counted). A share of it is closed by
// adding or removing whole hours of machine snow in the window before the
// reading; the run is repeated with a better count until the depth lands
// close to the aim. Whatever gap is left is reported, never forced in.
async function resolve(a: {
  obsKey: string;
  reportedCm: number;
  compareAt: Date;
  window: { from: Date; to: Date };
  removalWindow: { from: Date; to: Date };
  modelledBeforeCm: number;
  tech: Set<string>;
  cold: Map<string, number>;
  sighted: Set<string>;
  depthWith: (hours: Set<string>) => Promise<number>;
}): Promise<Resolution> {
  const gap = a.reportedCm - a.modelledBeforeCm;
  const base: Resolution = {
    observationKey: a.obsKey,
    comparedAt: a.compareAt.toISOString(),
    reportedCm: a.reportedCm,
    modelledBeforeCm: round1(a.modelledBeforeCm),
    modelledAfterCm: round1(a.modelledBeforeCm),
    addHours: [],
    removeHours: [],
    residualCm: round1(gap),
    note: null,
  };
  if (Math.abs(gap) <= BASE_DEPTH_TOLERANCE_CM) return base;

  const want = BASE_DEPTH_GAIN * gap;
  const adding = want > 0;
  let count = Math.max(1, Math.round(Math.abs(want) / TECH_CM_PER_HOUR_GUESS));
  let best: { hours: string[]; depth: number } | null = null;
  let note: string | null = null;
  const tried = new Set<number>();
  for (let trial = 0; trial < MAX_TRIALS; trial++) {
    if (tried.has(count)) break;
    tried.add(count);
    const hours = adding
      ? chooseHoursToAdd(count, a.window, a.cold, a.sighted, a.tech)
      : chooseHoursToRemove(count, a.removalWindow, a.tech);
    if (!hours.length) {
      note = adding
        ? 'no hours cold enough to make snow in the window'
        : 'no machine snow in the window to take back';
      break;
    }
    const trialTech = new Set(a.tech);
    for (const h of hours) {
      if (adding) trialTech.add(h);
      else trialTech.delete(h);
    }
    const depth = await a.depthWith(trialTech);
    const achieved = depth - a.modelledBeforeCm;
    if (
      !best ||
      Math.abs(want - achieved) <
        Math.abs(want - (best.depth - a.modelledBeforeCm))
    )
      best = { hours, depth };
    if (hours.length < count) {
      note = adding
        ? 'ran out of hours cold enough to make snow'
        : 'ran out of machine snow to take back';
      break;
    }
    if (Math.abs(want - achieved) <= TRIAL_TOLERANCE_CM) break;
    const next =
      achieved !== 0 && Math.sign(achieved) === Math.sign(want)
        ? Math.max(1, Math.round((count * want) / achieved))
        : count * 2;
    count = next;
  }
  if (!best) return { ...base, note };
  return {
    ...base,
    modelledAfterCm: round1(best.depth),
    addHours: adding ? best.hours : [],
    removeHours: adding ? [] : best.hours,
    residualCm: round1(a.reportedCm - best.depth),
    note,
  };
}

async function loadResolution(
  lineageId: string,
  pointId: string,
  observationId: string,
  basisHash: string,
): Promise<Resolution | undefined> {
  return withClient(async (c) => {
    const { rows } = await c.query<{ resolution: Resolution }>(
      `SELECT resolution FROM base_depth_resolutions
       WHERE lineage_id = $1 AND point_id = $2 AND observation_id = $3 AND basis_hash = $4`,
      [lineageId, pointId, observationId, basisHash],
    );
    return rows[0]?.resolution;
  });
}

async function saveResolution(
  lineageId: string,
  resortId: string,
  pointId: string,
  observationId: string,
  basisHash: string,
  resolution: Resolution,
): Promise<void> {
  await withClient((c) =>
    c.query(
      `INSERT INTO base_depth_resolutions
         (id, lineage_id, resort_id, point_id, observation_id, basis_hash, resolution)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT ON CONSTRAINT base_depth_resolutions_unique DO NOTHING`,
      [
        randomUUID(),
        lineageId,
        resortId,
        pointId,
        observationId,
        basisHash,
        JSON.stringify(resolution),
      ],
    ),
  );
}

export { TECH_MM_PER_STEP };

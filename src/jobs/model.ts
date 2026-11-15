import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import type { Config } from '../config.ts';
import {
  SCHEMA_VERSION,
  type PointResult,
  type ResultDocument,
} from '../contract/v1.ts';
import { withClient, withTransaction } from '../db.ts';
import { BlockedError } from '../errors.ts';
import {
  defaultGroomingHourUtc,
  groomingForDay,
  predictSnowmaking,
  snowmakingHours,
  type SnowmakingPrediction,
  sawNoGroomer,
  MANAGED_RULES_VERSION,
  TECH_MM_PER_STEP,
} from '../observations/plan.ts';
import {
  effectiveObservations,
  reportedThrough,
} from '../observations/store.ts';
import type {
  ModelPoint,
  Resort,
  ResortRegistry,
} from '../resorts/registry.ts';
import { addHours, spinupStart, startOfUtcDay } from '../season.ts';
import { bareGroundSno } from '../snowpack/config.ts';
import {
  findGaps,
  runPoint,
  type PointRunResult,
  type RunKind,
} from '../snowpack/point-run.ts';
import type { OpenMeteoClient } from '../weather/open-meteo.ts';
import { advanceManaged, type Checkpoint } from './managed.ts';
import { setProgress, type Job } from './queue.ts';

// Profiles in the result are sampled every few hours over the forecast.
export const PROFILE_INTERVAL_HOURS = 3;

export interface ModelDeps {
  config: Config;
  registry: ResortRegistry;
  openMeteo: OpenMeteoClient;
  iniTemplate: string;
  snowpackVersion: string;
}

// Runs initialize and refresh jobs. Past weather advances a point's saved
// state (a checkpoint); forecasts start from a copy of it and are discarded,
// so forecast error never accumulates in the state.
export class SnowModel {
  readonly #deps: ModelDeps;

  constructor(deps: ModelDeps) {
    this.#deps = deps;
  }

  async run(job: Job): Promise<{ resultId?: string }> {
    const resort = this.#deps.registry.get(job.resortId);
    if (!resort)
      throw new BlockedError(
        'unknown_resort',
        `resort ${job.resortId} is not configured`,
      );
    if (job.kind === 'initialize') {
      await this.#initialize(job, resort);
      return {};
    }
    return { resultId: await this.#refresh(job, resort) };
  }

  // Seasonal spin-up: from bare ground before the typical opening, through
  // the start of asOf's UTC day, for every model point.
  async #initialize(job: Job, resort: Resort): Promise<void> {
    const target = startOfUtcDay(new Date(job.request.asOf));
    const policy = {
      ...resort.season,
      spinupDays: job.request.spinupDays ?? resort.season.spinupDays,
    };
    const start = spinupStart(resort.hemisphere, job.season, policy);
    if (target <= start) {
      throw new BlockedError(
        'before_spinup',
        `asOf ${target.toISOString()} is not after the spin-up start ${start.toISOString()} for season ${job.season}`,
      );
    }
    const progress: Record<string, string> = { ...job.progress };
    for (const point of resort.points) {
      const existing = await this.#checkpointFromJob(
        job,
        resort,
        point,
        target,
      );
      if (!existing) {
        progress[point.id] = 'running';
        await setProgress(job.id, progress);
        const run = await runPoint(this.#runDeps(), {
          resort,
          point,
          from: start,
          to: target,
          initialSno: bareGroundSno(resort, point, start),
          profileIntervalHours: null,
        });
        await this.#saveCheckpoint(
          job,
          resort,
          point,
          'spinup',
          start,
          target,
          run,
          null,
        );
      }
      progress[point.id] = 'complete';
      await setProgress(job.id, progress);
    }
  }

  // Advance each point's saved state to the start of asOf's UTC day with past
  // weather, then run the forecast window from a copy of it.
  async #refresh(job: Job, resort: Resort): Promise<string> {
    const target = startOfUtcDay(new Date(job.request.asOf));
    const end = addHours(target, job.request.horizonHours ?? 168);
    const progress: Record<string, string> = { ...job.progress };
    const points: PointResult[] = [];
    const forecastRuns: PointRunResult[] = [];
    const gaps: ResultDocument['dataGaps'] = [];
    const managed = job.request.scenario === 'managed';
    const groomingDefault = job.request.groomingDefault ?? 'none';
    const observations = managed
      ? await effectiveObservations(resort.id, { season: job.season })
      : [];

    for (const point of resort.points) {
      progress[point.id] = 'running';
      await setProgress(job.id, progress);
      let checkpoint = await this.#latestCheckpoint(
        resort,
        point,
        job.season,
        target,
      );
      if (!checkpoint) {
        throw new BlockedError(
          'not_initialized',
          `no saved state for ${resort.id}/${point.id} in season ${job.season} at or before ${target.toISOString()} for config ${resort.configVersion}; initialize the season first`,
        );
      }
      if (checkpoint.validTime < target) {
        const advance = await runPoint(this.#runDeps(), {
          resort,
          point,
          from: checkpoint.validTime,
          to: target,
          initialSno: await readFile(checkpoint.snoPath, 'utf8'),
          profileIntervalHours: null,
        });
        checkpoint = await this.#saveCheckpoint(
          job,
          resort,
          point,
          'advance',
          checkpoint.validTime,
          target,
          advance,
          checkpoint,
        );
      }
      // The natural state is kept current either way. A managed refresh
      // forecasts from the managed state instead, and reports the natural
      // depth beside it.
      const natural = checkpoint;
      let applied: PointResult['managed'];
      let prediction: SnowmakingPrediction | undefined;
      let managedApplied:
        | Omit<
            NonNullable<PointResult['managed']>,
            'naturalSnowDepthCm' | 'forecast'
          >
        | undefined;
      if (managed) {
        const outcome = await advanceManaged(this.#managedHost(job, resort), {
          resort,
          point,
          lineageId: natural.lineageId,
          target,
          observations,
          groomingDefault,
        });
        if (outcome) {
          checkpoint = outcome.checkpoint;
          managedApplied = outcome.applied;
          // Snowmaking over the forecast, when asked for: the share of the
          // recent cold the resort used, applied to the cold hours ahead.
          if (job.request.snowmakingForecast === 'predicted') {
            const ahead = await this.#deps.openMeteo.hourly(
              resort,
              point,
              target,
              end,
            );
            prediction = predictSnowmaking({
              target,
              pastCold: outcome.coldHours,
              pastMachineSnow: outcome.machineSnowHours,
              futureCold: snowmakingHours(ahead.hours),
              machineSnowDepthCm:
                outcome.checkpoint.snowDepthCm - natural.snowDepthCm,
            });
          }
        }
      }
      // No snowmaking is assumed ahead of time. Grooming over the forecast
      // follows the caller's default, on SNOWPACK's own nightly schedule.
      const nightly =
        managed && groomingDefault === 'nightly'
          ? {
              managed: {
                groomingHourUtc: defaultGroomingHourUtc(resort, target),
                techHours: new Set<string>(),
                techMmPerStep: TECH_MM_PER_STEP,
              },
            }
          : {};
      const predictedHours = new Set(prediction?.hours ?? []);
      let forecast: PointRunResult;
      // Every SNOWPACK execution behind the forecast, in time order.
      let runs: RunFiles[];
      if (managedApplied) {
        // The window starts at 00:00 UTC, so last night's grooming usually
        // falls inside it. The first UTC day therefore runs on its own, with
        // what was observed for it, and the rest runs on from where it ended.
        const dayEnd = new Date(
          Math.min(end.getTime(), addHours(target, 24).getTime()),
        );
        const today = groomingForDay(
          resort,
          point,
          target,
          observations,
          groomingDefault,
        );
        const first = await runPoint(this.#runDeps(), {
          resort,
          point,
          from: target,
          to: dayEnd,
          initialSno: await readFile(checkpoint.snoPath, 'utf8'),
          profileIntervalHours: PROFILE_INTERVAL_HOURS,
          managed: {
            groomingHourUtc: today?.hourUtc ?? null,
            techHours: predictedHours,
            techMmPerStep: TECH_MM_PER_STEP,
          },
        });
        await this.#recordRun(
          job,
          resort,
          point,
          'forecast',
          target,
          dayEnd,
          first,
          checkpoint.id,
        );
        forecast = first;
        runs = [runFiles(first, target, dayEnd)];
        if (dayEnd < end) {
          const rest = await runPoint(this.#runDeps(), {
            resort,
            point,
            from: dayEnd,
            to: end,
            initialSno: await readFile(first.outputSnoPath, 'utf8'),
            profileIntervalHours: PROFILE_INTERVAL_HOURS,
            managed: {
              groomingHourUtc: nightly.managed?.groomingHourUtc ?? null,
              techHours: predictedHours,
              techMmPerStep: TECH_MM_PER_STEP,
            },
          });
          await this.#recordRun(
            job,
            resort,
            point,
            'forecast',
            dayEnd,
            end,
            rest,
            checkpoint.id,
          );
          forecast = joinRuns(first, rest);
          runs.push(runFiles(rest, dayEnd, end));
        }
        applied = {
          naturalSnowDepthCm: natural.snowDepthCm,
          ...managedApplied,
          forecast: {
            today: today
              ? {
                  status: today.basis,
                  time: addHours(target, today.hourUtc).toISOString(),
                  observationKey: today.observationKey,
                  source: today.source,
                }
              : {
                  status: sawNoGroomer(resort, point, target, observations)
                    ? 'not_groomed'
                    : 'none',
                  time: null,
                  observationKey: null,
                  source: null,
                },
            laterNights: groomingDefault,
            snowmaking: snowmakingBlock(prediction),
          },
        };
      } else {
        forecast = await runPoint(this.#runDeps(), {
          resort,
          point,
          from: target,
          to: end,
          initialSno: await readFile(checkpoint.snoPath, 'utf8'),
          profileIntervalHours: PROFILE_INTERVAL_HOURS,
        });
        await this.#recordRun(
          job,
          resort,
          point,
          'forecast',
          target,
          end,
          forecast,
          checkpoint.id,
        );
        runs = [runFiles(forecast, target, end)];
      }
      forecastRuns.push(forecast);
      for (const g of forecast.gaps) gaps.push({ pointId: point.id, ...g });
      const fromIso = target.toISOString();
      const toIso = end.toISOString();
      points.push({
        id: point.id,
        elevationM: point.elevationM,
        state: {
          lineageId: checkpoint.lineageId,
          checkpointValidTime: checkpoint.validTime.toISOString(),
          snowDepthCm: checkpoint.snowDepthCm,
        },
        forcing: forecast.forcing,
        met: forecast.met,
        profiles: forecast.profiles.filter(
          (p) => p.time >= fromIso && p.time <= toIso,
        ),
        files: {
          runId: runs[0]!.runId,
          names: runs[0]!.names,
          runs,
        },
        ...(applied ? { managed: applied } : {}),
      });
      progress[point.id] = 'complete';
      await setProgress(job.id, progress);
    }

    const retrievedAt =
      forecastRuns.map((r) => r.weather.retrievedAt).sort()[0] ??
      new Date().toISOString();
    const document: ResultDocument = {
      schemaVersion: SCHEMA_VERSION,
      id: randomUUID(),
      jobId: job.id,
      resort: { id: resort.id, configVersion: resort.configVersion },
      season: job.season,
      asOf: job.request.asOf,
      window: { from: target.toISOString(), to: end.toISOString() },
      generatedAt: new Date().toISOString(),
      scenario: managed ? 'managed' : 'natural',
      provenance: {
        weatherProvider: 'open-meteo',
        weatherModel: resort.weather.model,
        weatherRetrievedAt: retrievedAt,
        weatherKind:
          end.toISOString() <= retrievedAt
            ? 'archived'
            : target.toISOString() >= retrievedAt
              ? 'forecast'
              : 'mixed',
        snowpackVersion: this.#deps.snowpackVersion,
        serviceVersion: this.#deps.config.serviceVersion,
        ...(managed
          ? {
              observationsThrough:
                (await reportedThrough(resort.id))?.toISOString() ?? null,
              managedRulesVersion: MANAGED_RULES_VERSION,
            }
          : {}),
      },
      points,
      dataGaps: gaps,
    };
    const dir = join(this.#deps.config.dataDir, 'results');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${document.id}.json`);
    await writeFile(path, JSON.stringify(document));
    await withClient((c) =>
      c.query(
        `INSERT INTO results (id, job_id, resort_id, season, as_of, document_path)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [document.id, job.id, resort.id, job.season, job.request.asOf, path],
      ),
    );
    return document.id;
  }

  #runDeps() {
    return {
      config: this.#deps.config,
      openMeteo: this.#deps.openMeteo,
      iniTemplate: this.#deps.iniTemplate,
    };
  }

  // What the managed chain needs from this model: where a lineage starts,
  // how to run one day, and how to save the state it ends in.
  #managedHost(job: Job, resort: Resort) {
    return {
      startCheckpoint: async (point: ModelPoint) => {
        const latest = await this.#latestCheckpoint(
          resort,
          point,
          job.season,
          new Date(job.request.asOf),
        );
        if (!latest) return undefined;
        return withClient(async (c) => {
          const { rows } = await c.query(
            `SELECT id, lineage_id, valid_time, sno_path, snow_depth_cm
             FROM state_checkpoints
             WHERE lineage_id = $1 AND point_id = $2 AND scenario = 'natural'
             ORDER BY valid_time ASC, created_at ASC LIMIT 1`,
            [latest.lineageId, point.id],
          );
          return rows[0] && toCheckpoint(rows[0]);
        });
      },
      runDay: (
        point: ModelPoint,
        from: Date,
        initialSno: string,
        plan: { grooming: { hourUtc: number } | null; techHours: string[] },
      ) =>
        runPoint(this.#runDeps(), {
          resort,
          point,
          from,
          to: addHours(from, 24),
          initialSno,
          profileIntervalHours: null,
          managed: {
            groomingHourUtc: plan.grooming?.hourUtc ?? null,
            techHours: new Set(plan.techHours),
            techMmPerStep: TECH_MM_PER_STEP,
          },
        }),
      saveManaged: (
        point: ModelPoint,
        from: Date,
        to: Date,
        run: PointRunResult,
        input: Checkpoint,
        inputsHash: string,
      ) =>
        this.#saveCheckpoint(
          job,
          resort,
          point,
          'advance',
          from,
          to,
          run,
          input,
          {
            scenario: 'managed',
            inputsHash,
          },
        ),
      weather: async (point: ModelPoint, from: Date, to: Date) =>
        (await this.#deps.openMeteo.hourly(resort, point, from, to)).hours,
    };
  }

  // The newest natural state at or before `notAfter` in the lineage of the
  // most recent completed spin-up for this season and configuration.
  async #latestCheckpoint(
    resort: Resort,
    point: ModelPoint,
    season: string,
    notAfter: Date,
  ): Promise<Checkpoint | undefined> {
    return withClient(async (c) => {
      const { rows } = await c.query(
        `SELECT sc.id, sc.lineage_id, sc.valid_time, sc.sno_path, sc.snow_depth_cm
         FROM state_checkpoints sc
         WHERE sc.point_id = $3 AND sc.valid_time <= $5 AND sc.scenario = 'natural'
           AND sc.lineage_id = (
             SELECT j.id FROM jobs j
             WHERE j.kind = 'initialize' AND j.status = 'complete'
               AND j.resort_id = $1 AND j.season = $2
               AND EXISTS (
                 SELECT 1 FROM state_checkpoints s
                 WHERE s.lineage_id = j.id AND s.resort_config_version = $4)
             ORDER BY j.finished_at DESC LIMIT 1)
         ORDER BY sc.valid_time DESC, sc.created_at DESC LIMIT 1`,
        [resort.id, season, point.id, resort.configVersion, notAfter],
      );
      return rows[0] && toCheckpoint(rows[0]);
    });
  }

  // A checkpoint this job already produced for the point (a retried attempt
  // resumes after it instead of re-running the spin-up).
  async #checkpointFromJob(
    job: Job,
    resort: Resort,
    point: ModelPoint,
    validTime: Date,
  ): Promise<Checkpoint | undefined> {
    return withClient(async (c) => {
      const { rows } = await c.query(
        `SELECT sc.id, sc.lineage_id, sc.valid_time, sc.sno_path, sc.snow_depth_cm
         FROM state_checkpoints sc JOIN model_runs mr ON mr.id = sc.produced_by_run_id
         WHERE mr.job_id = $1 AND sc.resort_id = $2 AND sc.point_id = $3 AND sc.valid_time = $4`,
        [job.id, resort.id, point.id, validTime],
      );
      return rows[0] && toCheckpoint(rows[0]);
    });
  }

  async #saveCheckpoint(
    job: Job,
    resort: Resort,
    point: ModelPoint,
    kind: RunKind,
    from: Date,
    to: Date,
    run: PointRunResult,
    // The state this run started from; null for a spin-up from bare ground,
    // which starts a new lineage named after its job.
    input: Checkpoint | null,
    chain: { scenario: 'natural' | 'managed'; inputsHash: string | null } = {
      scenario: 'natural',
      inputsHash: null,
    },
  ): Promise<Checkpoint> {
    const lineageId = input?.lineageId ?? job.id;
    const dir = join(
      this.#deps.config.dataDir,
      'states',
      resort.id,
      point.id,
      job.season.replace('/', '-'),
    );
    await mkdir(dir, { recursive: true });
    const snoPath = join(
      dir,
      `${to.toISOString().replace(/[:]/g, '')}.${run.runId}.sno`,
    );
    await copyFile(run.outputSnoPath, snoPath);
    const snowDepthCm = run.met.at(-1)?.snowDepthCm ?? 0;
    const id = randomUUID();
    await withTransaction(async (c) => {
      await this.#insertRun(
        c,
        job,
        resort,
        point,
        kind,
        from,
        to,
        run,
        input?.id ?? null,
      );
      await c.query(
        `INSERT INTO state_checkpoints
           (id, lineage_id, resort_id, point_id, season, valid_time, sno_path, produced_by_run_id,
            resort_config_version, snow_depth_cm, scenario, inputs_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          id,
          lineageId,
          resort.id,
          point.id,
          job.season,
          to,
          snoPath,
          run.runId,
          resort.configVersion,
          snowDepthCm,
          chain.scenario,
          chain.inputsHash,
        ],
      );
    });
    return { id, lineageId, validTime: to, snoPath, snowDepthCm };
  }

  async #recordRun(
    job: Job,
    resort: Resort,
    point: ModelPoint,
    kind: RunKind,
    from: Date,
    to: Date,
    run: PointRunResult,
    inputCheckpointId: string | null,
  ): Promise<void> {
    await withClient((c) =>
      this.#insertRun(
        c,
        job,
        resort,
        point,
        kind,
        from,
        to,
        run,
        inputCheckpointId,
      ),
    );
  }

  async #insertRun(
    c: PoolClient,
    job: Job,
    resort: Resort,
    point: ModelPoint,
    kind: RunKind,
    from: Date,
    to: Date,
    run: PointRunResult,
    inputCheckpointId: string | null,
  ): Promise<void> {
    await c.query(
      `INSERT INTO model_runs
         (id, job_id, resort_id, point_id, season, kind, valid_from, valid_to,
          input_checkpoint_id, run_dir, snowpack_version, resort_config_version,
          weather_provider, weather_model, weather_retrieved_at, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        run.runId,
        job.id,
        resort.id,
        point.id,
        job.season,
        kind,
        from,
        to,
        inputCheckpointId,
        run.runDir,
        this.#deps.snowpackVersion,
        resort.configVersion,
        run.weather.provider,
        run.weather.model,
        run.weather.retrievedAt,
        run.durationMs,
      ],
    );
  }
}

// A prediction as the result reports it: hours grouped into UTC days.
function snowmakingBlock(
  p: SnowmakingPrediction | undefined,
): NonNullable<PointResult['managed']>['forecast']['snowmaking'] {
  if (!p) {
    return {
      mode: 'none',
      nights: [],
      utilisation: null,
      recentColdHours: 0,
      recentMachineSnowHours: 0,
      depthPerHourCm: null,
      reason: 'not_requested',
    };
  }
  const byDay = new Map<string, string[]>();
  for (const h of p.hours)
    byDay.set(h.slice(0, 10), [...(byDay.get(h.slice(0, 10)) ?? []), h]);
  return {
    mode: 'predicted',
    nights: [...byDay.entries()].map(([day, hours]) => ({
      day,
      hours: hours.length,
      from: hours[0]!,
      to: hours.at(-1)!,
    })),
    utilisation: p.utilisation,
    recentColdHours: p.recentColdHours,
    recentMachineSnowHours: p.recentMachineSnowHours,
    depthPerHourCm: p.depthPerHourCm,
    reason: p.reason,
  };
}

type RunFiles = PointResult['files']['runs'][number];

// One run's id, the span it simulated and its native files.
function runFiles(run: PointRunResult, from: Date, to: Date): RunFiles {
  return {
    runId: run.runId,
    from: from.toISOString(),
    to: to.toISOString(),
    names: ['io.ini', ...run.files.map((f) => `output/${f}`)],
  };
}

// Two back-to-back runs of one point as one: the second starts at the hour
// the first ended on, so that hour is kept once.
function joinRuns(a: PointRunResult, b: PointRunResult): PointRunResult {
  const after = <T extends { time: string }>(rows: T[], last?: T): T[] =>
    last ? rows.filter((r) => r.time > last.time) : rows;
  const forcing = [...a.forcing, ...after(b.forcing, a.forcing.at(-1))];
  return {
    ...a,
    forcing,
    met: [...a.met, ...after(b.met, a.met.at(-1))],
    profiles: [...a.profiles, ...after(b.profiles, a.profiles.at(-1))],
    gaps: findGaps(forcing),
    weather: {
      ...a.weather,
      retrievedAt:
        a.weather.retrievedAt < b.weather.retrievedAt
          ? a.weather.retrievedAt
          : b.weather.retrievedAt,
    },
    outputSnoPath: b.outputSnoPath,
    durationMs: a.durationMs + b.durationMs,
  };
}

function toCheckpoint(r: {
  id: string;
  lineage_id: string;
  valid_time: Date;
  sno_path: string;
  snow_depth_cm: number;
}): Checkpoint {
  return {
    id: r.id,
    lineageId: r.lineage_id,
    validTime: r.valid_time,
    snoPath: r.sno_path,
    snowDepthCm: r.snow_depth_cm,
  };
}

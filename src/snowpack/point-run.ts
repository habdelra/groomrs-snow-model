import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { BlockedError } from '../errors.ts';
import type { ModelPoint, Resort } from '../resorts/registry.ts';
import { addDays } from '../season.ts';
import type {
  HourlyWeather,
  OpenMeteoClient,
  WeatherSeries,
} from '../weather/open-meteo.ts';
import { stationId, toSmet } from '../weather/smet.ts';
import { renderIni } from './config.ts';
import { parseMet, parsePro, type MetHour, type Profile } from './parse.ts';
import { runSnowpack } from './runner.ts';

export type RunKind = 'spinup' | 'advance' | 'forecast';

// Forcing variables SNOWPACK cannot run without. Short holes are bridged by
// MeteoIO's resampling; a run with more than this share missing is blocked.
const REQUIRED: Array<keyof HourlyWeather> = [
  'airTempC',
  'relativeHumidityPct',
  'windSpeedMs',
  'shortwaveWm2',
  'precipitationMm',
];
const MAX_MISSING_FRACTION = 0.1;

export interface Gap {
  variable: string;
  missingHours: number;
  totalHours: number;
}

export interface PointRunResult {
  runId: string;
  runDir: string;
  weather: WeatherSeries;
  // Weather inside [from, to], the hours the run simulated.
  forcing: HourlyWeather[];
  gaps: Gap[];
  met: MetHour[];
  profiles: Profile[];
  outputSnoPath: string;
  files: string[];
  durationMs: number;
}

export interface PointRunDeps {
  config: Config;
  openMeteo: OpenMeteoClient;
  iniTemplate: string;
}

// One SNOWPACK execution for one model point, from a saved state at `from`
// to `to`, in its own run directory holding the exact inputs and outputs.
export async function runPoint(
  deps: PointRunDeps,
  opts: {
    resort: Resort;
    point: ModelPoint;
    from: Date;
    to: Date;
    initialSno: string;
    profileIntervalHours: number | null;
  },
): Promise<PointRunResult> {
  const { resort, point, from, to } = opts;
  const runId = randomUUID();
  const runDir = join(deps.config.dataDir, 'runs', runId);
  const inputDir = join(runDir, 'input');
  const outputDir = join(runDir, 'output');
  await mkdir(inputDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  // Forcing starts a day early: MeteoIO needs data before the state's
  // ProfileDate to accumulate the first precipitation step.
  const weather = await deps.openMeteo.hourly(
    resort,
    point,
    addDays(from, -1),
    to,
  );
  const forcing = weather.hours.filter(
    (h) => h.time >= from.toISOString() && h.time <= to.toISOString(),
  );
  const gaps = findGaps(forcing);
  const blocking = gaps.filter(
    (g) =>
      REQUIRED.includes(g.variable as keyof HourlyWeather) &&
      g.missingHours / g.totalHours > MAX_MISSING_FRACTION,
  );
  if (blocking.length) {
    throw new BlockedError(
      'weather_coverage',
      `weather for ${resort.id}/${point.id} is missing required variables over ${from.toISOString()}..${to.toISOString()}`,
      blocking,
    );
  }

  const station = stationId(point);
  await writeFile(
    join(inputDir, `${station}.smet`),
    toSmet(resort, point, weather.hours),
  );
  await writeFile(join(inputDir, `${station}.sno`), opts.initialSno);
  const iniPath = join(runDir, 'io.ini');
  await writeFile(
    iniPath,
    renderIni(deps.iniTemplate, {
      station,
      inputDir,
      outputDir,
      profileIntervalHours: opts.profileIntervalHours,
    }),
  );
  await writeFile(
    join(runDir, 'weather-sources.json'),
    JSON.stringify(weather.sources, null, 2),
  );

  const outputSmetPath = join(outputDir, `${station}_run.smet`);
  const run = await runSnowpack({
    bin: deps.config.snowpackBin,
    runDir,
    iniPath,
    end: to,
    timeoutMs: deps.config.snowpackTimeoutMs,
    outputSmetPath,
  });

  const met = parseMet(await readFile(outputSmetPath, 'utf8')).filter(
    (h) => h.time >= from.toISOString() && h.time <= to.toISOString(),
  );
  const profiles =
    opts.profileIntervalHours === null
      ? []
      : parsePro(await readFile(join(outputDir, `${station}_run.pro`), 'utf8'));
  const files = (await readdir(outputDir)).sort();
  return {
    runId,
    runDir,
    weather,
    forcing,
    gaps,
    met,
    profiles,
    outputSnoPath: join(outputDir, `${station}_run.sno`),
    files,
    durationMs: run.durationMs,
  };
}

export function findGaps(hours: HourlyWeather[]): Gap[] {
  if (!hours.length) return [];
  const keys = Object.keys(hours[0]!).filter((k) => k !== 'time') as Array<
    keyof HourlyWeather
  >;
  return keys
    .map((variable) => ({
      variable,
      missingHours: hours.filter((h) => h[variable] === null).length,
      totalHours: hours.length,
    }))
    .filter((g) => g.missingHours > 0);
}

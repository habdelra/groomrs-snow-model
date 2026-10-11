import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ModelPoint, Resort } from '../resorts/registry.ts';
import { addDays, startOfUtcDay } from '../season.ts';

// Hourly variables requested for every model point (snow-carving-model-v3
// §22/§27). Requested in metric: wind in m/s, everything else in Open-Meteo's
// metric defaults (°C, %, W/m², mm, cm of snowfall, hPa).
export const HOURLY_VARIABLES = [
  'temperature_2m',
  'relative_humidity_2m',
  'wind_speed_10m',
  'wind_direction_10m',
  'shortwave_radiation',
  'precipitation',
  'rain',
  'snowfall',
  'cloud_cover',
  'surface_pressure',
] as const;

// One hour of weather at a model point, metric, keyed by the hour's start in
// UTC. Missing values stay null; they are never invented here.
export interface HourlyWeather {
  time: string;
  airTempC: number | null;
  relativeHumidityPct: number | null;
  windSpeedMs: number | null;
  windDirectionDeg: number | null;
  shortwaveWm2: number | null;
  precipitationMm: number | null;
  rainMm: number | null;
  snowfallCm: number | null;
  cloudCoverPct: number | null;
  surfacePressureHpa: number | null;
}

export interface WeatherSource {
  url: string;
  retrievedAt: string;
  file: string;
  archived: boolean;
}

export interface WeatherSeries {
  provider: 'open-meteo';
  model: string;
  hours: HourlyWeather[];
  sources: WeatherSource[];
  // Oldest retrieval among the chunks used.
  retrievedAt: string;
}

interface CachedChunk {
  url: string;
  retrievedAt: string;
  // A chunk whose last hour is well in the past no longer changes, so it is
  // kept forever. Chunks that reach into the recent past or future are
  // refetched once they are older than the TTL.
  archived: boolean;
  response: OpenMeteoResponse;
}

interface OpenMeteoResponse {
  hourly: Record<string, Array<number | string | null>> & { time: string[] };
}

// How far ahead the forecast is requested; ECMWF IFS reaches 15 days.
const FORECAST_REACH_DAYS = 14;
// Days after which a past month is treated as final.
const ARCHIVE_AFTER_DAYS = 3;

export interface OpenMeteoClientOptions {
  baseUrl: string;
  dataDir: string;
  ttlMinutes?: number;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

export class OpenMeteoClient {
  readonly #baseUrl: string;
  readonly #cacheDir: string;
  readonly #ttlMs: number;
  readonly #now: () => Date;
  readonly #fetch: typeof fetch;

  constructor(opts: OpenMeteoClientOptions) {
    this.#baseUrl = opts.baseUrl;
    this.#cacheDir = join(opts.dataDir, 'weather', 'open-meteo');
    this.#ttlMs = (opts.ttlMinutes ?? 60) * 60 * 1000;
    this.#now = opts.now ?? (() => new Date());
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  // Hourly weather for [from, to] inclusive, assembled from whole-month
  // chunks so repeated runs reuse the same cached responses.
  async hourly(
    resort: Resort,
    point: ModelPoint,
    from: Date,
    to: Date,
  ): Promise<WeatherSeries> {
    const now = this.#now();
    const reach = addDays(startOfUtcDay(now), FORECAST_REACH_DAYS);
    if (to > reach) {
      throw new Error(
        `requested weather through ${to.toISOString()} but the forecast only reaches ${reach.toISOString()}`,
      );
    }
    const sources: WeatherSource[] = [];
    const byTime = new Map<string, HourlyWeather>();
    for (const month of monthsBetween(from, to)) {
      const chunk = await this.#chunk(resort, point, month, now, reach);
      sources.push({
        url: chunk.url,
        retrievedAt: chunk.retrievedAt,
        file: chunk.file,
        archived: chunk.archived,
      });
      for (const h of normalize(chunk.response)) byTime.set(h.time, h);
    }
    const hours: HourlyWeather[] = [];
    for (let t = from.getTime(); t <= to.getTime(); t += 3_600_000) {
      const time = new Date(t).toISOString();
      hours.push(byTime.get(time) ?? emptyHour(time));
    }
    return {
      provider: 'open-meteo',
      model: resort.weather.model,
      hours,
      sources,
      retrievedAt:
        sources.map((s) => s.retrievedAt).sort()[0] ?? now.toISOString(),
    };
  }

  // Cheap reachability probe for /health.
  async ping(): Promise<boolean> {
    try {
      const url = `${this.#baseUrl}/v1/forecast?latitude=0&longitude=0&hourly=temperature_2m&forecast_days=1&models=ecmwf_ifs025`;
      const res = await this.#fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async #chunk(
    resort: Resort,
    point: ModelPoint,
    month: Date,
    now: Date,
    reach: Date,
  ): Promise<CachedChunk & { file: string }> {
    const monthEnd = addDays(nextMonth(month), -1);
    const end = monthEnd < reach ? monthEnd : reach;
    const archived = addDays(monthEnd, ARCHIVE_AFTER_DAYS + 1) < now;
    const params = new URLSearchParams({
      latitude: String(resort.location.latitude),
      longitude: String(resort.location.longitude),
      elevation: String(point.elevationM),
      models: resort.weather.model,
      hourly: HOURLY_VARIABLES.join(','),
      wind_speed_unit: 'ms',
      timezone: 'UTC',
      start_date: isoDate(month),
      end_date: isoDate(end),
    });
    // The file name carries a hash of everything that shapes the response
    // besides the month, so a changed coordinate or variable set misses.
    const keyHash = createHash('sha256')
      .update(
        JSON.stringify([
          resort.location.latitude,
          resort.location.longitude,
          point.elevationM,
          HOURLY_VARIABLES,
        ]),
      )
      .digest('hex')
      .slice(0, 10);
    const file = join(
      this.#cacheDir,
      resort.weather.model,
      resort.id,
      point.id,
      `${isoDate(month).slice(0, 7)}.${keyHash}.json`,
    );
    const cached = await readCached(file);
    if (
      cached &&
      (cached.archived ||
        now.getTime() - Date.parse(cached.retrievedAt) < this.#ttlMs)
    ) {
      return { ...cached, file };
    }
    const url = `${this.#baseUrl}/v1/forecast?${params}`;
    const res = await this.#fetch(url, {
      signal: AbortSignal.timeout(300_000),
    });
    const body = (await res.json()) as OpenMeteoResponse & {
      error?: boolean;
      reason?: string;
    };
    if (!res.ok || body.error) {
      throw new Error(
        `Open-Meteo ${res.status}: ${body.reason ?? 'request failed'} (${url})`,
      );
    }
    const chunk: CachedChunk = {
      url,
      retrievedAt: now.toISOString(),
      archived,
      response: { hourly: body.hourly },
    };
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(chunk));
    await rename(`${file}.tmp`, file);
    return { ...chunk, file };
  }
}

async function readCached(file: string): Promise<CachedChunk | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as CachedChunk;
  } catch {
    return undefined;
  }
}

function num(v: number | string | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function normalize(response: OpenMeteoResponse): HourlyWeather[] {
  const h = response.hourly;
  return h.time.map((t, i) => ({
    time: new Date(`${t}:00Z`).toISOString(),
    airTempC: num(h.temperature_2m?.[i]),
    relativeHumidityPct: num(h.relative_humidity_2m?.[i]),
    windSpeedMs: num(h.wind_speed_10m?.[i]),
    windDirectionDeg: num(h.wind_direction_10m?.[i]),
    shortwaveWm2: num(h.shortwave_radiation?.[i]),
    precipitationMm: num(h.precipitation?.[i]),
    rainMm: num(h.rain?.[i]),
    snowfallCm: num(h.snowfall?.[i]),
    cloudCoverPct: num(h.cloud_cover?.[i]),
    surfacePressureHpa: num(h.surface_pressure?.[i]),
  }));
}

function emptyHour(time: string): HourlyWeather {
  return {
    time,
    airTempC: null,
    relativeHumidityPct: null,
    windSpeedMs: null,
    windDirectionDeg: null,
    shortwaveWm2: null,
    precipitationMm: null,
    rainMm: null,
    snowfallCm: null,
    cloudCoverPct: null,
    surfacePressureHpa: null,
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function nextMonth(month: Date): Date {
  return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
}

export function monthsBetween(from: Date, to: Date): Date[] {
  const months: Date[] = [];
  let m = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (m <= to) {
    months.push(m);
    m = nextMonth(m);
  }
  return months;
}

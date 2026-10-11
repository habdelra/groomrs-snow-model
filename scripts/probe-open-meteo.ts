// Probes the Open-Meteo instance for every resort point: how complete each
// required variable is over the coming forecast and over several past
// windows, per candidate model. Use it before choosing or changing a
// resort's weather model, and after an Open-Meteo image upgrade.
//
//   mise run probe:open-meteo                       # every resort, default candidates
//   mise run probe:open-meteo -- vail-co --models ecmwf_ifs025,gfs_seamless
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT } from '../src/paths.ts';
import { ResortRegistry } from '../src/resorts/registry.ts';
import { addDays, startOfUtcDay } from '../src/season.ts';
import { readIniTemplate } from '../src/snowpack/config.ts';
import { HOURLY_VARIABLES, normalize } from '../src/weather/open-meteo.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    models: { type: 'string', default: 'ecmwf_ifs025,gfs_seamless,best_match' },
  },
});
const baseUrl = (process.env.OPEN_METEO_URL ?? 'http://127.0.0.1:8080').replace(
  /\/$/,
  '',
);
const registry = ResortRegistry.load(
  join(ROOT, 'config', 'resorts'),
  readIniTemplate(),
);
const resorts = positionals.length
  ? positionals.map((id) => registry.get(id) ?? fail(`unknown resort ${id}`))
  : registry.all();
const models = values.models.split(',');
const today = startOfUtcDay(new Date());

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

for (const resort of resorts) {
  // Last winter's coldest month for the hemisphere.
  const winterMonth = resort.hemisphere === 'north' ? 0 : 6;
  let winterYear = today.getUTCFullYear();
  if (new Date(Date.UTC(winterYear, winterMonth, 31)) > today) winterYear -= 1;
  const windows: Array<[string, Date, Date]> = [
    ['forecast +7d', today, addDays(today, 7)],
    ['past 7d', addDays(today, -7), addDays(today, -1)],
    ['90d ago', addDays(today, -90), addDays(today, -84)],
    [
      `winter ${winterYear}`,
      new Date(Date.UTC(winterYear, winterMonth, 10)),
      new Date(Date.UTC(winterYear, winterMonth, 24)),
    ],
    [
      `winter ${winterYear - 1}`,
      new Date(Date.UTC(winterYear - 1, winterMonth, 10)),
      new Date(Date.UTC(winterYear - 1, winterMonth, 24)),
    ],
  ];
  console.log(`\n## ${resort.id} (configured model: ${resort.weather.model})`);
  for (const point of resort.points) {
    for (const model of models) {
      for (const [label, from, to] of windows) {
        const params = new URLSearchParams({
          latitude: String(resort.location.latitude),
          longitude: String(resort.location.longitude),
          elevation: String(point.elevationM),
          models: model,
          hourly: HOURLY_VARIABLES.join(','),
          wind_speed_unit: 'ms',
          timezone: 'UTC',
          start_date: iso(from),
          end_date: iso(to),
        });
        const res = await fetch(`${baseUrl}/v1/forecast?${params}`);
        const body = (await res.json()) as { error?: boolean; reason?: string };
        const where = `${point.id.padEnd(6)} ${model.padEnd(16)} ${label.padEnd(14)}`;
        if (!res.ok || body.error) {
          console.log(`${where} ERROR ${body.reason ?? res.status}`);
          continue;
        }
        const hours = normalize(body as Parameters<typeof normalize>[0]);
        const missing = Object.keys(hours[0] ?? {})
          .filter((k) => k !== 'time')
          .map((k) => {
            const n = hours.filter(
              (h) => h[k as keyof typeof h] === null,
            ).length;
            return n ? `${k}:${Math.round((100 * n) / hours.length)}%` : '';
          })
          .filter(Boolean);
        const sum = (k: 'precipitationMm' | 'snowfallCm' | 'rainMm') =>
          Math.round(hours.reduce((a, h) => a + (h[k] ?? 0), 0));
        const temps = hours
          .map((h) => h.airTempC)
          .filter((t): t is number => t !== null);
        const meanT = temps.length
          ? (temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1)
          : '-';
        console.log(
          `${where} ${String(hours.length).padStart(4)}h  T̄ ${meanT.padStart(5)}°C  precip ${sum('precipitationMm')}mm snow ${sum('snowfallCm')}cm rain ${sum('rainMm')}mm  ${missing.length ? `missing ${missing.join(' ')}` : 'complete'}`,
        );
      }
    }
  }
}

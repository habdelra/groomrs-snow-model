import type { ModelPoint, Resort } from '../resorts/registry.ts';
import {
  cToKelvin,
  pctToFraction,
  pctToOktas,
  snowfallCmToMmWe,
} from '../units.ts';
import type { HourlyWeather } from './open-meteo.ts';

export const SMET_NODATA = -999;

// New-snow density used only to turn Open-Meteo's snowfall depth into water
// equivalent for the precipitation-phase ratio (snow-carving-model-v3 §24).
export const NEW_SNOW_DENSITY_KG_M3 = 100;

export const SMET_FIELDS = [
  'timestamp',
  'TA',
  'RH',
  'VW',
  'DW',
  'ISWR',
  'PSUM',
  'PSUM_PH',
  'CLD',
] as const;

export function stationId(point: ModelPoint): string {
  return point.id.toUpperCase();
}

// Fraction of the hour's precipitation that fell as liquid: 0 all snow, 1 all
// rain. Null (left for MeteoIO's PRECSPLITTING generator to fill from air
// temperature) when there was no precipitation or the split is unknown.
export function precipitationPhase(h: HourlyWeather): number | null {
  if (h.precipitationMm === null || h.precipitationMm <= 0) return null;
  if (h.rainMm === null || h.snowfallCm === null) return null;
  const snowWe = snowfallCmToMmWe(h.snowfallCm, NEW_SNOW_DENSITY_KG_M3);
  const total = h.rainMm + snowWe;
  return total > 0 ? h.rainMm / total : null;
}

function fmt(value: number | null, decimals: number): string {
  return value === null ? String(SMET_NODATA) : value.toFixed(decimals);
}

// One SMET row per hour in SNOWPACK's native SI units: TA in K, RH as a
// fraction, wind in m/s, radiation in W/m², PSUM in mm per hour, PSUM_PH as a
// liquid fraction and CLD in oktas.
export function toSmet(
  resort: Resort,
  point: ModelPoint,
  hours: HourlyWeather[],
): string {
  const header = [
    'SMET 1.1 ASCII',
    '[HEADER]',
    `station_id   = ${stationId(point)}`,
    `station_name = ${resort.name} ${point.id}`,
    `latitude     = ${resort.location.latitude}`,
    `longitude    = ${resort.location.longitude}`,
    `altitude     = ${point.elevationM}`,
    `nodata       = ${SMET_NODATA}`,
    'tz           = 0',
    `source       = Open-Meteo ${resort.weather.model} via groomrs-snow-model`,
    `fields       = ${SMET_FIELDS.join(' ')}`,
    '[DATA]',
  ];
  const rows = hours.map((h) =>
    [
      h.time.slice(0, 19),
      fmt(h.airTempC === null ? null : cToKelvin(h.airTempC), 2),
      fmt(
        h.relativeHumidityPct === null
          ? null
          : pctToFraction(h.relativeHumidityPct),
        3,
      ),
      fmt(h.windSpeedMs, 2),
      fmt(h.windDirectionDeg, 0),
      fmt(h.shortwaveWm2, 1),
      fmt(
        h.precipitationMm === null ? null : Math.max(0, h.precipitationMm),
        3,
      ),
      fmt(precipitationPhase(h), 3),
      fmt(h.cloudCoverPct === null ? null : pctToOktas(h.cloudCoverPct), 2),
    ].join(' '),
  );
  return `${[...header, ...rows].join('\n')}\n`;
}

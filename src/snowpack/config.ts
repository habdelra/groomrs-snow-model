import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../paths.ts';
import type { ModelPoint, Resort } from '../resorts/registry.ts';
import { SMET_NODATA, stationId } from '../weather/smet.ts';

export const INI_TEMPLATE_PATH = join(
  ROOT,
  'config',
  'snowpack',
  'base.ini.tmpl',
);

export function readIniTemplate(): string {
  return readFileSync(INI_TEMPLATE_PATH, 'utf8');
}

export interface IniParams {
  station: string;
  inputDir: string;
  outputDir: string;
  // null disables profile output (past-weather runs only need the state).
  profileIntervalHours: number | null;
  // Managed-snow inputs for this run. Left out, the run is natural snow and
  // the rendered ini is exactly the template.
  managed?: ManagedIni;
}

export interface ManagedIni {
  // UTC hour (1-23) SNOWPACK grooms at on every day the run covers, or null
  // for no grooming.
  groomingHourUtc: number | null;
  // Whether the forcing carries a PSUM_TECH column.
  technicalSnow: boolean;
}

// Snow needed on the ground before a grooming pass does anything. SNOWPACK's
// default of 0.4 m would skip a thin early-season base.
export const GROOMING_DEPTH_START_M = 0.1;
// How deep a pass reaches (SNOWPACK's default).
export const GROOMING_DEPTH_IMPACT_M = 0.4;

// The managed-snow additions to the natural template. They are appended in
// code, not written into the template, so natural runs and every existing
// saved state keep the configuration they were made with.
function managedIni(ini: string, m: ManagedIni): string {
  let out = ini;
  if (m.technicalSnow) {
    // Without its own rule MeteoIO interpolates PSUM_TECH linearly between
    // hours, smearing an on-hour into its neighbours.
    out = out.replace(
      '[Interpolations1D]\n',
      '[Interpolations1D]\nPSUM_TECH::resample = nearest\nPSUM_TECH::nearest::extrapolate = true\n',
    );
  }
  if (m.groomingHourUtc !== null) {
    // The week range is set to the whole year: whether a day is groomed is
    // decided per run, by giving that day's run this section or not.
    out += [
      '',
      '[TechSnow]',
      'SNOW_GROOMING = true',
      'GROOMING_WEEK_START = 1',
      'GROOMING_WEEK_END = 53',
      `GROOMING_HOUR = ${m.groomingHourUtc}`,
      `GROOMING_DEPTH_START = ${GROOMING_DEPTH_START_M}`,
      `GROOMING_DEPTH_IMPACT = ${GROOMING_DEPTH_IMPACT_M}`,
      '',
    ].join('\n');
  }
  return out;
}

export function renderIni(template: string, p: IniParams): string {
  const values: Record<string, string> = {
    STATION: p.station,
    INPUT_DIR: p.inputDir,
    OUTPUT_DIR: p.outputDir,
    PROF_WRITE: p.profileIntervalHours === null ? 'false' : 'true',
    PROF_DAYS_BETWEEN: ((p.profileIntervalHours ?? 24) / 24).toFixed(8),
  };
  const ini = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => {
    const v = values[key];
    if (v === undefined) throw new Error(`unknown ini placeholder ${key}`);
    return v;
  });
  return p.managed ? managedIni(ini, p.managed) : ini;
}

// SMET timestamps are written without seconds' fraction or zone (tz = 0).
export function smetTime(d: Date): string {
  return d.toISOString().slice(0, 16);
}

// The initial snow file for a spin-up: bare ground, no snow or soil layers,
// at the spin-up start.
export function bareGroundSno(
  resort: Resort,
  point: ModelPoint,
  at: Date,
): string {
  return `${[
    'SMET 1.1 ASCII',
    '[HEADER]',
    `station_id       = ${stationId(point)}`,
    `station_name     = ${resort.name} ${point.id}`,
    `latitude         = ${resort.location.latitude}`,
    `longitude        = ${resort.location.longitude}`,
    `altitude         = ${point.elevationM}`,
    `nodata           = ${SMET_NODATA}`,
    'tz               = 0',
    `ProfileDate      = ${smetTime(at)}`,
    'HS_Last          = 0.0000',
    'SlopeAngle       = 0.0',
    'SlopeAzi         = 0.0',
    'nSoilLayerData   = 0',
    'nSnowLayerData   = 0',
    'SoilAlbedo       = 0.09',
    'BareSoil_z0      = 0.200',
    'CanopyHeight     = 0.00',
    'CanopyLeafAreaIndex = 0.00',
    'CanopyDirectThroughfall = 1.00',
    'WindScalingFactor = 1.00',
    'ErosionLevel     = 0',
    'TimeCountDeltaHS = 0.000000',
    'fields           = timestamp Layer_Thick  T  Vol_Frac_I  Vol_Frac_W  Vol_Frac_V  Vol_Frac_S Rho_S Conduc_S HeatCapac_S  rg  rb  dd  sp  mk mass_hoar ne CDot metamo',
    '[DATA]',
  ].join('\n')}\n`;
}

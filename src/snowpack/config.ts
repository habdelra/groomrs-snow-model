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
}

export function renderIni(template: string, p: IniParams): string {
  const values: Record<string, string> = {
    STATION: p.station,
    INPUT_DIR: p.inputDir,
    OUTPUT_DIR: p.outputDir,
    PROF_WRITE: p.profileIntervalHours === null ? 'false' : 'true',
    PROF_DAYS_BETWEEN: ((p.profileIntervalHours ?? 24) / 24).toFixed(8),
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => {
    const v = values[key];
    if (v === undefined) throw new Error(`unknown ini placeholder ${key}`);
    return v;
  });
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

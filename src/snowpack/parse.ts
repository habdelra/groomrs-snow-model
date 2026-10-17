import {
  conv,
  kelvinToC,
  metresToCm,
  metresToMm,
  fractionToPct,
} from '../units.ts';

// ---------------------------------------------------------------------------
// SMET (MeteoIO's ASCII time-series format)

export interface Smet {
  header: Record<string, string>;
  fields: string[];
  // Values in SI: SMET's units_offset/units_multiplier are applied, nodata
  // becomes null.
  rows: Array<{ time: Date; values: Array<number | null> }>;
}

export function parseSmet(text: string): Smet {
  const header: Record<string, string> = {};
  const rows: Smet['rows'] = [];
  let section = '';
  let fields: string[] = [];
  let offsets: number[] = [];
  let multipliers: number[] = [];
  let nodata = -999;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (line === '[HEADER]' || line === '[DATA]') {
      section = line;
      if (section === '[DATA]') {
        fields = (header.fields ?? '').split(/\s+/);
        const n = fields.length;
        offsets = numbers(header.units_offset, n, 0);
        multipliers = numbers(header.units_multiplier, n, 1);
        nodata = Number(header.nodata ?? '-999');
      }
      continue;
    }
    if (section === '[HEADER]') {
      const eq = line.indexOf('=');
      if (eq > 0) header[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    } else if (section === '[DATA]') {
      const cols = line.split(/\s+/);
      const ts = cols[0] ?? '';
      const time = new Date(`${ts.length === 16 ? `${ts}:00` : ts}Z`);
      const values = cols.slice(1).map((c, i) => {
        const v = Number(c);
        if (!Number.isFinite(v) || v === nodata) return null;
        return v * (multipliers[i + 1] ?? 1) + (offsets[i + 1] ?? 0);
      });
      rows.push({ time, values });
    }
  }
  return { header, fields, rows };
}

function numbers(s: string | undefined, n: number, fallback: number): number[] {
  const parts = s ? s.split(/\s+/).map(Number) : [];
  return Array.from({ length: n }, (_, i) => parts[i] ?? fallback);
}

export function smetColumn(smet: Smet, field: string): Array<number | null> {
  const i = smet.fields.indexOf(field) - 1;
  return smet.rows.map((r) => (i < 0 ? null : (r.values[i] ?? null)));
}

// ---------------------------------------------------------------------------
// SNOWPACK's hourly output time series (<station>_run.smet), mapped from SI
// to the contract's metric units.

export interface MetHour {
  time: string;
  snowDepthCm: number | null;
  sweMm: number | null;
  surfaceTempC: number | null;
  airTempC: number | null;
  relativeHumidityPct: number | null;
  windSpeedMs: number | null;
  incomingShortwaveWm2: number | null;
  reflectedShortwaveWm2: number | null;
  incomingLongwaveWm2: number | null;
  outgoingLongwaveWm2: number | null;
  sensibleHeatWm2: number | null;
  latentHeatWm2: number | null;
  groundHeatWm2: number | null;
  rainEnergyWm2: number | null;
  albedoFraction: number | null;
  liquidWaterMm: number | null;
  snowfallRateMmPerH: number | null;
  rainRateMmPerH: number | null;
  runoffMm: number | null;
  sublimationMm: number | null;
  evaporationMm: number | null;
  newSnow3hCm: number | null;
  newSnow24hCm: number | null;
  newSnow72hCm: number | null;
  precipitation24hMm: number | null;
  skierPenetrationCm: number | null;
  surfaceHoarSizeMm: number | null;
  coldContentMjM2: number | null;
}

type Field = [keyof Omit<MetHour, 'time'>, string, (n: number) => number];

const identity = (n: number) => n;

// [contract field, SNOWPACK field, SI → metric]
const MET_FIELDS: Field[] = [
  ['snowDepthCm', 'HS_mod', metresToCm],
  ['sweMm', 'SWE', identity], // kg m⁻² = mm w.e.
  ['surfaceTempC', 'TSS_mod', kelvinToC],
  ['airTempC', 'TA', kelvinToC],
  ['relativeHumidityPct', 'RH', fractionToPct],
  ['windSpeedMs', 'VW', identity],
  ['incomingShortwaveWm2', 'ISWR', identity],
  ['reflectedShortwaveWm2', 'OSWR', identity],
  ['incomingLongwaveWm2', 'ILWR', identity],
  ['outgoingLongwaveWm2', 'OLWR', identity],
  ['sensibleHeatWm2', 'Qs', identity],
  ['latentHeatWm2', 'Ql', identity],
  ['groundHeatWm2', 'Qg', identity],
  ['rainEnergyWm2', 'Qr', identity],
  ['albedoFraction', 'pAlbedo', identity],
  ['liquidWaterMm', 'MS_Water', identity],
  ['snowfallRateMmPerH', 'MS_Snow', identity],
  ['rainRateMmPerH', 'MS_Rain', identity],
  ['runoffMm', 'MS_SN_Runoff', identity],
  ['sublimationMm', 'MS_Sublimation', identity],
  ['evaporationMm', 'MS_Evap', identity],
  ['newSnow3hCm', 'HN3', metresToCm],
  ['newSnow24hCm', 'HN24', metresToCm],
  ['newSnow72hCm', 'HN72_24', metresToCm],
  ['precipitation24hMm', 'PSUM24', metresToMm], // m w.e. after SMET's multiplier
  ['skierPenetrationCm', 'ski_pen', metresToCm],
  ['surfaceHoarSizeMm', 'hoar_size', metresToMm],
  ['coldContentMjM2', 'ColdContentSnow', identity],
];

export function parseMet(text: string): MetHour[] {
  const smet = parseSmet(text);
  const columns = MET_FIELDS.map(
    ([key, field, fn]) => [key, smetColumn(smet, field), fn] as const,
  );
  return smet.rows.map((row, r) => {
    const hour = { time: row.time.toISOString() } as MetHour;
    for (const [key, col, fn] of columns) hour[key] = conv(col[r], fn);
    return hour;
  });
}

// ---------------------------------------------------------------------------
// SNOWPACK profiles (.pro). Each block starts with a `0500,<date>` line and
// lists per-element values bottom-up; layers are returned surface-first.

export interface Layer {
  // Height of the layer's top above the ground.
  topHeightCm: number;
  thicknessCm: number;
  // Depth of the layer's top below the snow surface.
  depthCm: number;
  densityKgM3: number | null;
  temperatureC: number | null;
  liquidWaterPct: number | null;
  ageDays: number | null;
  grainSizeMm: number | null;
  bondSizeMm: number | null;
  dendricity: number | null;
  sphericity: number | null;
  coordinationNumber: number | null;
  // Swiss F1F2F3 code as SNOWPACK writes it, plus the IACS classes of F1/F2.
  grainTypeCode: number | null;
  grainTypePrimary: string | null;
  grainTypeSecondary: string | null;
  handHardnessIndex: number | null;
  iceVolumePct: number | null;
  airVolumePct: number | null;
}

export interface Profile {
  time: string;
  snowDepthCm: number;
  layers: Layer[];
}

// Swiss grain code digit → IACS (Fierz et al. 2009) class, or the subclass
// for PPgp and FCxr. SNOWPACK builds the code as F1*100 + F2*10 + F3
// (ElementData::snowType in DataClasses.cc). Rounding faceted particles use 9
// (990, 951, 490 are common). Graupel is 000, though SNOWPACK 3.7.0 never sets
// it. Dry technical snow is 006 and is handled by its F3 marker below.
const GRAIN_CLASS: Record<string, string> = {
  '0': 'PPgp',
  '1': 'PP',
  '2': 'DF',
  '3': 'RG',
  '4': 'FC',
  '5': 'DH',
  '6': 'SH',
  '7': 'MF',
  '8': 'IF',
  '9': 'FCxr',
};

function parseProDate(s: string): Date {
  // DD.MM.YYYY HH:MM:SS
  const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(
    s.trim(),
  );
  if (!m) throw new Error(`unparseable .pro date ${s}`);
  return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

export function parsePro(text: string): Profile[] {
  const profiles: Profile[] = [];
  const dataStart = text.indexOf('[DATA]');
  if (dataStart < 0) return profiles;
  let block: Map<string, number[]> | null = null;
  let time: Date | null = null;
  const flush = () => {
    if (block && time) profiles.push(toProfile(time, block));
  };
  for (const line of text.slice(dataStart + 6).split('\n')) {
    if (!line) continue;
    const comma = line.indexOf(',');
    const code = line.slice(0, comma);
    if (code === '0500') {
      flush();
      time = parseProDate(line.slice(comma + 1));
      block = new Map();
      continue;
    }
    const parts = line.slice(comma + 1).split(',');
    const n = Number(parts[0]);
    block?.set(code, parts.slice(1, 1 + n).map(Number));
  }
  flush();
  return profiles;
}

function toProfile(time: Date, block: Map<string, number[]>): Profile {
  const heights = block.get('0501') ?? [];
  const at = (code: string, i: number): number | null => {
    const v = block.get(code)?.[i];
    return v === undefined || !Number.isFinite(v) || v === -999 ? null : v;
  };
  // Without soil every element is snow; heights are tops of elements (cm).
  const snowIdx = heights.map((h, i) => [h, i] as const).filter(([h]) => h > 0);
  const surface = snowIdx.length ? Math.max(...snowIdx.map(([h]) => h)) : 0;
  const layers: Layer[] = snowIdx.map(([top, i]) => {
    const below = i > 0 ? Math.max(0, heights[i - 1] ?? 0) : 0;
    const code = at('0513', i);
    const digits =
      code === null ? '' : String(Math.trunc(code)).padStart(3, '0');
    const hardness = at('0534', i);
    // F3 = 6 marks dry technical (machine-made) snow, written as 006. Once
    // wetted, SNOWPACK gives technical snow ordinary melt-form codes.
    const technical = digits[2] === '6';
    return {
      topHeightCm: round(top),
      thicknessCm: round(top - below),
      depthCm: round(surface - top),
      densityKgM3: at('0502', i),
      temperatureC: at('0503', i),
      liquidWaterPct: at('0506', i),
      ageDays: at('0505', i),
      grainSizeMm: at('0512', i),
      bondSizeMm: at('0511', i),
      dendricity: at('0508', i),
      sphericity: at('0509', i),
      coordinationNumber: at('0510', i),
      grainTypeCode: code,
      grainTypePrimary: technical
        ? 'MM'
        : (GRAIN_CLASS[digits[0] ?? ''] ?? null),
      grainTypeSecondary: technical
        ? 'MM'
        : (GRAIN_CLASS[digits[1] ?? ''] ?? null),
      // SNOWPACK writes hand hardness negated (a plotting convention).
      handHardnessIndex: hardness === null ? null : Math.abs(hardness),
      iceVolumePct: at('0515', i),
      airVolumePct: at('0516', i),
    };
  });
  layers.reverse();
  return { time: time.toISOString(), snowDepthCm: round(surface), layers };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

import { z } from 'zod';

// Version 1 of the HTTP contract Boxel's pipeline consumes. Every numeric
// field is metric and names its unit; times are ISO-8601 UTC. Additive
// changes keep v1; a rename, removal or unit change means v2.
export const SCHEMA_VERSION = 'groomrs-snow-model/v1';

const isoTime = z.string().datetime();
const n = (unit: string) => z.number().nullable().describe(unit);

export const InitializeRequest = z.object({
  idempotencyKey: z.string().min(1).max(200),
  // State is built through the start of asOf's UTC day. Defaults to now.
  asOf: isoTime.optional(),
  // Overrides the resort's spin-up length (days before typical opening).
  spinupDays: z.number().int().min(1).max(365).optional(),
});
export type InitializeRequest = z.infer<typeof InitializeRequest>;

export const RefreshRequest = z.object({
  idempotencyKey: z.string().min(1).max(200),
  asOf: isoTime.optional(),
  horizonHours: z.number().int().min(1).max(168).default(168),
  // 'managed' applies stored grooming, snowmaking and base-depth observations.
  // Left out, it is 'managed' when the resort has observations for the season
  // and 'natural' otherwise.
  scenario: z.enum(['natural', 'managed']).optional(),
  // What to assume on a night with no grooming observation: nothing, or the
  // resort's usual overnight pass. The caller knows the resort's habit.
  groomingDefault: z.enum(['none', 'nightly']).optional(),
  // 'predicted' adds the machine snow the resort is likely to make over the
  // forecast, from how much of the recent cold it used (managed runs only).
  // Left out, no snowmaking is assumed ahead of time.
  snowmakingForecast: z.enum(['none', 'predicted']).optional(),
});
export type RefreshRequest = z.infer<typeof RefreshRequest>;

// --- Observations (docs/observations.md) ---------------------------------

const skiDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const observationBase = {
  // The record's identity in Boxel. Sending the same key again with different
  // content amends it.
  key: z.string().min(1).max(200),
  // The riding day the observation applies to (resort-local date).
  skiDay,
  // The period it covers. Leave validTo out for a point in time.
  validFrom: isoTime,
  validTo: isoTime.optional(),
  observedAt: isoTime,
  source: z.enum(['webcam', 'resort-website', 'human']),
  // Where on the mountain: an elevation, or a named location. With neither,
  // the observation applies to every model point.
  elevationM: z.number().optional().describe('m'),
  location: z.enum(['base', 'mid', 'summit', 'resort']).optional(),
  note: z.string().max(2000).optional(),
};

export const GroomingObservation = z.object({
  kind: z.literal('grooming'),
  ...observationBase,
  // 'unknown' is a camera that could not tell. It is stored and never read
  // as 'not_groomed'.
  status: z.enum(['groomed', 'not_groomed', 'unknown']),
});

export const SnowmakingObservation = z.object({
  kind: z.literal('snowmaking'),
  ...observationBase,
  // 'not_observed' and 'unknown' say nothing about what happened in the dark.
  status: z.enum(['observed', 'not_observed', 'unknown']),
  positiveSamples: z.number().int().min(0).optional(),
  samples: z.number().int().min(0).optional(),
});

export const BaseDepthObservation = z
  .object({
    kind: z.literal('base_depth'),
    ...observationBase,
    // 'not_reported': the resort's report was read and carried no depth.
    // 'unavailable': the report could not be read.
    status: z.enum(['reported', 'not_reported', 'unavailable']),
    depthCm: z.number().min(0).max(2000).optional().describe('cm'),
    measuredWhere: z.string().max(200).optional(),
  })
  .refine((o) => o.status !== 'reported' || o.depthCm !== undefined, {
    message: 'a reported base depth needs depthCm',
  });

export const Observation = z.union([
  GroomingObservation,
  SnowmakingObservation,
  BaseDepthObservation,
]);
export type Observation = z.infer<typeof Observation>;
export type ObservationKind = Observation['kind'];

export const ObservationBatchRequest = z.object({
  idempotencyKey: z.string().min(1).max(200),
  // Everything observed up to this time has been sent.
  through: isoTime,
  observations: z.array(Observation).max(5000),
});
export type ObservationBatchRequest = z.infer<typeof ObservationBatchRequest>;

// What the managed chain did at one model point, returned with a result.
export const ManagedPoint = z.object({
  // Depth of the undisturbed snowpack at the same time, for comparison.
  naturalSnowDepthCm: z.number().describe('cm at the checkpoint'),
  // The first day the managed chain covers; earlier observations are stored
  // but not applied.
  appliedFrom: isoTime,
  groomedNights: z.array(
    z.object({
      time: isoTime,
      basis: z.enum(['observed', 'default']),
      observationKey: z.string().nullable(),
      source: z.string().nullable().describe('webcam or human, when observed'),
    }),
  ),
  // Grooming inside the result's own window. The first UTC day can hold a
  // pass that was observed (the window starts at 00:00 UTC, and last night's
  // grooming usually falls after that); later nights follow the default.
  forecast: z.object({
    today: z.object({
      // 'observed': a groomer was seen. 'default': assumed from the caller's
      // default. 'not_groomed': someone watched and saw none. 'none': nothing
      // is known and nothing was assumed.
      status: z.enum(['observed', 'default', 'not_groomed', 'none']),
      time: isoTime.nullable(),
      observationKey: z.string().nullable(),
      source: z.string().nullable(),
    }),
    laterNights: z.enum(['nightly', 'none']),
    // Machine snow assumed over the forecast. It is a prediction from the
    // resort's recent behaviour, never an observation.
    snowmaking: z.object({
      mode: z.enum(['none', 'predicted']),
      nights: z.array(
        z.object({
          day: skiDay.describe('UTC day'),
          hours: z.number().int(),
          from: isoTime,
          to: isoTime,
        }),
      ),
      // Share of the cold hours in the last weeks in which the resort made
      // snow; null when there were too few cold hours to tell.
      utilisation: z.number().nullable(),
      recentColdHours: z.number().int(),
      recentMachineSnowHours: z.number().int(),
      // Depth one recent machine-snow hour left on the ground. The predicted
      // hours are scaled by it; null when not known.
      depthPerHourCm: z.number().nullable(),
      reason: z.enum([
        'not_requested',
        'recent_production',
        'none_recently',
        'too_few_cold_hours',
      ]),
    }),
  }),
  technicalSnow: z.array(
    z.object({
      day: skiDay.describe('UTC day'),
      hours: z.number().int().describe('hours of machine snow added'),
      basis: z.array(z.enum(['observed', 'base_depth'])),
    }),
  ),
  baseDepth: z.array(
    z.object({
      observationKey: z.string(),
      comparedAt: isoTime,
      reportedCm: z.number().describe('cm'),
      modelledBeforeCm: z.number().describe('cm, before any correction'),
      modelledAfterCm: z.number().describe('cm, after the correction'),
      addedHours: z.number().int(),
      removedHours: z.number().int(),
      // Reported minus modelled after the correction. Not forced in.
      residualCm: z.number().describe('cm'),
      note: z.string().nullable(),
    }),
  ),
});
export type ManagedPoint = z.infer<typeof ManagedPoint>;

export const JobStatus = z.enum([
  'queued',
  'running',
  'blocked',
  'complete',
  'failed',
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const ForcingHour = z.object({
  time: isoTime,
  airTempC: n('°C'),
  relativeHumidityPct: n('%'),
  windSpeedMs: n('m/s at 10 m'),
  windDirectionDeg: n('degrees from north'),
  shortwaveWm2: n('W/m² incoming shortwave'),
  precipitationMm: n('mm in the hour'),
  rainMm: n('mm in the hour'),
  snowfallCm: n('cm of new snow in the hour (Open-Meteo)'),
  cloudCoverPct: n('%'),
  surfacePressureHpa: n('hPa'),
});

export const MetHour = z.object({
  time: isoTime,
  snowDepthCm: n('cm'),
  sweMm: n('mm water equivalent'),
  surfaceTempC: n('°C, modelled snow/ground surface'),
  airTempC: n('°C'),
  relativeHumidityPct: n('%'),
  windSpeedMs: n('m/s'),
  incomingShortwaveWm2: n('W/m²'),
  reflectedShortwaveWm2: n('W/m²'),
  incomingLongwaveWm2: n('W/m², generated by MeteoIO'),
  outgoingLongwaveWm2: n('W/m²'),
  sensibleHeatWm2: n('W/m²'),
  latentHeatWm2: n('W/m²'),
  groundHeatWm2: n('W/m²'),
  rainEnergyWm2: n('W/m²'),
  albedoFraction: n('0–1'),
  liquidWaterMm: n('mm, total liquid water in the snowpack'),
  snowfallRateMmPerH: n('mm/h water equivalent'),
  rainRateMmPerH: n('mm/h'),
  runoffMm: n('mm'),
  sublimationMm: n('mm'),
  evaporationMm: n('mm'),
  newSnow3hCm: n('cm'),
  newSnow24hCm: n('cm'),
  newSnow72hCm: n('cm'),
  precipitation24hMm: n('mm'),
  skierPenetrationCm: n('cm'),
  surfaceHoarSizeMm: n('mm'),
  coldContentMjM2: n('MJ/m²'),
});

export const Layer = z.object({
  topHeightCm: z.number().describe('cm above ground'),
  thicknessCm: z.number().describe('cm'),
  depthCm: z.number().describe('cm below the snow surface to the layer top'),
  densityKgM3: n('kg/m³'),
  temperatureC: n('°C'),
  liquidWaterPct: n('% by volume'),
  ageDays: n('days'),
  grainSizeMm: n('mm'),
  bondSizeMm: n('mm'),
  dendricity: n('0–1'),
  sphericity: n('0–1'),
  coordinationNumber: n('bonds per grain'),
  grainTypeCode: n('Swiss F1F2F3 code'),
  grainTypePrimary: z
    .string()
    .nullable()
    .describe('IACS class of F1; MM for machine-made snow (code 6)'),
  grainTypeSecondary: z.string().nullable().describe('IACS class of F2'),
  handHardnessIndex: n('1 fist … 5 knife, 6 ice'),
  iceVolumePct: n('%'),
  airVolumePct: n('%'),
});

export const Profile = z.object({
  time: isoTime,
  snowDepthCm: z.number().describe('cm'),
  layers: z.array(Layer).describe('surface first'),
});

export const DataGap = z.object({
  pointId: z.string(),
  variable: z.string(),
  missingHours: z.number().int(),
  totalHours: z.number().int(),
});

export const PointResult = z.object({
  id: z.enum(['base', 'mid', 'summit']),
  elevationM: z.number().describe('m'),
  state: z.object({
    // The spin-up this state descends from (its initialize job id).
    lineageId: z.string().uuid(),
    checkpointValidTime: isoTime,
    snowDepthCm: z.number().describe('cm at the checkpoint'),
  }),
  forcing: z.array(ForcingHour),
  met: z.array(MetHour),
  profiles: z.array(Profile),
  files: z.object({
    runId: z.string().uuid(),
    names: z.array(z.string()),
  }),
  // Present on a managed result: what was applied at this point.
  managed: ManagedPoint.optional(),
});

export const ResultDocument = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  resort: z.object({ id: z.string(), configVersion: z.string() }),
  season: z.string(),
  asOf: isoTime,
  window: z.object({ from: isoTime, to: isoTime }),
  generatedAt: isoTime,
  // 'natural' is weather only. 'managed' adds observed grooming and machine
  // snow, and each point then carries `managed`.
  scenario: z.enum(['natural', 'managed']),
  provenance: z.object({
    weatherProvider: z.literal('open-meteo'),
    weatherModel: z.string(),
    weatherRetrievedAt: isoTime,
    // 'archived' when the whole window was in the past at retrieval time
    // (a hindcast), 'forecast' when it was all in the future, else 'mixed'.
    weatherKind: z.enum(['archived', 'forecast', 'mixed']),
    snowpackVersion: z.string(),
    serviceVersion: z.string(),
    // On a managed result: the caller had sent every observation up to here.
    observationsThrough: isoTime.nullable().optional(),
    managedRulesVersion: z.string().optional(),
  }),
  points: z.array(PointResult),
  dataGaps: z.array(DataGap),
});
export type ResultDocument = z.infer<typeof ResultDocument>;
export type PointResult = z.infer<typeof PointResult>;

export function contractJsonSchema() {
  return {
    schemaVersion: SCHEMA_VERSION,
    initializeRequest: z.toJSONSchema(InitializeRequest, { io: 'input' }),
    refreshRequest: z.toJSONSchema(RefreshRequest, { io: 'input' }),
    observationBatchRequest: z.toJSONSchema(ObservationBatchRequest, {
      io: 'input',
    }),
    resultDocument: z.toJSONSchema(ResultDocument),
  };
}

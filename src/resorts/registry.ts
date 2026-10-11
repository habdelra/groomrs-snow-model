import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Hemisphere, SeasonPolicy } from '../season.ts';

const ResortConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  location: z.object({
    country: z.string().length(2),
    region: z.string(),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    timezone: z.string(),
  }),
  hemisphere: z.enum(['north', 'south']),
  elevationsM: z
    .object({ base: z.number(), summit: z.number() })
    .refine((e) => e.summit > e.base, 'summit must be above base'),
  season: z.object({
    typicalOpening: z.string().regex(/^\d{2}-\d{2}$/),
    typicalClosing: z.string().regex(/^\d{2}-\d{2}$/),
    spinupDays: z.number().int().min(1).max(365),
  }),
  weather: z.object({
    provider: z.literal('open-meteo'),
    model: z.string(),
  }),
  sources: z.array(z.string().url()).default([]),
});

export type ResortConfig = z.infer<typeof ResortConfigSchema>;

export type Band = 'base' | 'mid' | 'summit';

export interface ModelPoint {
  id: Band;
  elevationM: number;
}

export interface Resort extends ResortConfig {
  hemisphere: Hemisphere;
  season: SeasonPolicy;
  points: ModelPoint[];
  // Content hash of the config; changes whenever geometry, season policy or
  // weather model change, so results record which configuration made them.
  configVersion: string;
}

// Vertical-drop thresholds for how many SNOWPACK columns a resort gets
// (snow-carving-model-v3 §28): one point under ~300 m, base + summit up to
// ~800 m, base + mid + summit above. Starting values, not calibrated.
export const ONE_POINT_MAX_DROP_M = 300;
export const TWO_POINT_MAX_DROP_M = 800;

export function modelPoints(base: number, summit: number): ModelPoint[] {
  const drop = summit - base;
  const mid = Math.round((base + summit) / 2);
  if (drop < ONE_POINT_MAX_DROP_M) return [{ id: 'mid', elevationM: mid }];
  if (drop < TWO_POINT_MAX_DROP_M) {
    return [
      { id: 'base', elevationM: base },
      { id: 'summit', elevationM: summit },
    ];
  }
  return [
    { id: 'base', elevationM: base },
    { id: 'mid', elevationM: mid },
    { id: 'summit', elevationM: summit },
  ];
}

export function parseResort(source: string, extraVersionInput = ''): Resort {
  const config = ResortConfigSchema.parse(parseYaml(source));
  const configVersion = createHash('sha256')
    .update(JSON.stringify(config))
    .update(extraVersionInput)
    .digest('hex')
    .slice(0, 12);
  return {
    ...config,
    points: modelPoints(config.elevationsM.base, config.elevationsM.summit),
    configVersion,
  };
}

export class ResortRegistry {
  readonly #resorts = new Map<string, Resort>();

  constructor(resorts: Resort[]) {
    for (const r of resorts) {
      if (this.#resorts.has(r.id))
        throw new Error(`duplicate resort id ${r.id}`);
      this.#resorts.set(r.id, r);
    }
  }

  // `extraVersionInput` lets the caller fold the SNOWPACK ini template into
  // every resort's configVersion, since it shapes results just as much.
  static load(dir: string, extraVersionInput = ''): ResortRegistry {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.yaml'))
      .sort();
    return new ResortRegistry(
      files.map((f) => {
        const resort = parseResort(
          readFileSync(join(dir, f), 'utf8'),
          extraVersionInput,
        );
        if (`${resort.id}.yaml` !== f) {
          throw new Error(`${f}: file name must match resort id ${resort.id}`);
        }
        return resort;
      }),
    );
  }

  get(id: string): Resort | undefined {
    return this.#resorts.get(id);
  }

  all(): Resort[] {
    return [...this.#resorts.values()];
  }
}

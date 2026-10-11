// Seasons are first-class: a northern season crosses 31 December ("2025/26"),
// a southern one sits inside a calendar year ("2026").

export type Hemisphere = 'north' | 'south';

export interface SeasonPolicy {
  // Typical opening/closing as MM-DD, used to place the spin-up start.
  typicalOpening: string;
  typicalClosing: string;
  // Days of weather run from bare ground before the typical opening.
  spinupDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

// The season a date belongs to. Northern seasons turn over on 1 July,
// southern ones on 1 January.
export function seasonFor(hemisphere: Hemisphere, date: Date): string {
  const y = date.getUTCFullYear();
  if (hemisphere === 'south') return String(y);
  const start = date.getUTCMonth() >= 6 ? y : y - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, '0')}`;
}

export function isValidSeason(hemisphere: Hemisphere, season: string): boolean {
  if (hemisphere === 'south') return /^\d{4}$/.test(season);
  const m = /^(\d{4})\/(\d{2})$/.exec(season);
  return !!m && (Number(m[1]) + 1) % 100 === Number(m[2]);
}

function monthDay(md: string): [number, number] {
  const m = /^(\d{2})-(\d{2})$/.exec(md);
  if (!m) throw new Error(`expected MM-DD, got ${md}`);
  return [Number(m[1]) - 1, Number(m[2])];
}

// Typical opening day of a season, at 00:00 UTC.
export function seasonOpening(
  hemisphere: Hemisphere,
  season: string,
  policy: SeasonPolicy,
): Date {
  const startYear = Number(season.slice(0, 4));
  const [month, day] = monthDay(policy.typicalOpening);
  // A northern season opening in January–June opens in its second year.
  const year = hemisphere === 'north' && month < 6 ? startYear + 1 : startYear;
  return new Date(Date.UTC(year, month, day));
}

// Where a seasonal spin-up starts: bare ground, `spinupDays` before the
// typical opening.
export function spinupStart(
  hemisphere: Hemisphere,
  season: string,
  policy: SeasonPolicy,
): Date {
  return addDays(seasonOpening(hemisphere, season, policy), -policy.spinupDays);
}

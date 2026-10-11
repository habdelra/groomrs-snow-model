// Conversions between SNOWPACK/SMET's native SI units and the metric units the
// API contract uses. Everything in this service is metric; imperial units are
// Boxel's concern (display only).

export const ZERO_C_IN_K = 273.15;

export const kelvinToC = (k: number): number => k - ZERO_C_IN_K;
export const cToKelvin = (c: number): number => c + ZERO_C_IN_K;

export const metresToCm = (m: number): number => m * 100;
export const metresToMm = (m: number): number => m * 1000;

export const fractionToPct = (f: number): number => f * 100;
export const pctToFraction = (p: number): number => p / 100;

// Cloud cover: Open-Meteo reports percent, MeteoIO's CLD field is oktas (0–8).
export const pctToOktas = (p: number): number => (p / 100) * 8;

// Snowfall depth (cm of new snow) to water equivalent (mm), given a new-snow
// density in kg m⁻³: 1 cm = 10 mm of snow, scaled by ρ_new / ρ_water.
export const snowfallCmToMmWe = (
  cm: number,
  newSnowDensityKgM3: number,
): number => cm * 10 * (newSnowDensityKgM3 / 1000);

// Apply a nullable conversion, rounding to a fixed number of decimals so
// floating-point noise doesn't leak into the contract.
export function conv(
  value: number | null | undefined,
  fn: (n: number) => number = (n) => n,
  decimals = 3,
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value))
    return null;
  const f = 10 ** decimals;
  return Math.round(fn(value) * f) / f;
}

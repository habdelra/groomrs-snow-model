---
name: snowpack-runtime
description: How this service drives the SLF SNOWPACK model (3.7.0, with MeteoIO 2.11) — the ini template and the keys it relies on, the SMET forcing we write and its native SI units, how .smet/.pro outputs map to the metric contract (units_offset/units_multiplier traps included), grooming and technical snow (PSUM_TECH) as measured on 3.7.0, checkpoint/resume semantics, lineages and the managed chain, and how to run SNOWPACK by hand inside the container. Use when changing config/snowpack/base.ini.tmpl, src/weather/smet.ts, src/snowpack/*, checkpoint logic in src/jobs/model.ts, or when a run fails or produces odd output.
---

# SNOWPACK runtime

SNOWPACK is a native C++ CLI: `snowpack -c io.ini -e YYYY-MM-DDTHH:MM`. It reads SMET forcing plus an initial `.sno` snow file and writes an hourly `.smet` time series, a `.pro` profile file and a final `.sno` state. We install SLF's prebuilt `Snowpack-3.7.0-x86_64.deb`, which bundles MeteoIO 2.11.0.

## Install facts

- The `.deb` needs `GLIBCXX_3.4.32`, so Debian bookworm (and `node:*-bookworm`) can't run it: `version 'GLIBCXX_3.4.32' not found`. The image is `ubuntu:24.04`, with Node copied from the official image.
- Ubuntu's Docker image excludes `/usr/share/doc` from dpkg installs, so the SLF examples aren't in the container. Extract them on the host with `dpkg-deb -x Snowpack-3.7.0-x86_64.deb x` and look under `x/usr/share/doc/snowpack/examples`.
- The MeteoIO headers in the `.deb` (`x/usr/include/meteoio/...`) are the best documentation for generator and filter syntax.
- The bare `snowpack` invocation prints `Snowpack version 3.7.0 …`. `snowpackVersion()` parses that.

## The run directory

Each execution gets `DATA_DIR/runs/<runId>/`:

```text
io.ini                      rendered from config/snowpack/base.ini.tmpl
input/<POINT>.smet          forcing (station id = point id upper-cased: BASE, MID, SUMMIT)
input/<POINT>.sno           initial state (bare ground, or a copied checkpoint)
output/<POINT>_run.smet     hourly time series (EXPERIMENT = run)
output/<POINT>_run.pro      profiles (forecast runs only)
output/<POINT>_run.sno      final state → becomes a checkpoint for past-weather runs
snowpack.stdout.log / .stderr.log, weather-sources.json
```

Re-run any run by hand (paths in `io.ini` are absolute inside the container):

```sh
docker compose exec snow-model bash -c 'cd /data/runs/<runId> && snowpack -c io.ini -e 2026-02-05T00:00'
```

## Forcing (src/weather/smet.ts)

Fields are `timestamp TA RH VW DW ISWR PSUM PSUM_PH CLD`, `tz = 0` (UTC), in native SI:

| Field   | Unit            | From Open-Meteo                                                                          |
| ------- | --------------- | ---------------------------------------------------------------------------------------- |
| TA      | K               | `temperature_2m` + 273.15                                                                |
| RH      | 0–1             | `relative_humidity_2m` / 100                                                             |
| VW / DW | m/s / °         | `wind_speed_10m` (requested in m/s), `wind_direction_10m`                                |
| ISWR    | W/m²            | `shortwave_radiation`                                                                    |
| PSUM    | mm per hour     | `precipitation`                                                                          |
| PSUM_PH | 0 snow … 1 rain | `rain / (rain + snowfall_cm × ρ_new/100)`, ρ_new = 100 kg/m³; nodata when dry or unknown |
| CLD     | oktas 0–8       | `cloud_cover` % × 8 / 100                                                                |

- **ILWR** isn't provided. `ALLSKY_LW` (Unsworth) generates it from TA, RH and CLD. MeteoIO's TauCLD reads a field named `CLD` as cloud cover in oktas, and without it estimates clearness from ISWR.
- **PSUM_PH** gaps are filled by `PRECSPLITTING` (THRESH, 274.35 K). Generators only fill nodata, so our computed phase wins whenever it exists.
- **TSG** is a constant 273.15 K (snow on unfrozen ground). There is no soil model (`SNP_SOIL = false`).
- Heights: wind at 10 m, temperature and humidity at 2 m (`HEIGHT_OF_WIND_VALUE`, `HEIGHT_OF_METEO_VALUES`).

**The forcing must start before the `.sno` ProfileDate.** With data starting exactly at the ProfileDate, the first precipitation accumulation step fails and SNOWPACK logs `missing { precipitation }` / `No valid data for station`. It then **exits 0 having simulated nothing**. `runPoint` therefore fetches from one day before the start, and `runSnowpack` judges success by the output `.smet` reaching the requested end time, not by the exit code.

## Numerical stability: `ATMOSPHERIC_STABILITY`

Use `MO_MICHLMAYR`, not `MO_HOLTSLAG`. SLF's research examples use `MO_HOLTSLAG`, but they also have measured surface temperatures (`MEAS_TSS = true`). Without them, a ~1 cm early-season snowpack under very dry air diverges:

- Latent cooling pins at −250 W/m² and the modelled surface runs to −87 °C.
- SNOWPACK logs `Temperature out of bound at beginning of iteration!` / `Snowpack computation not completed` and stops partway.

The reproducer is Blue Mountain summit, initialized with `asOf 2026-02-01` and `spinupDays 5` (failed on 2025-12-01T21:00). It's now the integration test "a thin early-season snowpack under dry air runs to completion".

On that case, `MO_MICHLMAYR`, `NEUTRAL` (used in SLF's operational example) and `MO_LOG_LINEAR` all completed; Holtslag didn't.

To debug any failing run, copy its run directory, sed the paths in `io.ini` to the copy, vary one key, and rerun SNOWPACK in the image. Runs are fully reproducible from their directory.

## Outputs → contract (src/snowpack/parse.ts)

**SMET output values are not SI as written.** The header's `units_offset` and `units_multiplier` convert them: TA and TSS are written in °C with offset 273.15; HS, HN* and SWE-like depths in cm with multiplier 0.01; `PSUM24` in mm with multiplier 0.001; `hoar_size` in mm with 0.001. `parseSmet` applies offset and multiplier to get SI, and `MET_FIELDS` then converts SI to contract metric. When adding a field, check its multiplier in a real output header first: `PSUM24` was once mapped as mm and came out 1000× too small.

`plot_unit` in the header is misaligned with `fields`, so don't trust it. Use the multipliers.

**`.pro` profiles** are blocks starting `0500,DD.MM.YYYY HH:MM:SS`. Each following line is `code,nElems,v1..vn`, bottom to top:

| Code        | Meaning                                                          |
| ----------- | ---------------------------------------------------------------- |
| 0501        | element top height (cm)                                          |
| 0502        | density                                                          |
| 0503        | temperature (°C)                                                 |
| 0505        | age                                                              |
| 0506        | LWC %                                                            |
| 0508 / 0509 | dendricity / sphericity                                          |
| 0510        | coordination number                                              |
| 0511 / 0512 | bond / grain size (mm)                                           |
| 0513        | grain type, Swiss F1F2F3 code; this line has **nElems+1** values |
| 0515 / 0516 | ice / air volume %                                               |
| 0534        | hand hardness, written **negated**; we take the absolute value   |

We return layers surface-first with `depthCm` from the surface. Grain digits map to IACS: 1 PP, 2 DF, 3 RG, 4 FC, 5 DH, 6 SH, 7 MF, 8 IF, 9 PPgp.

## Grooming and technical snow (managed runs)

Natural runs use the template as it is. A managed run gets extra ini lines from `managedIni()` in `src/snowpack/config.ts` and a `PSUM_TECH` column from `toSmet()`. `docs/observations.md` explains what decides them; `src/observations/plan.ts` holds the rules and constants.

**Grooming** (`[TechSnow]`: `SNOW_GROOMING`, `GROOMING_HOUR`, `GROOMING_WEEK_START`/`END`, `GROOMING_DEPTH_START`, `GROOMING_DEPTH_IMPACT`).

- It is a fixed daily schedule, never a per-day input. To groom on chosen nights, the managed chain runs one day per execution and adds the section only on groomed days.
- It fires once, on the step that lands exactly on `GROOMING_HOUR`:00. With `TIME_ZONE = 0` that hour is UTC. Measured: `GROOMING_HOUR = 12` compacted the pack between the 12:00 and 13:00 outputs.
- A run started at 00:00 skips its first step, so hour 0 is never used: hours are clamped to 1–23.
- The week range assumes start after end (a northern season). `1` to `53` grooms all year and works for both hemispheres; that is what we write.
- `GROOMING_DEPTH_START` defaults to 0.4 m, which skips a thin base. We write 0.1.
- A pass only compacts. Measured on a 74 cm, 307 kg/m³ machine-snow pack: one pass took it to 63 cm at the same SWE. Nothing is mixed or moved.

**Technical snow** (`PSUM_TECH` in the SMET forcing).

- SNOWPACK has no snowmaking switch and no rule for when guns run. It makes snow on any step where `PSUM_TECH` is positive, at any temperature: 1 mm per step made snow at +0.5 °C. Gate warm hours yourself (`SNOWMAKING_MAX_WET_BULB_C`).
- **The value is per calculation step, and is not a water amount in practice.** Measured at a wet-bulb near −10 °C: 80 mm supplied over 40 steps added 228 mm of SWE and 74 cm of snow, a factor of about 2.8. The code adds `PSUM_TECH × 0.85 × 1000 / ρ`, where ρ is the technical-snow density, so the factor falls as it gets warmer (about 1.7 near 0 °C).
- **Too little per step is dropped, not carried over.** At −10 °C, 0.5 mm per step added almost nothing and 0.6 mm worked. Near 0 °C the threshold is above 1 mm. We write 1 mm per step on cold hours only.
- **Give it a resampling rule.** With none, MeteoIO interpolates linearly between hours, which happens to put the hourly value on every step but smears the edges. `accumulate` divides the hourly value across steps and drops it below the threshold. We write `PSUM_TECH::resample = nearest`.
- One on-hour (four steps of 1 mm) adds about 3.4 cm and 10 mm SWE at −10 °C. That is the smallest unit, so amounts are controlled in whole hours.
- 3.7.0 makes technical snow about 100 kg/m³ too light (307 kg/m³ at −10 °C). The fix is in development builds only.
- Technical-snow layers are written to `.pro` as grain code `006`, and keep it through grooming. `parse.ts` returns them as IACS class `MM`.
- It works on bare ground: Blue Mountain's summit was bare in mid-January 2026 in the natural run.

**Don't drive the model with a resort's base depth.** `ENFORCE_MEASURED_SNOW_HEIGHTS` only ever adds snow, treats it as natural snowfall, and is skipped on steps with technical snow; grooming then causes false snowfall. Inflate/deflate does not conserve mass. Base depth corrects the machine-snow hours instead.

## State, checkpoints and lineages (src/jobs/model.ts)

- **Spin-up** (`initialize`): starts from bare ground (`bareGroundSno`, zero layers) at typical opening minus `spinupDays`, and runs through 00:00 UTC of `asOf`'s day. It saves the output `.sno` as a checkpoint whose **lineage id is the initialize job id**.
- **Advance** (`refresh`): starts from the latest checkpoint at or before the target, in the lineage of the most recent completed initialize for that season and `configVersion`, and runs past weather to the target. Its checkpoint inherits the lineage.
- **Forecast**: runs from a copy of the target checkpoint and **never** saves state. Only past weather advances state, so forecast error never accumulates.
- `configVersion` hashes the resort YAML together with the ini template. Changing either orphans existing checkpoints: refresh reports `not_initialized` until the season is initialized again. That is intended, so results always match the configuration that produced them.
- A retried initialize skips points that already have a checkpoint from the same job.
- **Managed states** (`scenario = 'managed'`) are a second chain in the same lineage, one per UTC day from the spin-up state, written by `src/jobs/managed.ts`. Each has an `inputs_hash`: every day's grooming hour and machine-snow hours, chained from the spin-up checkpoint id and `MANAGED_RULES_VERSION`. The chain reuses the newest state whose hash matches today's inputs, so an amended observation re-runs from its day with no explicit invalidation. Bump `MANAGED_RULES_VERSION` when a rule changes what the same observations produce.
- Natural lookups filter `scenario = 'natural'`. Forgetting that filter would start a natural advance from a managed state.

## Performance (measured)

- About 2–3 s per point for a 3.5-month spin-up, and 8–16 s for 6 months at El Colorado.
- About 0.1–2 s for a 72–168 h forecast with 3-hourly profiles.
- A 7-day, 3-point result with full profiles is about 7 MB of JSON. `?profileDepthCm=` trims it.

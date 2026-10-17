---
name: snowpack-runtime
description: How this service drives the SLF SNOWPACK model (3.7.0, with MeteoIO 2.11) — the ini template and the keys it relies on, the SMET forcing we write and its native SI units, how .smet/.pro outputs map to the metric contract (units_offset/units_multiplier traps included), checkpoint/resume semantics and lineages, and how to run SNOWPACK by hand inside the container. Use when changing config/snowpack/base.ini.tmpl, src/weather/smet.ts, src/snowpack/*, checkpoint logic in src/jobs/model.ts, or when a run fails or produces odd output.
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

Adding or changing a `met` or layer field changes the contract clients read. Document it in `docs/api/result-document.md`, with its unit, a plain-language meaning and a source link. The same applies to changes in how refresh picks and advances checkpoints (`jobs.md`, `endpoints.md`) and to the `weather_coverage` rules in `point-run.ts` (`jobs.md`, `result-document.md`). See the `api-docs` skill.

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

We return layers surface-first with `depthCm` from the surface. Grain digits map to IACS classes, or subclasses for PPgp and FCxr: 0 PPgp (graupel), 1 PP, 2 DF, 3 RG, 4 FC, 5 DH, 6 SH, 7 MF, 8 IF, 9 FCxr (rounding faceted particles). SNOWPACK builds the code as F1·100 + F2·10 + F3 in `ElementData::snowType` (`snowpack/DataClasses.cc`).

- **9 is common.** Dry non-dendritic snow with grains of 0.7 mm or more gets `490`, `491` or `591` at sphericity 0.2–0.4, and `990` or `951` at 0.4 or above (`snowType`). Wet snow can give `791`. The mapping once had 9 as `PPgp`, which labelled most mid-winter layers as graupel. Ignore the comment in `StabilityAlgorithms.cc` saying "F1=9 does not occur in SNOWPACK"; it's out of date.
- **Graupel (`000`) never occurs in 3.7.0.** `Snowpack.cc` sets the graupel marker only when a logistic value exceeds 1, which it can't. The only other route is an input `.sno` with marker 4, and this service spins up from bare ground. Water layers are marker 19 and go through the melt-forms branch, so they aren't `000` either.
- **F3 (the last digit):** `2` is a melt-freeze crust (`772` is MFcr) and `6` is dry technical snow (`006`), which we report as the ICSSG machine-made class `MM`. On first wetting, SNOWPACK moves technical snow's marker from 6 to 16 (`Metamorphism.cc`), and the layer then gets ordinary melt-form codes. A wetted machine-made layer is therefore indistinguishable from natural snow in the grain code. SLF's docs don't define `1`, so don't describe it.
- **The 0513 line carries one value per element plus one more:** `660` when there's surface hoar on the surface, `0` when there isn't. The parser reads only the per-element values.

## State, checkpoints and lineages (src/jobs/model.ts)

- **Spin-up** (`initialize`): starts from bare ground (`bareGroundSno`, zero layers) at typical opening minus `spinupDays`, and runs through 00:00 UTC of `asOf`'s day. It saves the output `.sno` as a checkpoint whose **lineage id is the initialize job id**.
- **Advance** (`refresh`): starts from the latest checkpoint at or before the target, in the lineage of the most recent completed initialize for that season and `configVersion`, and runs past weather to the target. Its checkpoint inherits the lineage.
- **Forecast**: runs from a copy of the target checkpoint and **never** saves state. Only past weather advances state, so forecast error never accumulates.
- `configVersion` hashes the resort YAML together with the ini template. Changing either orphans existing checkpoints: refresh reports `not_initialized` until the season is initialized again. That is intended, so results always match the configuration that produced them.
- A retried initialize skips points that already have a checkpoint from the same job.

## Performance (measured)

- About 2–3 s per point for a 3.5-month spin-up, and 8–16 s for 6 months at El Colorado.
- About 0.1–2 s for a 72–168 h forecast with 3-hourly profiles.
- A 7-day, 3-point result with full profiles is about 7 MB of JSON. `?profileDepthCm=` trims it.

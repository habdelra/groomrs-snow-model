# Result document

A completed [refresh job](endpoints.md#post-v1resortsidrefresh) produces one result document. Fetch it with [`GET /v1/results/:id`](endpoints.md#get-v1resultsid) or [`GET /v1/resorts/:id/results/latest`](endpoints.md#get-v1resortsidresultslatest). Its JSON Schema is `resultDocument` in [`GET /v1/schema`](endpoints.md#get-v1schema).

All numbers are metric and name their unit (see [Units](overview.md#units)). Fields in the tables below marked "number \| null" are `null` when the source had no value.

## Shape

```json
{
  "schemaVersion": "groomrs-snow-model/v1",
  "id": "69a02752-d7e8-4eb1-b955-09e54f4c4259",
  "jobId": "05557bb1-a9b7-4971-aea4-438dfb82559d",
  "resort": { "id": "vail-co", "configVersion": "793ded04f3cd" },
  "season": "2025/26",
  "asOf": "2026-02-03T06:00:00.000Z",
  "window": {
    "from": "2026-02-03T00:00:00.000Z",
    "to": "2026-02-05T00:00:00.000Z"
  },
  "generatedAt": "2026-10-11T16:33:13.016Z",
  "scenario": "natural",
  "provenance": {
    "weatherProvider": "open-meteo",
    "weatherModel": "ecmwf_ifs025",
    "weatherRetrievedAt": "2026-10-11T16:25:57.933Z",
    "weatherKind": "archived",
    "snowpackVersion": "3.7.0",
    "serviceVersion": "0.1.0"
  },
  "points": [
    {
      "id": "base",
      "elevationM": 2475,
      "state": { "…": "…" },
      "forcing": ["…"],
      "met": ["…"],
      "profiles": ["…"],
      "files": { "…": "…" }
    }
  ],
  "dataGaps": []
}
```

## Top level

| Field                  | Type          | Description                                                                                                                                                                                                    |
| ---------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`        | string        | Always `groomrs-snow-model/v1` for this contract.                                                                                                                                                              |
| `id`                   | string (UUID) | Result id.                                                                                                                                                                                                     |
| `jobId`                | string (UUID) | The refresh job that produced it.                                                                                                                                                                              |
| `resort.id`            | string        | Resort id.                                                                                                                                                                                                     |
| `resort.configVersion` | string        | The resort [`configVersion`](overview.md#resorts-and-model-points) the result was computed with.                                                                                                               |
| `season`               | string        | Season, e.g. `2025/26` or `2026`.                                                                                                                                                                              |
| `asOf`                 | string        | The refresh's resolved `asOf`, unrounded.                                                                                                                                                                      |
| `window.from`          | string        | Start of the forecast window: midnight UTC of `asOf`'s day. Also the time of the starting state.                                                                                                               |
| `window.to`            | string        | End of the window, inclusive: `window.from` + `horizonHours`.                                                                                                                                                  |
| `generatedAt`          | string        | When the document was written.                                                                                                                                                                                 |
| `scenario`             | string        | `natural`: weather only, no grooming or machine snow. `managed`: the stored observations were applied as grooming and machine snow, and each point carries [`managed`](#managed). See [Scenarios](#scenarios). |
| `provenance`           | object        | Where the data came from. See below.                                                                                                                                                                           |
| `points`               | array         | One entry per resort model point, in the resort's point order. See [Point](#point).                                                                                                                            |
| `dataGaps`             | array         | Weather variables with missing hours. See [Data gaps](#data-gaps).                                                                                                                                             |

### `provenance`

| Field                 | Type           | Description                                                                                                                                                                                                                 |
| --------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `weatherProvider`     | string         | Always `open-meteo`.                                                                                                                                                                                                        |
| `weatherModel`        | string         | Open-Meteo model, e.g. `ecmwf_ifs025`.                                                                                                                                                                                      |
| `weatherRetrievedAt`  | string         | The oldest retrieval time of the weather used across all points.                                                                                                                                                            |
| `weatherKind`         | string         | `archived` if the whole window had passed at `weatherRetrievedAt` (a hindcast), `forecast` if all of it was in the future, `mixed` otherwise.                                                                               |
| `snowpackVersion`     | string         | SNOWPACK version used.                                                                                                                                                                                                      |
| `serviceVersion`      | string         | Version of this service.                                                                                                                                                                                                    |
| `observationsThrough` | string \| null | Managed results only (absent on natural ones). The latest `through` any observation batch for the resort stated when the result was made: you had sent everything observed up to here. `null` if the resort has no batches. |
| `managedRulesVersion` | string         | Managed results only. Names the version of the rules that turn observations into grooming and machine snow, for example `managed/1`. It changes when a rule changes what the same observations produce.                     |

### Scenarios

| `scenario` | What the snowpack is                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `natural`  | Weather only: an undisturbed, flat, open-field snow column. No grooming and no machine snow.                                                                                                           |
| `managed`  | The same weather, plus the grooming and machine snow the stored observations imply, applied day by day from the season's spin-up state. Every point's `state`, `met` and `profiles` are this snowpack. |

The refresh request picks the scenario (see [`scenario`](endpoints.md#post-v1resortsidrefresh)). Both come from the same lineage, and a managed refresh keeps the natural state current too, so `managed.naturalSnowDepthCm` matches the `state.snowDepthCm` of a natural refresh for the same `asOf`. [Observations](../observations.md) explains how observations become grooming and machine snow.

## Point

| Field        | Type   | Description                                                                      |
| ------------ | ------ | -------------------------------------------------------------------------------- |
| `id`         | string | `base`, `mid` or `summit`.                                                       |
| `elevationM` | number | Elevation of the modelled column, m.                                             |
| `state`      | object | The saved snowpack state the forecast started from.                              |
| `forcing`    | array  | Hourly weather fed to SNOWPACK. See [Forcing](#forcing-hourly-weather).          |
| `met`        | array  | SNOWPACK's hourly output. See [Met](#met-hourly-snowpack-series).                |
| `profiles`   | array  | Layer profiles every 3 hours. See [Profiles](#profiles).                         |
| `files`      | object | The forecast run's id and native files. See [`files`](#files).                   |
| `managed`    | object | Managed results only: what was applied at this point. See [`managed`](#managed). |

### `state`

| Field                 | Type          | Description                                                                                                                                       |
| --------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lineageId`           | string (UUID) | The initialize job this state descends from. See [Re-initializing](jobs.md#re-initializing-a-season).                                             |
| `checkpointValidTime` | string        | When the state is valid. Equal to `window.from`.                                                                                                  |
| `snowDepthCm`         | number        | Modelled snow depth at the checkpoint, cm. On a managed result, the managed snowpack's depth; `managed.naturalSnowDepthCm` gives the natural one. |

### Time series alignment

`forcing` and `met` hold one entry per hour from `window.from` to `window.to` **inclusive**, so a 48-hour window has 49 entries. Entries are in time order, and entries with the same index have the same `time`.

### Forcing (hourly weather)

The hourly weather from Open-Meteo, adjusted to the point's elevation by Open-Meteo's [statistical downscaling][om-ecmwf]. Each field is one of [Open-Meteo's hourly variables][om-docs], converted to the units shown. It has the same fields as [`GET /v1/resorts/:id/weather`](endpoints.md#get-v1resortsidweather) hours.

| Field                 | Type           | Unit / meaning                                                                    |
| --------------------- | -------------- | --------------------------------------------------------------------------------- |
| `time`                | string         | UTC. Instant values are at this time; sums and means cover the hour ending at it. |
| `airTempC`            | number \| null | Air temperature at 2 m, °C.                                                       |
| `relativeHumidityPct` | number \| null | Relative humidity at 2 m, %.                                                      |
| `windSpeedMs`         | number \| null | Wind speed at 10 m, m/s.                                                          |
| `windDirectionDeg`    | number \| null | Wind direction at 10 m, degrees from north.                                       |
| `shortwaveWm2`        | number \| null | Incoming shortwave radiation, mean over the preceding hour, W/m².                 |
| `precipitationMm`     | number \| null | Total precipitation over the preceding hour, mm.                                  |
| `rainMm`              | number \| null | Rain over the preceding hour, mm.                                                 |
| `snowfallCm`          | number \| null | New snow over the preceding hour as reported by Open-Meteo, cm.                   |
| `cloudCoverPct`       | number \| null | Total cloud cover, %.                                                             |
| `surfacePressureHpa`  | number \| null | Surface pressure, hPa.                                                            |

`snowfallCm` is Open-Meteo's own estimate. SNOWPACK decides the precipitation phase itself, so for modelled new snow use `met[].newSnow*Cm`.

### Met (hourly SNOWPACK series)

SNOWPACK's hourly output for the point's snow column.

| Field                   | Type           | Unit / meaning                                                                                                                                                                                    |
| ----------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `time`                  | string         | UTC. SNOWPACK writes each row at the end of its time step, so rates and sums cover the hour ending at `time`.                                                                                     |
| `snowDepthCm`           | number \| null | Modelled snow depth (vertical), cm.                                                                                                                                                               |
| `sweMm`                 | number \| null | [Snow water equivalent][icssg]: the depth of water the snowpack would give if it melted completely, mm (1 mm = 1 kg/m²).                                                                          |
| `surfaceTempC`          | number \| null | Modelled snow (or ground, when there's no snow) surface temperature, °C.                                                                                                                          |
| `airTempC`              | number \| null | Air temperature as SNOWPACK used it, after MeteoIO's gap filling, °C.                                                                                                                             |
| `relativeHumidityPct`   | number \| null | Relative humidity as SNOWPACK used it, %.                                                                                                                                                         |
| `windSpeedMs`           | number \| null | Wind speed as SNOWPACK used it, m/s.                                                                                                                                                              |
| `incomingShortwaveWm2`  | number \| null | Incoming shortwave (solar) radiation, W/m².                                                                                                                                                       |
| `reflectedShortwaveWm2` | number \| null | Shortwave radiation reflected by the surface, W/m².                                                                                                                                               |
| `incomingLongwaveWm2`   | number \| null | Incoming longwave (thermal) radiation from the atmosphere, W/m². Not in the weather data: MeteoIO [generates it][meteoio-gen] from air temperature, humidity and cloud cover.                     |
| `outgoingLongwaveWm2`   | number \| null | Longwave radiation emitted by the snow surface, W/m². Reported as a positive magnitude.                                                                                                           |
| `sensibleHeatWm2`       | number \| null | Sensible heat flux: heat exchanged between air and surface because of their temperature difference, W/m². **Positive means toward the snow surface** (warm air heating the snow).                 |
| `latentHeatWm2`         | number \| null | Latent heat flux: energy exchanged through sublimation, evaporation and deposition at the surface, W/m². Same sign convention as `sensibleHeatWm2`.                                               |
| `groundHeatWm2`         | number \| null | Heat flux from the ground into the base of the snowpack, W/m². Always `0` with the current configuration, which models the snow column without soil.                                              |
| `rainEnergyWm2`         | number \| null | Heat brought to the surface by rain, W/m².                                                                                                                                                        |
| `albedoFraction`        | number \| null | Surface albedo: the fraction of incoming shortwave radiation that is reflected, 0–1. Fresh snow is around 0.9; old, wet snow is much lower.                                                       |
| `liquidWaterMm`         | number \| null | Total [liquid water][icssg] held in the snowpack, mm.                                                                                                                                             |
| `snowfallRateMmPerH`    | number \| null | Solid precipitation reaching the surface, mm/h water equivalent.                                                                                                                                  |
| `rainRateMmPerH`        | number \| null | Liquid precipitation, mm/h.                                                                                                                                                                       |
| `runoffMm`              | number \| null | Meltwater and rain draining out of the base of the snowpack, mm.                                                                                                                                  |
| `sublimationMm`         | number \| null | Mass lost by sublimation (ice turning directly to vapour), mm water equivalent.                                                                                                                   |
| `evaporationMm`         | number \| null | Mass lost by evaporation of liquid water, mm.                                                                                                                                                     |
| `newSnow3hCm`           | number \| null | Modelled height of new snow over the past 3 hours, cm.                                                                                                                                            |
| `newSnow24hCm`          | number \| null | Modelled height of new snow over the past 24 hours, cm.                                                                                                                                           |
| `newSnow72hCm`          | number \| null | Modelled height of new snow over the past 72 hours, cm.                                                                                                                                           |
| `precipitation24hMm`    | number \| null | Precipitation (all phases) over the past 24 hours, mm.                                                                                                                                            |
| `skierPenetrationCm`    | number \| null | SNOWPACK's estimate of how far a skier sinks into the snow, cm. Deeper means softer, less consolidated snow near the surface.                                                                     |
| `surfaceHoarSizeMm`     | number \| null | Size of [surface hoar][icssg] crystals on the surface, mm. Surface hoar is feathery frost that grows on the snow on clear, calm nights. `0` when there is none.                                   |
| `coldContentMjM2`       | number \| null | [Cold content][icssg]: the energy needed to warm the whole snowpack to 0 °C, MJ/m². SNOWPACK reports it as a **negative** number; values near 0 mean the snowpack is close to melting throughout. |

The column names follow SNOWPACK's [fluxes time series][sp-met]. The energy-balance and microstructure model behind them is described in [Bartelt and Lehning (2002)][lehning-1] and [Lehning et al. (2002)][lehning-2].

### Profiles

Snapshots of the full layer stack, from SNOWPACK's [`.pro` profile output][sp-pro], every **3 hours** from `window.from`, so a 48-hour window has 17 profiles. The last profile is at `window.to` only when `horizonHours` is a multiple of 3. Otherwise it is the last 3-hour step before `window.to`.

| Field         | Type   | Description                                                  |
| ------------- | ------ | ------------------------------------------------------------ |
| `time`        | string | UTC.                                                         |
| `snowDepthCm` | number | Total snow depth at that time, cm.                           |
| `layers`      | array  | Snow layers, **surface first**. Empty when there is no snow. |

If you requested `profileDepthCm`, `layers` only holds layers whose top is within that depth of the surface. `snowDepthCm` still gives the full depth.

#### Layer

Each layer is one SNOWPACK element. Layers are often well under 1 cm thick near the surface.

```json
{
  "topHeightCm": 30.27,
  "thicknessCm": 0.55,
  "depthCm": 0,
  "densityKgM3": 57.4,
  "temperatureC": -5.55,
  "liquidWaterPct": 0,
  "ageDays": 2.38,
  "grainSizeMm": 1.54,
  "bondSizeMm": 0.12,
  "dendricity": 0.2,
  "sphericity": 0.18,
  "coordinationNumber": 1,
  "grainTypeCode": 240,
  "grainTypePrimary": "DF",
  "grainTypeSecondary": "FC",
  "handHardnessIndex": 1,
  "iceVolumePct": 6,
  "airVolumePct": 94
}
```

| Field                | Type           | Unit / meaning                                                                                                                                                                                                                                                          |
| -------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `topHeightCm`        | number         | Height of the layer's top above the ground, cm.                                                                                                                                                                                                                         |
| `thicknessCm`        | number         | Layer thickness, cm.                                                                                                                                                                                                                                                    |
| `depthCm`            | number         | Depth of the layer's top below the snow surface, cm. `0` for the surface layer.                                                                                                                                                                                         |
| `densityKgM3`        | number \| null | [Density][icssg], kg/m³. New snow is typically 50–150; settled and wind-packed snow 200–400; melt-refrozen snow and ice higher still.                                                                                                                                   |
| `temperatureC`       | number \| null | Snow temperature, °C. `0` means the layer is at the melting point and may hold liquid water.                                                                                                                                                                            |
| `liquidWaterPct`     | number \| null | [Liquid water content][icssg], % by volume. `0` is dry snow.                                                                                                                                                                                                            |
| `ageDays`            | number \| null | Time since the layer's snow fell, days.                                                                                                                                                                                                                                 |
| `grainSizeMm`        | number \| null | [Grain size][icssg]: the average size of the snow grains, mm.                                                                                                                                                                                                           |
| `bondSizeMm`         | number \| null | Size of the ice bonds (necks) between grains, mm. Larger bonds mean a stronger, more sintered layer ([Lehning et al. 2002][lehning-2]).                                                                                                                                 |
| `dendricity`         | number \| null | How much of the original branched crystal shape remains, from 0 (none) to 1 (new snow) ([SNOWPACK][sp-element]).                                                                                                                                                        |
| `sphericity`         | number \| null | Grain shape, from 0 (angular, faceted) to 1 (rounded) ([SNOWPACK][sp-element]).                                                                                                                                                                                         |
| `coordinationNumber` | number \| null | Average number of bonds each grain has with its neighbours ([Lehning et al. 2002][lehning-2]).                                                                                                                                                                          |
| `grainTypeCode`      | number \| null | SNOWPACK's [Swiss three-digit grain code][sp-io] F1F2F3: F1·100 + F2·10 + F3. F1 is the primary grain type and F2 the secondary. F3 is a marker: `2` means a melt-freeze crust (so `772` is MFcr) and `6` dry technical snow. SLF doesn't document the other F3 values. |
| `grainTypePrimary`   | string \| null | [ICSSG][icssg] grain shape class of the primary grain type (F1), or its subclass for PPgp and FCxr. See the table below.                                                                                                                                                |
| `grainTypeSecondary` | string \| null | The same, for the secondary grain type (F2).                                                                                                                                                                                                                            |
| `handHardnessIndex`  | number \| null | [Hand hardness index][icssg], from the object that can be pushed into the snow with moderate force: 1 fist, 2 four fingers, 3 one finger, 4 pencil, 5 knife, 6 ice (nothing gets in).                                                                                   |
| `iceVolumePct`       | number \| null | Share of the layer's volume that is ice, %.                                                                                                                                                                                                                             |
| `airVolumePct`       | number \| null | Share of the layer's volume that is air (pore space), %.                                                                                                                                                                                                                |

Grain types follow [The International Classification for Seasonal Snow on the Ground][icssg] (ICSSG; Fierz et al. 2009), mapped from the digits of SNOWPACK's [Swiss code][sp-io]:

| Code digit | Value  | Meaning                                                                                                                 |
| ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| 1          | `PP`   | Precipitation particles                                                                                                 |
| 2          | `DF`   | Decomposing and fragmented precipitation particles                                                                      |
| 3          | `RG`   | Rounded grains                                                                                                          |
| 4          | `FC`   | Faceted crystals                                                                                                        |
| 5          | `DH`   | Depth hoar                                                                                                              |
| 6          | `SH`   | Surface hoar                                                                                                            |
| 7          | `MF`   | Melt forms                                                                                                              |
| 8          | `IF`   | Ice formations                                                                                                          |
| 9          | `FCxr` | Rounding faceted particles, a subclass of FC. Common in mid-winter: `990`, `951`, `490`, `491`.                         |
| 0          | `PPgp` | Graupel, a subclass of PP. SNOWPACK writes graupel as `000`, but the SNOWPACK version in use (3.7.0) never produces it. |

If F3 is `6` (dry technical snow, which SNOWPACK writes as `006`, so `grainTypeCode` is `6`), both values are `MM`, ICSSG's machine-made snow class. Machine-made layers appear only in managed results. Once technical snow has been wetted, SNOWPACK gives it ordinary melt-form codes, so its grain code no longer distinguishes it from natural snow. In the Blue Mountain example below, the summit's first profile (20 February, 00:00) holds 74 `MM` layers, while the base, whose machine snow had been rained on, holds none: all of it reads `770` (`MF`). Use [`managed.technicalSnow`](#technicalsnow) to know machine snow was added, not the grain code.

Examples:

- `240` is primary `DF`, secondary `FC`.
- `491` is `FC`, `FCxr`.
- `772` is `MF`, `MF`, with F3 = 2: a melt-freeze crust.
- `6` (written `006`) is `MM`, `MM`: dry machine-made snow.

Clients that group by the main ICSSG class can take the first two letters of the value (`FCxr` → `FC`, `PPgp` → `PP`).

### `files`

| Field   | Type          | Description                                                                                                                                         |
| ------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runId` | string (UUID) | The point's forecast run. On a managed result, the run for the window's first UTC day only; see [run files](endpoints.md#get-v1runsrunidfilespath). |
| `names` | string[]      | Paths of its native files, downloadable from [`GET /v1/runs/:runId/files/*path`](endpoints.md#get-v1runsrunidfilespath).                            |

### `managed`

Present on every point of a managed result, absent on a natural one. It says what the managed snowpack was given at this point and why. It reports inputs and their sources; it doesn't judge the result.

Example: Blue Mountain's summit, a managed refresh for 20 February 2026 with `snowmakingForecast: "predicted"` (job `3eb2ecd0-…`, result `42d0d4c8-…`, from the live stack; long arrays snipped):

```json
"managed": {
  "naturalSnowDepthCm": 20.13,
  "appliedFrom": "2026-02-01T00:00:00.000Z",
  "groomedNights": [
    {
      "time": "2026-02-19T10:00:00.000Z",
      "basis": "observed",
      "observationKey": "eval/grooming/bm-summit/2026-02-19",
      "source": "webcam"
    }
  ],
  "technicalSnow": [
    { "day": "2026-02-01", "hours": 1, "basis": ["base_depth"] },
    "…",
    { "day": "2026-02-09", "hours": 14, "basis": ["base_depth", "observed"] },
    "…",
    { "day": "2026-02-15", "hours": 3, "basis": ["observed"] },
    "…"
  ],
  "baseDepth": [
    {
      "observationKey": "eval/base_depth/resort/2026-02-08",
      "comparedAt": "2026-02-09T00:00:00.000Z",
      "reportedCm": 61,
      "modelledBeforeCm": 23.4,
      "modelledAfterCm": 36.8,
      "addedHours": 24,
      "removedHours": 0,
      "residualCm": 24.2,
      "note": null
    },
    {
      "observationKey": "eval/base_depth/resort/2026-02-09",
      "comparedAt": "2026-02-10T00:00:00.000Z",
      "reportedCm": 66,
      "modelledBeforeCm": 37.8,
      "modelledAfterCm": 50.5,
      "addedHours": 11,
      "removedHours": 0,
      "residualCm": 15.5,
      "note": "ran out of hours cold enough to make snow"
    },
    "…"
  ],
  "forecast": {
    "today": {
      "status": "observed",
      "time": "2026-02-20T10:00:00.000Z",
      "observationKey": "eval/grooming/bm-summit/2026-02-20",
      "source": "webcam"
    },
    "laterNights": "none",
    "snowmaking": {
      "mode": "predicted",
      "nights": [],
      "utilisation": 0.19,
      "recentColdHours": 250,
      "recentMachineSnowHours": 48,
      "depthPerHourCm": 1.08,
      "reason": "recent_production"
    }
  }
}
```

The summit's `state.snowDepthCm` in the same result is 72.0 cm, against 20.1 cm natural.

| Field                | Type   | Description                                                                                                                                                                                                                                                                                                         |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `naturalSnowDepthCm` | number | Depth of the natural snowpack at the same checkpoint (`window.from`), cm. The difference from `state.snowDepthCm` is roughly how much of the pack is made, though grooming also compacts it.                                                                                                                        |
| `appliedFrom`        | string | Where the managed snowpack starts: the time of the season's spin-up state (the `asOf` day of the [initialize](endpoints.md#post-v1resortsidseasonsseasoninitialize) job that started the lineage). Observations before it are stored but not applied. To apply a longer history, initialize with an earlier `asOf`. |
| `groomedNights`      | array  | Grooming passes applied before the window, oldest first. See below.                                                                                                                                                                                                                                                 |
| `technicalSnow`      | array  | Machine snow added before the window, per UTC day. See below.                                                                                                                                                                                                                                                       |
| `baseDepth`          | array  | How each base-depth reading was answered. See below.                                                                                                                                                                                                                                                                |
| `forecast`           | object | Grooming and machine snow assumed inside the window. See below.                                                                                                                                                                                                                                                     |

#### `groomedNights`

One entry per UTC day between `appliedFrom` and `window.from` on which the managed snowpack was groomed. A day is groomed when a `groomed` observation's `validFrom` falls in it, or, with `groomingDefault: "nightly"`, when it has no `groomed` or `not_groomed` observation.

| Field            | Type           | Description                                                                                                                                                                  |
| ---------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `time`           | string         | When the pass was applied: the first whole hour at or after the day's last `groomed` sighting, or 04:00 resort time for an assumed pass. Always between 01:00 and 23:00 UTC. |
| `basis`          | string         | `observed`: from a `groomed` observation. `default`: assumed from `groomingDefault: "nightly"`.                                                                              |
| `observationKey` | string \| null | The `key` of the observation behind it; `null` for an assumed pass.                                                                                                          |
| `source`         | string \| null | Who saw it, the observation's `source` (`webcam` or `human`); `null` for an assumed pass.                                                                                    |

A pass is SNOWPACK's [grooming module][sp-techsnow]: it densifies the snow within 40 cm of the surface. It needs at least 10 cm of snow, and it doesn't add or move snow.

#### `technicalSnow`

One entry per UTC day before the window that got machine snow, oldest first. Machine snow goes into SNOWPACK's technical-snow input ([`PSUM_TECH`][sp-techsnow]), so SNOWPACK builds the layers with the density it gives machine snow. It is only ever placed on hours whose [wet-bulb temperature][wet-bulb] is −2.5 °C or colder. Wet-bulb temperature combines air temperature and humidity (it is the temperature evaporation can cool to), and it is what decides whether snow guns can run; the service computes it from the forcing's `airTempC` and `relativeHumidityPct`.

| Field   | Type     | Description                                                                                                                                   |
| ------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `day`   | string   | UTC day, `YYYY-MM-DD`.                                                                                                                        |
| `hours` | integer  | Hours of machine snow added that day, at most 14. One cold hour adds about 3 cm.                                                              |
| `basis` | string[] | Why, sorted: `observed` (inside the window of an `observed` snowmaking sighting) and/or `base_depth` (added to explain a base-depth reading). |

#### `baseDepth`

One entry per `reported` base-depth reading that applies to this point and falls after `appliedFrom`, in the order they were worked through. The service never overwrites the snowpack with the resort's figure. It reads the gap as machine snow the model hasn't accounted for, and adds (or removes) whole hours of machine snow over the 14 days before the reading to close half of it. Gaps of 5 cm or less are left alone. See [Observations: base depth](../observations.md#base-depth).

| Field              | Type           | Description                                                                                                                                                                                                                                                                   |
| ------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observationKey`   | string         | The reading's `key`.                                                                                                                                                                                                                                                          |
| `comparedAt`       | string         | When modelled and reported depth were compared: the end of the UTC day the reading's `validFrom` falls in, or `window.from` if that day isn't over by then.                                                                                                                   |
| `reportedCm`       | number         | The resort's figure, cm.                                                                                                                                                                                                                                                      |
| `modelledBeforeCm` | number         | Managed depth at `comparedAt` before this reading was answered, cm (one decimal).                                                                                                                                                                                             |
| `modelledAfterCm`  | number         | Managed depth at `comparedAt` after the correction, cm. Equal to `modelledBeforeCm` when nothing was changed.                                                                                                                                                                 |
| `addedHours`       | integer        | Hours of machine snow added to answer this reading.                                                                                                                                                                                                                           |
| `removedHours`     | integer        | Hours of machine snow taken back, when the model was deeper than the report. Only machine snow is ever removed, so the pack never drops below what the weather left.                                                                                                          |
| `residualCm`       | number         | `reportedCm` − `modelledAfterCm`, cm: the gap left. Positive means the resort reports more snow than the model holds. It is reported, never forced in.                                                                                                                        |
| `note`             | string \| null | Why the correction fell short, when it did: `no hours cold enough to make snow in the window`, `ran out of hours cold enough to make snow`, `no machine snow in the window to take back` or `ran out of machine snow to take back`. `null` otherwise. Its wording may change. |

Each reading is answered after the ones before it, so `modelledBeforeCm` already includes the earlier corrections and any snow or melt since.

#### `forecast`

What the managed forecast assumed inside the window. These are assumptions (except `today` when its `status` is `observed` or `not_groomed`), so present them as expected, never as seen.

The window starts at 00:00 UTC, so in most time zones last night's grooming falls inside it. The forecast's first UTC day therefore runs on its own, with whatever was observed for it, and the rest of the window runs on from where it ended. `met` and `profiles` join the two into one series.

| Field         | Type   | Description                                                                                                                |
| ------------- | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| `today`       | object | Grooming on the window's first UTC day.                                                                                    |
| `laterNights` | string | Grooming on the remaining nights: `nightly` (a pass at 04:00 resort time each day) or `none`. It echoes `groomingDefault`. |
| `snowmaking`  | object | Machine snow assumed over the whole window.                                                                                |

`forecast.today`:

| Field            | Type           | Description                                                                                                                                                                                                         |
| ---------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`         | string         | `observed`: a groomer was seen that day. `default`: a pass is assumed from `groomingDefault: "nightly"`. `not_groomed`: someone watched and saw none, so no pass. `none`: nothing was observed and nothing assumed. |
| `time`           | string \| null | When the pass is applied (same rule as `groomedNights[].time`); `null` for `not_groomed` and `none`.                                                                                                                |
| `observationKey` | string \| null | The observation behind `observed`; `null` otherwise.                                                                                                                                                                |
| `source`         | string \| null | `webcam` or `human` for `observed`; `null` otherwise.                                                                                                                                                               |

`forecast.snowmaking` is a prediction from the resort's own recent record, made only when the refresh asked for `snowmakingForecast: "predicted"`. Over the 14 days before `window.from` it counts the hours cold enough to make snow and the hours the managed snowpack holds machine snow; their ratio, capped at 0.6, is the share of cold hours the resort used. On each forecast day that share of the day's cold hours (coldest first, at most 14) gets machine snow, scaled down by how much depth a recent machine-snow hour actually left against the 3 cm a cold hour makes. Only the forecast copy holds predicted snow; the saved state never does.

| Field                    | Type           | Description                                                                                                                                                                                                                                                |
| ------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`                   | string         | `predicted` when the refresh asked for it, else `none`.                                                                                                                                                                                                    |
| `nights`                 | array          | One entry per UTC day of the window with predicted machine snow. Empty when nothing was predicted, including when `reason` is `recent_production` but the forecast has no cold hours.                                                                      |
| `nights[].day`           | string         | UTC day, `YYYY-MM-DD`.                                                                                                                                                                                                                                     |
| `nights[].hours`         | integer        | Hours of machine snow that day. They need not be consecutive.                                                                                                                                                                                              |
| `nights[].from`          | string         | The first of those hours.                                                                                                                                                                                                                                  |
| `nights[].to`            | string         | The last of those hours.                                                                                                                                                                                                                                   |
| `utilisation`            | number \| null | Share of recent cold hours the resort made snow in, 0–0.6, two decimals. `0` for `none_recently`; `null` when not requested or for `too_few_cold_hours`.                                                                                                   |
| `recentColdHours`        | integer        | Hours in the 14 days before the window with a wet-bulb of −2.5 °C or colder. `0` when not requested.                                                                                                                                                       |
| `recentMachineSnowHours` | integer        | Hours in those 14 days that got machine snow (from `technicalSnow`). `0` when not requested.                                                                                                                                                               |
| `depthPerHourCm`         | number \| null | Managed minus natural depth at `window.from`, divided by `recentMachineSnowHours`, cm. The predicted hours are scaled by it. `null` when there were no recent machine-snow hours or it wasn't requested.                                                   |
| `reason`                 | string         | `not_requested`: `snowmakingForecast` was `none`. `recent_production`: predicted from recent use. `none_recently`: no machine snow in the last 14 days, so none is predicted. `too_few_cold_hours`: under 12 cold hours to judge by, so none is predicted. |

A resort with no snowmaking or base-depth observations therefore never gets predicted machine snow. With `groomingDefault: "nightly"` and a forecast that has cold hours, the block looks like this (Blue Mountain's base, refresh for 10 February 2026 on the live stack):

```json
"forecast": {
  "today": {
    "status": "default",
    "time": "2026-02-10T09:00:00.000Z",
    "observationKey": null,
    "source": null
  },
  "laterNights": "nightly",
  "snowmaking": {
    "mode": "predicted",
    "nights": [
      {
        "day": "2026-02-10",
        "hours": 1,
        "from": "2026-02-10T06:00:00.000Z",
        "to": "2026-02-10T06:00:00.000Z"
      }
    ],
    "utilisation": 0.12,
    "recentColdHours": 216,
    "recentMachineSnowHours": 26,
    "depthPerHourCm": 1.21,
    "reason": "recent_production"
  }
}
```

## Data gaps

`dataGaps` lists, per point, every forcing variable that had at least one missing (`null`) hour in the window. It is empty when the weather was complete.

```json
[
  {
    "pointId": "summit",
    "variable": "cloudCoverPct",
    "missingHours": 3,
    "totalHours": 49
  }
]
```

| Field          | Type    | Description                                     |
| -------------- | ------- | ----------------------------------------------- |
| `pointId`      | string  | Point the gap is at.                            |
| `variable`     | string  | Name of the `forcing` field with missing hours. |
| `missingHours` | integer | Hours with no value.                            |
| `totalHours`   | integer | Hours in the window.                            |

`dataGaps` covers the forecast window only. Small gaps are tolerated: SNOWPACK's MeteoIO fills them. If more than 10% of hours are missing for air temperature, humidity, wind speed, shortwave radiation or precipitation, the job is `blocked` with `weather_coverage` instead of producing a result. That check also applies to the advance from the checkpoint, so a refresh can be blocked by a gap that would never show up in `dataGaps`.

[icssg]: https://cryosphericsciences.org/publications/snow-classification/ 'Fierz et al. (2009), The International Classification for Seasonal Snow on the Ground, UNESCO-IHP'
[sp-io]: https://snowpack.slf.ch/doc-release/html/snowpackio.html 'SNOWPACK data formats'
[sp-met]: https://snowpack.slf.ch/doc-release/html/met_format.html 'SNOWPACK fluxes time series'
[sp-pro]: https://snowpack.slf.ch/doc-release/html/pro_format.html 'SNOWPACK PRO profiles time series'
[sp-element]: https://snowpack.slf.ch/doc-release/html/classElementData.html 'SNOWPACK ElementData: per-layer properties'
[meteoio-gen]: https://meteoio.slf.ch/doc-release/html/generators.html 'MeteoIO data generators'
[lehning-1]: https://doi.org/10.1016/S0165-232X%2802%2900074-5 'Bartelt and Lehning (2002), A physical SNOWPACK model for the Swiss avalanche warning, Part I: numerical model'
[lehning-2]: https://doi.org/10.1016/S0165-232X%2802%2900073-3 'Lehning et al. (2002), A physical SNOWPACK model for the Swiss avalanche warning, Part II: snow microstructure'
[om-docs]: https://open-meteo.com/en/docs 'Open-Meteo weather forecast API: hourly variables'
[om-ecmwf]: https://open-meteo.com/en/docs/ecmwf-api 'Open-Meteo ECMWF API'
[sp-techsnow]: https://snowpack.slf.ch/doc-release/html/technical_snow.html 'SNOWPACK: Technical snow (grooming and snow production)'
[wet-bulb]: https://en.wikipedia.org/wiki/Wet-bulb_temperature 'Wet-bulb temperature'

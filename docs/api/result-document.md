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

| Field                  | Type          | Description                                                                                            |
| ---------------------- | ------------- | ------------------------------------------------------------------------------------------------------ |
| `schemaVersion`        | string        | Always `groomrs-snow-model/v1` for this contract.                                                      |
| `id`                   | string (UUID) | Result id.                                                                                             |
| `jobId`                | string (UUID) | The refresh job that produced it.                                                                      |
| `resort.id`            | string        | Resort id.                                                                                             |
| `resort.configVersion` | string        | The resort [`configVersion`](overview.md#resorts-and-model-points) the result was computed with.       |
| `season`               | string        | Season, e.g. `2025/26` or `2026`.                                                                      |
| `asOf`                 | string        | The refresh's resolved `asOf`, unrounded.                                                              |
| `window.from`          | string        | Start of the forecast window: midnight UTC of `asOf`'s day. Also the time of the starting state.       |
| `window.to`            | string        | End of the window, inclusive: `window.from` + `horizonHours`.                                          |
| `generatedAt`          | string        | When the document was written.                                                                         |
| `scenario`             | string        | Always `natural` in Stage 1: natural snow, no snowmaking or grooming. Other values may be added later. |
| `provenance`           | object        | Where the data came from. See below.                                                                   |
| `points`               | array         | One entry per resort model point, in the resort's point order. See [Point](#point).                    |
| `dataGaps`             | array         | Weather variables with missing hours. See [Data gaps](#data-gaps).                                     |

### `provenance`

| Field                | Type   | Description                                                                                                                                   |
| -------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `weatherProvider`    | string | Always `open-meteo`.                                                                                                                          |
| `weatherModel`       | string | Open-Meteo model, e.g. `ecmwf_ifs025`.                                                                                                        |
| `weatherRetrievedAt` | string | The oldest retrieval time of the weather used across all points.                                                                              |
| `weatherKind`        | string | `archived` if the whole window had passed at `weatherRetrievedAt` (a hindcast), `forecast` if all of it was in the future, `mixed` otherwise. |
| `snowpackVersion`    | string | SNOWPACK version used.                                                                                                                        |
| `serviceVersion`     | string | Version of this service.                                                                                                                      |

## Point

| Field        | Type   | Description                                                             |
| ------------ | ------ | ----------------------------------------------------------------------- |
| `id`         | string | `base`, `mid` or `summit`.                                              |
| `elevationM` | number | Elevation of the modelled column, m.                                    |
| `state`      | object | The saved snowpack state the forecast started from.                     |
| `forcing`    | array  | Hourly weather fed to SNOWPACK. See [Forcing](#forcing-hourly-weather). |
| `met`        | array  | SNOWPACK's hourly output. See [Met](#met-hourly-snowpack-series).       |
| `profiles`   | array  | Layer profiles every 3 hours. See [Profiles](#profiles).                |
| `files`      | object | The forecast run's id and native files. See [`files`](#files).          |

### `state`

| Field                 | Type          | Description                                                                                           |
| --------------------- | ------------- | ----------------------------------------------------------------------------------------------------- |
| `lineageId`           | string (UUID) | The initialize job this state descends from. See [Re-initializing](jobs.md#re-initializing-a-season). |
| `checkpointValidTime` | string        | When the state is valid. Equal to `window.from`.                                                      |
| `snowDepthCm`         | number        | Modelled snow depth at the checkpoint, cm.                                                            |

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

| Field                | Type           | Unit / meaning                                                                                                                                                                                                                                                      |
| -------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `topHeightCm`        | number         | Height of the layer's top above the ground, cm.                                                                                                                                                                                                                     |
| `thicknessCm`        | number         | Layer thickness, cm.                                                                                                                                                                                                                                                |
| `depthCm`            | number         | Depth of the layer's top below the snow surface, cm. `0` for the surface layer.                                                                                                                                                                                     |
| `densityKgM3`        | number \| null | [Density][icssg], kg/m³. New snow is typically 50–150; settled and wind-packed snow 200–400; melt-refrozen snow and ice higher still.                                                                                                                               |
| `temperatureC`       | number \| null | Snow temperature, °C. `0` means the layer is at the melting point and may hold liquid water.                                                                                                                                                                        |
| `liquidWaterPct`     | number \| null | [Liquid water content][icssg], % by volume. `0` is dry snow.                                                                                                                                                                                                        |
| `ageDays`            | number \| null | Time since the layer's snow fell, days.                                                                                                                                                                                                                             |
| `grainSizeMm`        | number \| null | [Grain size][icssg]: the average size of the snow grains, mm.                                                                                                                                                                                                       |
| `bondSizeMm`         | number \| null | Size of the ice bonds (necks) between grains, mm. Larger bonds mean a stronger, more sintered layer ([Lehning et al. 2002][lehning-2]).                                                                                                                             |
| `dendricity`         | number \| null | How much of the original branched crystal shape remains, from 0 (none) to 1 (new snow) ([SNOWPACK][sp-element]).                                                                                                                                                    |
| `sphericity`         | number \| null | Grain shape, from 0 (angular, faceted) to 1 (rounded) ([SNOWPACK][sp-element]).                                                                                                                                                                                     |
| `coordinationNumber` | number \| null | Average number of bonds each grain has with its neighbours ([Lehning et al. 2002][lehning-2]).                                                                                                                                                                      |
| `grainTypeCode`      | number \| null | SNOWPACK's [Swiss three-digit grain code][sp-io] F1F2F3: F1·100 + F2·10 + F3. F1 is the primary grain type and F2 the secondary. F3 is a marker: `2` means a melt-freeze crust (so `772` is MFcr) and `6` technical snow. SLF doesn't document the other F3 values. |
| `grainTypePrimary`   | string \| null | [ICSSG][icssg] grain shape class of the primary grain type (F1), or its subclass for PPgp and FCxr. See the table below.                                                                                                                                            |
| `grainTypeSecondary` | string \| null | The same, for the secondary grain type (F2).                                                                                                                                                                                                                        |
| `handHardnessIndex`  | number \| null | [Hand hardness index][icssg], from the object that can be pushed into the snow with moderate force: 1 fist, 2 four fingers, 3 one finger, 4 pencil, 5 knife, 6 ice (nothing gets in).                                                                               |
| `iceVolumePct`       | number \| null | Share of the layer's volume that is ice, %.                                                                                                                                                                                                                         |
| `airVolumePct`       | number \| null | Share of the layer's volume that is air (pore space), %.                                                                                                                                                                                                            |

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
| 9          | `FCxr` | Rounding faceted particles, a subclass of FC. Common in mid-winter: `990`, `951`, `491`.                                |
| 0          | `PPgp` | Graupel, a subclass of PP. SNOWPACK writes graupel as `000`, but the SNOWPACK version in use (3.7.0) never produces it. |

If F3 is `6` (code `006`, technical snow), both values are `MM`, ICSSG's machine-made snow class. That can't happen while results model natural snow only (`scenario: "natural"`).

Examples:

- `240` is primary `DF`, secondary `FC`.
- `491` is `FC`, `FCxr`.
- `772` is `MF`, `MF`, with F3 = 2: a melt-freeze crust.

Clients that group by the main ICSSG class can take the first two letters of the value (`FCxr` → `FC`, `PPgp` → `PP`).

> **Results generated before the grain-type fix ([#5](https://github.com/habdelra/groomrs-snow-model/pull/5))** labelled digit 9 as `PPgp` and digit 0 as `null`. Those documents stay on disk unchanged, and their `configVersion` and `schemaVersion` are the same as newer ones. If you keep old results, derive the class from `grainTypeCode` and the table above rather than from `grainTypePrimary`/`grainTypeSecondary`.

### `files`

| Field   | Type          | Description                                                                                                              |
| ------- | ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `runId` | string (UUID) | The point's forecast run.                                                                                                |
| `names` | string[]      | Paths of its native files, downloadable from [`GET /v1/runs/:runId/files/*path`](endpoints.md#get-v1runsrunidfilespath). |

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
